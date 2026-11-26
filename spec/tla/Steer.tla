------------------------------ MODULE Steer ------------------------------
(***************************************************************************)
(* Steering (R5.10): `job.send(message)` while a job runs, the job's inbox *)
(* in the sandbox, the driver beside the CLI, and each CLI's protocol.      *)
(* Code at d7c34b7:                                                         *)
(*                                                                         *)
(* src/job.ts run() (334-452): `messages` (the task first), `inbox`,       *)
(*   `ended`, `write(n)` (341-348: n.json then n.ok, chained on `writing`, *)
(*   a failure swallowed by .catch(() => {})), `send()` (445-450: false    *)
(*   when `ended`, else push, and write when the inbox exists), the setup  *)
(*   of the inbox (387 inbox, 389 await the driver's file, 390 unshift the *)
(*   task, 391 await write(i) for each message), and the event loop        *)
(*   (399-416): for each `end` event, `messages.length > reader.taken`     *)
(*   gives a `turn` event, else the job ends (ended = true, then `end` in  *)
(*   the inbox). stream() (494-526): the reader reads each line of the     *)
(*   driver's output as it comes (onStdout), and queues its events, while  *)
(*   the app reads the events one at a time with `for await`.              *)
(* src/harness/driver.ts: the inbox poll (33-41) reads each n.ok in order, *)
(*   then `end`, every 200 ms.                                             *)
(* src/harness/claude.ts: the driver writes each message to Claude Code's  *)
(*   stdin (116-119); Claude Code takes the messages that wait when a turn *)
(*   ends, echoes them (one echo, one text block each), runs one turn, and *)
(*   gives a `result`; the reader counts the blocks of each echo (80).     *)
(* src/harness/codex.ts: the driver (127-155) sends turn/start, or         *)
(*   turn/steer with the running turn's id, and turn/start when the steer  *)
(*   fails; `turn` from turn/started, the start's answer and turn/completed*)
(*   The reader counts each userMessage item (85) and ends a turn at       *)
(*   turn/completed (106).                                                 *)
(* src/harness/grok.ts: the driver (148-177) sends session/prompt (and     *)
(*   prints {byoa:'taken'}) when no turn runs and no interjection waits,   *)
(*   else _x.ai/interject; `running`, `interjecting`; an error answer to a *)
(*   prompt while `running` fails the job (174). The reader counts `taken` *)
(*   and each _x.ai/session/interjection (109, 114), and ends a turn at    *)
(*   turn_completed (115).                                                 *)
(*                                                                         *)
(* The CLIs' own behavior is the CLI's; the model lets each do what its    *)
(* protocol allows, as nondeterministic choices:                           *)
(* - Claude Code takes any number of the messages that wait (one echo).    *)
(* - Codex takes a turn/steer into the turn it names while that turn runs  *)
(*   (a userMessage item before turn/completed), and refuses it with an    *)
(*   error once the turn completed; CodexDrop: it acks a steer and then    *)
(*   completes the turn without it (a broken CLI, to show what follows).   *)
(*   It answers turn/start before turn/started.                            *)
(* - Grok takes an interjection into the running turn at a next step, or,  *)
(*   when the turn ended first, runs a turn of its own for it; it sends    *)
(*   _x.ai/session/interjection when it takes it (GrokQueueNote: when it   *)
(*   queues it, a guess that the code does not take). A turn may fail      *)
(*   (TurnsFail); then Grok answers its session/prompt with an error after *)
(*   turn_completed, as the stand-in for 1.0.92 does. A prompt that comes  *)
(*   while a turn runs is refused with an error and no turn.               *)
(*                                                                         *)
(* The fixes: TakenAtPush (job.ts): an end event keeps the reader's count  *)
(* from when the reader read it. GrokFix (grok.ts): a prompt's error       *)
(* answer fails the job only when no turn_completed came since the prompt. *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(* - The model stops when the job decides to end (job.ts 408, 417, the     *)
(*   catch): what follows (await writing, the `end` file, the driver's     *)
(*   close, EXIT_WAIT_MS and stopJob, conversation finish, close) ends in  *)
(*   bounded time and no longer changes which messages the app saw         *)
(*   answered. The CLI has then taken every message (taken >= messages),   *)
(*   so the driver has read every n.ok before `end`; a failed `end` write  *)
(*   is ended by stream()'s finally after EXIT_WAIT_MS.                    *)
(* - Only `end` events are modeled; JHandle is the app's next(), which may *)
(*   lag any number of lines behind the reader (an app that stores each    *)
(*   event first). `await cred.event(ev)` (400) is merged into JHandle: a  *)
(*   send that runs in that await only makes messages.length larger, and   *)
(*   lines 404-408 are synchronous.                                        *)
(* - send() is one step: lines 446-448 up to the await are synchronous.    *)
(*   It returns true once its write ended, also when the write failed, so  *)
(*   "send returned true" is the push.                                     *)
(* - A write's content is read when its .then callback starts: at once     *)
(*   when the chain is idle, else in the microtasks right after the write  *)
(*   before it ends, so with no I/O callback (and no unshift) between: the *)
(*   model reads it when the write becomes the chain's head. n.json and    *)
(*   n.ok are one step each; the driver reads n.json only after n.ok.      *)
(* - The driver's poll reads one n.ok per step, at any time (the 200 ms    *)
(*   timer); its end check is left out with the rest after the end.        *)
(* - Codex's initialize and thread/start, and Grok's session/new, are      *)
(*   done when the driver starts (messages wait in the driver's chain).    *)
(* - The readers count only this job's messages: Claude Code echoes only   *)
(*   what came on its stdin, and Codex's thread/resume and Grok's          *)
(*   session/resume give no userMessage item or interjection for the       *)
(*   session's earlier messages (assumed, not checked here).               *)
(* - An end from reader.exit() or the driver's failed line is an end event *)
(*   like a turn's: job.ts 404 does not tell them apart, so with a message *)
(*   still to come it gives a `turn` event too (an error end follows).     *)
(* - The driver and the CLI live and die together (cli.on('exit') exits    *)
(*   the driver; a driver that dies closes the CLI's stdin). The job       *)
(*   timeout (stream's timeoutMs = jobTimeoutMs) ends both at any time     *)
(*   (TimeoutOn); output not yet read by the driver is lost then.          *)
(* - A CLI that crashes, a usage limit, the backend's own death (its app's *)
(*   `for await` dies with it; JobTiming.tla has the sandbox's timer) are  *)
(*   left out.                                                             *)
(*                                                                         *)
(* What TLC finds:                                                         *)
(* - Steer_main_*: the reader reads the driver's output while the app is   *)
(*   on earlier events (and lines of one chunk all at once), so when the   *)
(*   job handles the first turn's end, reader.taken may already count the  *)
(*   message that the next turn took: the job ends with the first turn's   *)
(*   answer, and the next turn's answer is lost. Fixed by TakenAtPush.     *)
(* - Steer_main_grok_fail: a failed Grok turn's error answer to its prompt *)
(*   comes after turn_completed; when the next turn (a new prompt, or      *)
(*   Grok's own turn for an interjection) runs by then, the driver fails   *)
(*   the job. Fixed by GrokFix.                                            *)
(* - Steer_writefail: a failed inbox write is swallowed: send() says true, *)
(*   the CLI never gets that message (nor any later one: the driver reads  *)
(*   n.ok in order), and only the job timeout ends the job, with           *)
(*   { type: 'end', ok: false } and no error. Steer_writefail_inbox: a     *)
(*   send during the write of the driver's file writes the inbox at the    *)
(*   index it had before the task; when the loop's write of that index     *)
(*   fails, the CLI gets that message instead of the task. Open.           *)
(* - Steer_codex_drop, Steer_grok_queue: what a CLI that breaks the        *)
(*   protocol the drivers assume does: the job waits until its timeout, or *)
(*   ends before the turn that answers the last message.                   *)
(***************************************************************************)
EXTENDS Integers, Sequences

CONSTANTS
  Protocol,       \* "claude", "codex" or "grok"
  Sends,          \* how many messages the app sends with job.send (the task is message 0)
  TakenAtPush,    \* the fix in job.ts: the count of taken messages from when the reader read the end
  WriteFail,      \* a sandbox writeFile may fail (job.ts write() swallows it)
  TimeoutOn,      \* the job timeout may end the driver and the CLI
  TimeoutFair,    \* and it does, when they run long enough
  CodexDrop,      \* Codex acks a turn/steer and completes the turn without it (a broken CLI)
  GrokQueueNote,  \* Grok sends _x.ai/session/interjection when it queues the message, not when it takes it
  TurnsFail,      \* a Grok turn may fail: an error answer to its session/prompt after turn_completed
  GrokFix         \* the fix in grok.ts: that answer does not fail the job

ASSUME Protocol \in {"claude", "codex", "grok"} /\ Sends \in Nat

Msgs == 0..Sends
Slots == 0..(Sends + 1)
NONE == -1
BAD == -2   \* a file that a failed write left half written

\* one line of output (CLI to driver, driver to backend), and one request (driver to CLI)
Rec(k, n, up, id) == [k |-> k, n |-> n, up |-> up, id |-> id]
Tk(n) == Rec("tk", n, NONE, 0)        \* the reader counts n more taken messages
EndR(up) == Rec("end", 0, up, 0)      \* a turn ended; it answered the messages up to `up`
Exit == Rec("exit", 0, NONE, 0)       \* the command ended (sandbox.run resolved)
Failed == Rec("failed", 0, NONE, 0)   \* the driver's {"byoa":"failed"} line
Req(k, m, id) == [k |-> k, m |-> m, id |-> id]

VARIABLES
  nm,      \* messages.length, with the task: send() accepted nm - 1 messages
  jpc,     \* the job: open (no inbox), drvjs (job.ts 387-389), loop/loopw (391), start, run, done
  li,      \* the loop's i (391)
  jw,      \* the write the loop awaits
  jend,    \* the end the job yields: the last message its turn answered, or an error end
  tmax,    \* the last message that a `turn` event answered
  wq,      \* the `writing` chain: [n: file index, c: its content, read when it is the head]
  wph,     \* the head's step: json or ok
  wtot, wdone,
  fj, fo,  \* the inbox: n.json's content (a message, NONE or BAD), and whether n.ok is there
  d2b,     \* the driver's stdout, not yet read by the backend
  rtk,     \* reader.taken
  rended,  \* the reader's `ended`: its exit() gives no end event
  eq,      \* the events that the reader queued and the app has not read (end events only)
  sdone,   \* the command ended
  cst,     \* the driver and CLI: wait (not started), run, dead
  dn,      \* the driver's next inbox file
  dq,      \* the driver's chain of messages to say (codex, grok)
  dsay,    \* the say that waits for its answer: none, start, steer (codex), inter (grok)
  dmsg,    \* the message of that say
  dturn,   \* codex driver: `turn` (0: none)
  drun, dinter, \* grok driver: `running`, `interjecting`
  dfail,   \* the driver called fail()
  wrong,   \* the driver gave the CLI another message than the one of that index
  cin,     \* claude: its stdin
  d2c,     \* codex, grok: the driver's requests, not yet read
  c2d,     \* codex, grok: the CLI's output, not yet read by the driver
  cact,    \* the CLI's running turn: 0 none; claude and grok 1; codex its id
  cid,     \* codex: the last turn id
  cpend,   \* codex: steers it acked and has not taken; grok: interjections it has not taken
  ctk,     \* how many messages the CLI took
  cprompt, \* grok: the running turn came from a session/prompt
  badstart \* codex got turn/start while a turn ran

vars == <<nm, jpc, li, jw, jend, tmax, wq, wph, wtot, wdone, fj, fo, d2b, rtk, rended, eq, sdone,
          cst, dn, dq, dsay, dmsg, dturn, drun, dinter, dfail, wrong, cin, d2c, c2d, cact, cid, cpend, ctk, cprompt, badstart>>
jobv == <<nm, jpc, li, jw, jend, tmax>>
wrv == <<wq, wph, wtot, wdone, fj, fo>>
rdv == <<d2b, rtk, rended, eq, sdone>>
drvv == <<dn, dq, dsay, dmsg, dturn, drun, dinter, dfail, wrong>>
cliv == <<cst, cin, d2c, c2d, cact, cid, cpend, ctk, cprompt, badstart>>

Init ==
  /\ nm = 1 /\ jpc = "open" /\ li = 0 /\ jw = 0 /\ jend = [up |-> NONE, err |-> FALSE] /\ tmax = NONE
  /\ wq = <<>> /\ wph = "json" /\ wtot = 0 /\ wdone = 0
  /\ fj = [n \in Slots |-> NONE] /\ fo = [n \in Slots |-> FALSE]
  /\ d2b = <<>> /\ rtk = 0 /\ rended = FALSE /\ eq = <<>> /\ sdone = FALSE
  /\ cst = "wait" /\ dn = 0 /\ dq = <<>> /\ dsay = "none" /\ dmsg = NONE /\ dturn = 0
  /\ drun = FALSE /\ dinter = 0 /\ dfail = FALSE /\ wrong = FALSE
  /\ cin = <<>> /\ d2c = <<>> /\ c2d = <<>> /\ cact = 0 /\ cid = 0 /\ cpend = <<>> /\ ctk = 0
  /\ cprompt = FALSE /\ badstart = FALSE

Live == jpc # "done"
Running == cst = "run" /\ Live

(***************************************************************************)
(* The backend: send(), write(), the job's setup and its event loop.       *)
(***************************************************************************)

\* job.ts 390: the task is message 0 from the unshift on; before it, messages[n] is the app's message n + 1
Unshifted == jpc \notin {"open", "drvjs"}
Content(n) == IF Unshifted THEN n ELSE n + 1
\* job.ts 343-344: the .then callback reads messages[n] when the write before it has ended (or at once)
Head1(q) == IF q # <<>> /\ q[1].c = NONE THEN [q EXCEPT ![1].c = Content(q[1].n)] ELSE q
Enq(n) == wq' = Head1(Append(wq, [n |-> n, c |-> NONE])) /\ wtot' = wtot + 1

\* job.ts 445-450 send(): false when ended; else push, and write(messages.length - 1) when the inbox exists (387)
Send ==
  /\ Live /\ nm <= Sends
  /\ nm' = nm + 1
  /\ IF jpc = "open" THEN UNCHANGED <<wq, wtot>> ELSE Enq(IF Unshifted THEN nm ELSE nm - 1)
  /\ UNCHANGED <<jpc, li, jw, jend, tmax, wph, wdone, fj, fo>> /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 344: writeFile(n.json); a failure leaves the file as it was, or half written, and skips n.ok (346 catch)
WJson ==
  /\ Live /\ wq # <<>> /\ wph = "json"
  /\ LET h == Head(wq) IN
       \/ /\ fj' = [fj EXCEPT ![h.n] = h.c] /\ wph' = "ok" /\ UNCHANGED <<wq, wdone>>
       \/ /\ WriteFail
          /\ fj' \in {fj, [fj EXCEPT ![h.n] = BAD]}
          /\ wq' = Head1(Tail(wq)) /\ wdone' = wdone + 1 /\ UNCHANGED wph
  /\ UNCHANGED <<wtot, fo>> /\ UNCHANGED jobv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 345: writeFile(n.ok), which may fail too
WOk ==
  /\ Live /\ wq # <<>> /\ wph = "ok"
  /\ \/ fo' = [fo EXCEPT ![Head(wq).n] = TRUE]
     \/ WriteFail /\ UNCHANGED fo
  /\ wq' = Head1(Tail(wq)) /\ wph' = "json" /\ wdone' = wdone + 1
  /\ UNCHANGED <<wtot, fj>> /\ UNCHANGED jobv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 387: the inbox is set; 389: await writeFile(the driver)
JOpen ==
  /\ jpc = "open" /\ jpc' = "drvjs"
  /\ UNCHANGED <<nm, li, jw, jend, tmax>> /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 389 ends: 390 unshift(task), 391 the loop; or the driver's file was not written: the job fails (434)
JDrv ==
  /\ jpc = "drvjs"
  /\ \/ jpc' = "loop" /\ li' = 0 /\ UNCHANGED jend
     \/ WriteFail /\ jpc' = "done" /\ jend' = [up |-> NONE, err |-> TRUE] /\ UNCHANGED li
  /\ UNCHANGED <<nm, jw, tmax>> /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 391: for (i = 0; i < messages.length; i++) await write(i)
JLoop ==
  /\ jpc = "loop"
  /\ IF li < nm
     THEN Enq(li) /\ jw' = wtot + 1 /\ jpc' = "loopw"
     ELSE jpc' = "start" /\ UNCHANGED <<wq, wtot, jw>>
  /\ UNCHANGED <<nm, li, jend, tmax, wph, wdone, fj, fo>> /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv
JLoopW ==
  /\ jpc = "loopw" /\ wdone >= jw /\ li' = li + 1 /\ jpc' = "loop"
  /\ UNCHANGED <<nm, jw, jend, tmax>> /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 397-399: `start`, and when the app reads past it, stream() runs the driver
JStart ==
  /\ jpc = "start" /\ jpc' = "run" /\ cst' = "run"
  /\ UNCHANGED <<nm, li, jw, jend, tmax>> /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv
  /\ UNCHANGED <<cin, d2c, c2d, cact, cid, cpend, ctk, cprompt, badstart>>

\* job.ts 399-412: the app reads the next event. An end: a message is still to come (404) gives a `turn`; else the
\* job ends (408). The code reads reader.taken now; the fix, the count from when the reader read this end.
JHandle ==
  /\ jpc = "run" /\ eq # <<>>
  /\ LET e == Head(eq)
         t == IF TakenAtPush THEN e.tag ELSE rtk
     IN /\ eq' = Tail(eq)
        /\ IF nm > t
           THEN tmax' = (IF e.up > tmax THEN e.up ELSE tmax) /\ UNCHANGED <<jpc, jend>>
           ELSE jpc' = "done" /\ jend' = [up |-> e.up, err |-> e.err] /\ UNCHANGED tmax
  /\ UNCHANGED <<nm, li, jw>> /\ UNCHANGED wrv /\ UNCHANGED <<d2b, rtk, rended, sdone>> /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 416-417, 438: the command ended with no end event left: the job ends with { type: 'end', ok: false }
JStreamDone ==
  /\ jpc = "run" /\ eq = <<>> /\ sdone
  /\ jpc' = "done" /\ jend' = [up |-> NONE, err |-> TRUE]
  /\ UNCHANGED <<nm, li, jw, tmax>> /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED cliv

\* job.ts 498-506 stream(): onStdout, line by line, reader.line(); at the command's end, reader.exit()
RLine ==
  /\ Live /\ d2b # <<>>
  /\ LET r == Head(d2b) IN
     /\ d2b' = Tail(d2b)
     /\ CASE r.k = "tk" -> rtk' = rtk + r.n /\ rended' = FALSE /\ UNCHANGED <<eq, sdone>>
          [] r.k = "tstart" -> rended' = FALSE /\ UNCHANGED <<rtk, eq, sdone>>
          [] r.k = "end" -> rended' = TRUE /\ eq' = Append(eq, [up |-> r.up, tag |-> rtk, err |-> FALSE]) /\ UNCHANGED <<rtk, sdone>>
          [] r.k = "failed" -> rended' = TRUE /\ eq' = Append(eq, [up |-> NONE, tag |-> rtk, err |-> TRUE]) /\ UNCHANGED <<rtk, sdone>>
          [] r.k = "exit" -> /\ sdone' = TRUE /\ UNCHANGED <<rtk, rended>>
                             /\ eq' = IF rended THEN eq ELSE Append(eq, [up |-> NONE, tag |-> rtk, err |-> TRUE])
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED drvv /\ UNCHANGED cliv

(***************************************************************************)
(* The driver in the sandbox.                                              *)
(***************************************************************************)

\* driver.ts 36: while n.ok is there, give the CLI JSON.parse(n.json); a half-written file throws in the timer, and
\* the driver dies (the CLI with it)
DPoll ==
  /\ Running /\ fo[dn]
  /\ LET c == fj[dn] IN
     /\ dn' = dn + 1
     /\ wrong' = (wrong \/ c # dn)
     /\ IF c = BAD
        THEN cst' = "dead" /\ d2b' = Append(d2b, Exit) /\ UNCHANGED <<cin, dq>>
        ELSE /\ UNCHANGED <<cst, d2b>>
             /\ IF Protocol = "claude" THEN cin' = Append(cin, c) /\ UNCHANGED dq    \* claude.ts 118
                ELSE dq' = Append(dq, c) /\ UNCHANGED cin                         \* codex.ts 154, grok.ts 176
  /\ UNCHANGED <<dsay, dmsg, dturn, drun, dinter, dfail>> /\ UNCHANGED jobv /\ UNCHANGED wrv
  /\ UNCHANGED <<rtk, rended, eq, sdone>> /\ UNCHANGED <<d2c, c2d, cact, cid, cpend, ctk, cprompt, badstart>>

\* codex.ts 146-153 say(), grok.ts 168-175 say(): the chain runs one say at a time
DSay ==
  /\ Running /\ Protocol # "claude" /\ dsay = "none" /\ dq # <<>>
  /\ LET m == Head(dq) IN
     /\ dq' = Tail(dq) /\ dmsg' = m
     /\ IF Protocol = "codex"
        THEN /\ IF dturn # 0
                THEN d2c' = Append(d2c, Req("steer", m, dturn)) /\ dsay' = "steer"
                ELSE d2c' = Append(d2c, Req("start", m, 0)) /\ dsay' = "start"
             /\ UNCHANGED <<drun, dinter, d2b>>
        ELSE IF drun \/ dinter > 0
             THEN /\ dinter' = dinter + 1 /\ d2c' = Append(d2c, Req("inter", m, 0)) /\ dsay' = "inter"
                  /\ UNCHANGED <<drun, d2b>>
             \* session/prompt is not awaited: the chain goes on
             ELSE /\ drun' = TRUE /\ d2b' = Append(d2b, Tk(1)) /\ d2c' = Append(d2c, Req("prompt", m, 0))
                  /\ UNCHANGED <<dsay, dinter>>
  /\ UNCHANGED <<dn, dturn, dfail, wrong>> /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>>
  /\ UNCHANGED <<cst, cin, c2d, cact, cid, cpend, ctk, cprompt, badstart>>

\* codex.ts 129-134 and driver.ts 47-55: one line of the app server, its answer to a call or a notification
DLineCodex ==
  /\ Running /\ Protocol = "codex" /\ c2d # <<>>
  /\ LET r == Head(c2d) IN
     /\ c2d' = Tail(c2d)
     /\ CASE r.k = "sok" -> dturn' = r.id /\ dsay' = "none" /\ UNCHANGED <<d2c, d2b>>                       \* 152
          [] r.k = "ack" -> dsay' = "none" /\ UNCHANGED <<dturn, d2c, d2b>>                                \* 149
          [] r.k = "err" -> d2c' = Append(d2c, Req("start", dmsg, 0)) /\ dsay' = "start" /\ UNCHANGED <<dturn, d2b>> \* 150-152
          [] r.k = "tstart" -> dturn' = r.id /\ d2b' = Append(d2b, r) /\ UNCHANGED <<dsay, d2c>>            \* 131
          [] r.k = "um" -> d2b' = Append(d2b, Tk(1)) /\ UNCHANGED <<dturn, dsay, d2c>>
          [] r.k = "done" -> dturn' = 0 /\ d2b' = Append(d2b, EndR(r.up)) /\ UNCHANGED <<dsay, d2c>>        \* 132
  /\ UNCHANGED <<dn, dq, dmsg, drun, dinter, dfail, wrong>> /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>>
  /\ UNCHANGED <<cst, cin, cact, cid, cpend, ctk, cprompt, badstart>>

\* grok.ts 150-160: one line of Grok; 174: an error answer to a prompt while `running` fails the job (fail(),
\* driver.ts 64: the failed line, then the CLI is killed)
GrokFails(r) == r.k = "prej" \/ (r.k = "perr" /\ drun /\ ~GrokFix)
DLineGrok ==
  /\ Running /\ Protocol = "grok" /\ c2d # <<>>
  /\ LET r == Head(c2d) IN
     IF GrokFails(r)
     THEN /\ dfail' = TRUE /\ cst' = "dead" /\ d2b' = d2b \o <<Failed, Exit>> /\ c2d' = <<>> /\ d2c' = <<>>
          /\ UNCHANGED <<dsay, drun, dinter>>
     ELSE /\ c2d' = Tail(c2d) /\ UNCHANGED <<dfail, cst, d2c>>
          /\ CASE r.k = "iack" -> dsay' = "none" /\ UNCHANGED <<drun, dinter, d2b>>
               [] r.k = "inote" -> dinter' = dinter - 1 /\ drun' = TRUE /\ d2b' = Append(d2b, Tk(1)) /\ UNCHANGED dsay
               [] r.k = "tdone" -> drun' = FALSE /\ d2b' = Append(d2b, EndR(r.up)) /\ UNCHANGED <<dsay, dinter>>
               [] r.k = "perr" -> UNCHANGED <<dsay, drun, dinter, d2b>>
  /\ UNCHANGED <<dn, dq, dmsg, dturn, wrong>> /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>>
  /\ UNCHANGED <<cin, cact, cid, cpend, ctk, cprompt, badstart>>

(***************************************************************************)
(* The CLIs.                                                               *)
(***************************************************************************)

\* Claude Code: when no turn runs, it takes the messages that wait (one echo), and runs a turn for them
CTake ==
  /\ Running /\ Protocol = "claude" /\ cact = 0 /\ cin # <<>>
  /\ \E k \in 1..Len(cin) :
       /\ cin' = SubSeq(cin, k + 1, Len(cin)) /\ ctk' = ctk + k /\ cact' = 1 /\ d2b' = Append(d2b, Tk(k))
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>> /\ UNCHANGED drvv
  /\ UNCHANGED <<cst, d2c, c2d, cid, cpend, cprompt, badstart>>
\* its `result`
CEnd ==
  /\ Running /\ Protocol = "claude" /\ cact = 1
  /\ cact' = 0 /\ d2b' = Append(d2b, EndR(ctk - 1))
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>> /\ UNCHANGED drvv
  /\ UNCHANGED <<cst, cin, d2c, c2d, cid, cpend, ctk, cprompt, badstart>>

\* Codex and Grok read the driver's next request
CReq ==
  /\ Running /\ Protocol # "claude" /\ d2c # <<>>
  /\ LET r == Head(d2c) IN
     /\ d2c' = Tail(d2c)
     /\ CASE r.k = "start" ->
               /\ badstart' = (badstart \/ cact # 0) /\ cid' = cid + 1 /\ cact' = cid + 1 /\ ctk' = ctk + 1
               /\ c2d' = c2d \o <<Rec("sok", 0, NONE, cid + 1), Rec("tstart", 0, NONE, cid + 1), Rec("um", 0, NONE, 0)>>
               /\ UNCHANGED <<cpend, cprompt>>
          [] r.k = "steer" ->
               /\ IF cact # 0 /\ cact = r.id
                  THEN cpend' = Append(cpend, r.m) /\ c2d' = Append(c2d, Rec("ack", 0, NONE, 0))
                  ELSE c2d' = Append(c2d, Rec("err", 0, NONE, 0)) /\ UNCHANGED cpend
               /\ UNCHANGED <<badstart, cid, cact, ctk, cprompt>>
          [] r.k = "prompt" ->
               /\ IF cact = 0
                  THEN cact' = 1 /\ cprompt' = TRUE /\ ctk' = ctk + 1 /\ UNCHANGED c2d
                  ELSE c2d' = Append(c2d, Rec("prej", 0, NONE, 0)) /\ UNCHANGED <<cact, cprompt, ctk>>
               /\ UNCHANGED <<badstart, cid, cpend>>
          [] r.k = "inter" ->
               /\ cpend' = Append(cpend, r.m)
               /\ c2d' = c2d \o <<Rec("iack", 0, NONE, 0)>> \o (IF GrokQueueNote THEN <<Rec("inote", 0, NONE, 0)>> ELSE <<>>)
               /\ UNCHANGED <<badstart, cid, cact, ctk, cprompt>>
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED <<cst, cin>>

\* Codex takes a steered message into its turn (a userMessage item)
CSteerTake ==
  /\ Running /\ Protocol = "codex" /\ cact # 0 /\ cpend # <<>>
  /\ cpend' = Tail(cpend) /\ ctk' = ctk + 1 /\ c2d' = Append(c2d, Rec("um", 0, NONE, 0))
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv
  /\ UNCHANGED <<cst, cin, d2c, cact, cid, cprompt, badstart>>
\* turn/completed (with CodexDrop, also while it holds steers it acked)
CDone ==
  /\ Running /\ Protocol = "codex" /\ cact # 0 /\ (cpend = <<>> \/ CodexDrop)
  /\ cact' = 0 /\ cpend' = <<>> /\ c2d' = Append(c2d, Rec("done", 0, ctk - 1, cact))
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv
  /\ UNCHANGED <<cst, cin, d2c, cid, ctk, cprompt, badstart>>

\* Grok takes an interjection at the running turn's next step, or runs a turn for it when no turn runs
CTakeQ ==
  /\ Running /\ Protocol = "grok" /\ cpend # <<>>
  /\ cpend' = Tail(cpend) /\ ctk' = ctk + 1
  /\ IF cact = 0 THEN cact' = 1 /\ cprompt' = FALSE ELSE UNCHANGED <<cact, cprompt>>
  /\ c2d' = IF GrokQueueNote THEN c2d ELSE Append(c2d, Rec("inote", 0, NONE, 0))
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED <<cst, cin, d2c, cid, badstart>>
\* turn_completed; a failed turn of a prompt: then its error answer
CDoneG ==
  /\ Running /\ Protocol = "grok" /\ cact # 0
  /\ \E ok \in (IF TurnsFail THEN BOOLEAN ELSE {TRUE}) :
       c2d' = c2d \o <<Rec("tdone", 0, ctk - 1, 0)>> \o (IF ~ok /\ cprompt THEN <<Rec("perr", 0, NONE, 0)>> ELSE <<>>)
  /\ cact' = 0
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED rdv /\ UNCHANGED drvv /\ UNCHANGED <<cst, cin, d2c, cid, cpend, ctk, cprompt, badstart>>

\* stream()'s timeoutMs (the job timeout) ends the command: the driver and the CLI
Timeout ==
  /\ TimeoutOn /\ Running
  /\ cst' = "dead" /\ d2b' = Append(d2b, Exit) /\ c2d' = <<>> /\ d2c' = <<>>
  /\ UNCHANGED jobv /\ UNCHANGED wrv /\ UNCHANGED <<rtk, rended, eq, sdone>> /\ UNCHANGED drvv
  /\ UNCHANGED <<cin, cact, cid, cpend, ctk, cprompt, badstart>>

Next ==
  \/ Send
  \/ JOpen \/ JDrv \/ JLoop \/ JLoopW \/ JStart \/ JHandle \/ JStreamDone
  \/ WJson \/ WOk \/ RLine
  \/ DPoll \/ DSay \/ DLineCodex \/ DLineGrok
  \/ CTake \/ CEnd \/ CReq \/ CSteerTake \/ CDone \/ CTakeQ \/ CDoneG
  \/ Timeout

(***************************************************************************)
(* Fairness. Weak fairness on every step but send() and the timeout: the   *)
(* backend's steps are awaits that a live backend's event loop resumes     *)
(* (writeFile ends, success or not; the app keeps reading its events: an   *)
(* app that stops reading stops the job, by design of `for await`), the    *)
(* driver's poll is a 200 ms timer and its chain resumes on each answer,   *)
(* and a live CLI goes on with its turn and reads its stdin. send() has    *)
(* none: the app may stop sending. The timeout has none unless TimeoutFair,*)
(* so a job that only the timeout ends violates Ends.                      *)
(***************************************************************************)
Fair ==
  /\ WF_vars(JOpen) /\ WF_vars(JDrv) /\ WF_vars(JLoop) /\ WF_vars(JLoopW) /\ WF_vars(JStart)
  /\ WF_vars(JHandle) /\ WF_vars(JStreamDone) /\ WF_vars(WJson) /\ WF_vars(WOk) /\ WF_vars(RLine)
  /\ WF_vars(DPoll) /\ WF_vars(DSay) /\ WF_vars(DLineCodex) /\ WF_vars(DLineGrok)
  /\ WF_vars(CTake) /\ WF_vars(CEnd) /\ WF_vars(CReq) /\ WF_vars(CSteerTake) /\ WF_vars(CDone)
  /\ WF_vars(CTakeQ) /\ WF_vars(CDoneG)
  /\ (TimeoutFair => WF_vars(Timeout))

Spec == Init /\ [][Next]_vars /\ Fair

(***************************************************************************)
(* Properties.                                                             *)
(***************************************************************************)

\* R5.10: a job that ends with a turn's answer ends with the turn that answers the last message that send() accepted
\* (every message before it was answered by that turn or an earlier one). An error end (the command ended with no
\* answer, the driver failed, the timeout) is allowed.
AnswersLast == (jpc = "done" /\ ~jend.err) => jend.up = nm - 1
\* no `turn` event for the turn that answers the last message: a `turn` always has a later message
TurnNotLast == tmax < nm - 1
\* the driver gives the CLI message n as its n-th message
InboxRight == ~wrong
\* the driver fails the job only for a turn that did not start
NoDriverFail == ~dfail
\* an assumption of the Codex driver: it never starts a turn while one runs
StartWhenIdle == ~badstart

\* Reachability (a model that expects one of these violated shows that the model gets there): a `turn` event; a
\* message steered into a running turn (Codex acked a turn/steer, Grok queued an interjection); a job that ends with
\* the answer to every message the app may send
NeverTurn == tmax = NONE
NeverSteered == ~(cpend # <<>>)
NeverAllAnswered == ~(jpc = "done" /\ ~jend.err /\ jend.up = Sends)

\* the job ends
Ends == <>(jpc = "done")
\* every message that send() accepted is answered before the job ends, or the job ends with an error
Answered == \A i \in Msgs : (nm > i) ~> (jpc = "done" /\ (jend.err \/ jend.up >= i))
=============================================================================
