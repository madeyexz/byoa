---------------------------- MODULE JobTiming ----------------------------
(***************************************************************************)
(* The jobs of one kept sandbox (one user, harness and sandbox key, or one *)
(* conversation) in time: src/job.ts (open, close, renew, the `beat`      *)
(* interval, Sandbox.setTimeout), src/slots.ts (take, set, renew: the     *)
(* slot's lease), src/queue.ts (the slot's line and its tickets), the     *)
(* login watcher and the loan of src/login-stored.ts (load, release), and *)
(* the provider: src/sandbox/e2b.ts (timeoutMs at create and resume, a     *)
(* kept sandbox pauses when its time runs out, STOP_ALL at the resume of  *)
(* a paused one, setTimeout, pause = STOP_ALL + a full snapshot, or a     *)
(* snapshot of the files only after a 503), Daytona's idle stop           *)
(* (src/sandbox/daytona.ts, Provider "idle"), and providers with no timer *)
(* within the horizon (Instabox's kept sandbox, local: "notimer").        *)
(* Line numbers are of d7c34b7.                                            *)
(*                                                                         *)
(* One step of time is 15 s. With the defaults of the code:                *)
(*   the slot's lease     take + jobTimeoutMs + 5 min (slots.ts 33,        *)
(*                        agents.ts 95); renewed by the beat every 60 s    *)
(*                        until the harness starts (job.ts 224, 249, 284), *)
(*                        and once when it starts (job.ts 286)             *)
(*   the provider's timer resume or create + jobTimeoutMs + 60 s (E2B,     *)
(*                        job.ts 252, 262; a resume of a running sandbox   *)
(*                        only makes it longer), again at setTimeout once  *)
(*                        the job has the login (job.ts 285). Daytona: 60 s*)
(*                        + jobTimeoutMs, rounded up to minutes, after the *)
(*                        last call to the sandbox (autoStopInterval).    *)
(*   the watcher          when load took the login + jobTimeoutMs + 45 s   *)
(*                        (job.ts 281, login-stored.ts 165-187)           *)
(*   the harness          its start + jobTimeoutMs (job.ts 399; E2B's     *)
(*                        envd kills a command at its timeoutMs, also     *)
(*                        when the backend is gone; Daytona and Instabox  *)
(*                        run it under `timeout -s KILL`)                 *)
(*   checkpoints          every 60 s (job.ts 290)                         *)
(*   a ticket in a line   30 s after it was last renewed (queue.ts 90,125)*)
(* The models keep the 60 s and 45 s margins (4 and 3 steps), and scale   *)
(* the job's time, the 5 min margin and the 60 s periods down, so TLC can *)
(* check them: what matters is how the times order, not their size.       *)
(*                                                                         *)
(* Actions and the code they stand for (d7c34b7):                          *)
(*   Arrive     job.ts 247: slots.take joins the line (queue.ts 115-128)   *)
(*   Take       queue.ts 119-121 (only the first live ticket tries) and    *)
(*              slots.ts 28-36 (get, compare-and-set while until < now)    *)
(*   Start      job.ts 252 (resume; e2b.ts 103-109: getInfo, connect with  *)
(*              timeoutMs, STOP_ALL when it was paused) or job.ts 262-268 *)
(*              (create, slots.set), and job.ts 274-275 (the job folder)  *)
(*   Setup      job.ts 276-279: cred.check, checkServers, install          *)
(*   Load       job.ts 281 -> login-stored.ts load 164-179, after take     *)
(*              returned: the loan (171-179); then at d7c34b7 the files    *)
(*              (180-181), with WatchFirst the marker and the watcher      *)
(*   Load2      load 182-189: the marker and the watcher (with WatchFirst: *)
(*              the files), and held                                       *)
(*   SetTime    job.ts 284-286 (clearInterval(beat), sbx.setTimeout,       *)
(*              renew), 288-293, and run() 366-399 up to the harness start *)
(*   Refresh    the CLI refreshes its login and writes its files           *)
(*   Checkpoint job.ts 290 -> login-stored.ts checkpoint 205-214           *)
(*   HarnessEnds job.ts 399-417 (the harness ends: it finished or its      *)
(*              timeout) and stream()'s finally 519-524                    *)
(*   Stopped    the stream ends because the sandbox paused or went         *)
(*   Release    job.ts 225-234 -> login-stored.ts release 215-232          *)
(*   Pause      job.ts 235-240: e2b.ts pause 64 (STOP_ALL), or destroy     *)
(*              when release failed, then slots.set(slot, sandbox, 0)      *)
(*   Pausing    e2b.ts 65-67: the full snapshot, or after a 503 the files  *)
(*              only; both may fail (PauseFails), then close throws and    *)
(*              its finally still gives the slot back (job.ts 239-240)     *)
(*   Die        the backend dies between two of its steps                 *)
(*   ProviderPause E2B's timer (lifecycle onTimeout 'pause', e2b.ts 98: a  *)
(*              full snapshot, processes frozen), or Daytona's idle stop  *)
(*   Watch      the watcher: `sleep s; [ marker = nonce ] && rm -f ...`   *)
(*   Tick       15 s pass; the beat (job.ts 249: renew, and with the fix  *)
(*              BeatTimer also sbx.setTimeout) and, on Daytona, the       *)
(*              checkpoint's calls, which count as the sandbox's activity *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - A step of a live backend takes less than 15 s, and so do the steps  *)
(*    from take's return to the harness start (Load, SetTime) and from    *)
(*    the harness's end to release. The code's margin for them is the     *)
(*    watcher's 45 s. Setup takes up to MaxSetup steps, and the wait for  *)
(*    the AI login up to MaxLoginWait (LoginLease.tla models that wait).  *)
(*  - Steps merged, with why it is sound:                                  *)
(*    . Take: slots.take's get and compare-and-set are one step (a CAS on *)
(*      the version read; a lost CAS is a poll that took nothing), and    *)
(*      the line's leave after it (the holder's ticket stays first a      *)
(*      moment longer: nobody else could take the held slot anyway).      *)
(*    . Start: E2B's connect and the STOP_ALL after it. Between them the  *)
(*      frozen processes of a dead job run again a moment; the new job    *)
(*      does nothing in the sandbox until resume returns, so that is the  *)
(*      dead job's harness running a moment longer before the pause       *)
(*      (it was past its time: envd killed it, and the watcher had run).  *)
(*    . Load and Load2: the store calls and sandbox writes of each half.  *)
(*      Another job cannot use this sandbox meanwhile (the slot), and the *)
(*      timer cannot run out within a step unless it is due, which Urgent *)
(*      makes happen first. The split is where a death matters: between  *)
(*      the login files and the watcher.                                  *)
(*    . SetTime: setTimeout, renew and the harness start. A death between *)
(*      them leaves the files with the new timer (after the watcher) or   *)
(*      the beat's timer (BeatTimer) and no harness: as a harness that    *)
(*      ended at once.                                                    *)
(*    . Release: read, save, rm, the loan's delete and give. A provider   *)
(*      pause between them makes rm fail, so close destroys the sandbox,  *)
(*      as when the whole release fails.                                  *)
(*    . Pausing: the full snapshot and the 503 fallback are one step: both *)
(*      keep the files and no process (STOP_ALL ran before, in Pause).    *)
(*  - The slot's line: a live waiter's ticket never runs out (it renews it*)
(*    at half its 30 s); a dead waiter's runs out TicketSteps after it    *)
(*    died. A new job that finds no line tries before it joins it (as     *)
(*    the code does): Arrive puts it last, and it is first when no live   *)
(*    ticket is before it.                                                 *)
(*  - The AI login is one flag, `files` (the login files are in the        *)
(*    sandbox), and `unsaved` (they hold a refresh that the store has      *)
(*    not). LoginLease.tla models the login itself. A CLI whose files the *)
(*    watcher removed does not write them again.                          *)
(*  - Provider "idle" is Daytona's kept sandbox: it stops TimerExtra + T   *)
(*    steps after the last call to it (the margin of 60 s, rounded up to  *)
(*    minutes in the code, so the model's is the shortest). The harness's *)
(*    own stream is taken as no activity; the checkpoint's calls are.     *)
(*    Daytona's kept sandbox has no setTimeout (daytona.ts 130).           *)
(*  - "notimer": Instabox's kept sandbox (it suspends itself after 30 min *)
(*    idle, beyond these horizons) and the local sandbox.                 *)
(*  - Heartbeat (job.ts 249) renews the slot's lease every 60 s until the *)
(*    harness starts. The model renews it at each step to what a renewal  *)
(*    RenewEvery steps ago would give (its lowest).                       *)
(*  - TimeFromLogin (job.ts 285, login-stored.ts 168): once the job has    *)
(*    the login, the watcher's deadline is now + jobTimeoutMs + 45 s and  *)
(*    the provider's timer is set again to now + jobTimeoutMs + 60 s.     *)
(*  - BeatTimer (a fix this model proposes, not in d7c34b7): the beat also *)
(*    sets the sandbox's time, to jobTimeoutMs + 60 s + 60 s from now, so *)
(*    a job that waits in line for the AI login keeps its sandbox. Its    *)
(*    lowest is, as for the lease, what a beat RenewEvery steps ago gave: *)
(*    now + T + TimerExtra.                                               *)
(*  - The beat fires every RenewEvery steps from when open began (before  *)
(*    take), at a phase the model does not know: its effect at a time is  *)
(*    what a beat RenewEvery steps ago gave, and only once RenewEvery     *)
(*    steps passed since resume or create (before, the sandbox has the    *)
(*    time resume or create gave it). The same for Daytona's checkpoints. *)
(*  - LongStart (fix 2, after 1a58e3c): resume and create give the        *)
(*    sandbox the beat's time, T + 60 s + 60 s, so the watcher (T + 45 s  *)
(*    from load) runs first also when load runs before the first beat.    *)
(*    On Daytona the model keeps T + 60 s for the idle stop.              *)
(*  - WatchFirst (a fix this model proposes, not in d7c34b7): load starts *)
(*    the marker and the watcher before it writes the login files.        *)
(*  - Not modeled: deleteSandbox (Index.tla), sandboxPer 'job' (no slot:  *)
(*    the same timer, and E2B kills instead of pausing), a resume or      *)
(*    create that fails (the job gives the slot back and ends).           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Jobs,          \* the jobs of this sandbox key, such as {"j1", "j2", "j3"}
  T,             \* jobTimeoutMs, in steps of 15 s
  MaxSetup,      \* the most steps from resume (or create) to the wait for the login
  MaxLoginWait,  \* the most steps a job waits in line for the AI login
  ArriveBy,      \* jobs arrive until then
  MaxTime,       \* the horizon
  Provider,      \* "e2b", "idle" (Daytona) or "notimer"
  Crash,         \* TRUE: a backend may die at any step of its job
  Heartbeat,     \* fix (job.ts 249): a job renews its slot's lease until its harness starts
  TimeFromLogin, \* fix (job.ts 285): once the job has the login, the provider's timer and the watcher start again
  BeatTimer,     \* proposed fix: the beat also sets the sandbox's time while the job waits
  WatchFirst,    \* proposed fix: load starts the watcher before it writes the login files
  LongStart,     \* fix 2: resume and create give the sandbox the beat's time (T + 60 s + 60 s), not T + 60 s
  PauseFails,    \* E2B's pause (the full snapshot, and the snapshot of the files after a 503) may fail
  SlotExtra,     \* the slot lease beyond the job's time: 5 min (20 steps)
  TimerExtra,    \* the provider's timer beyond the job's time: 60 s (4 steps)
  WatchExtra,    \* the watcher beyond the job's time: 45 s (3 steps)
  CheckpointEvery, \* 60 s (4 steps)
  RenewEvery,    \* the beat: every 60 s (4 steps)
  TicketSteps    \* a dead waiter's ticket runs out within 30 s (2 steps)

None == "none"
Max(a, b) == IF a > b THEN a ELSE b

VARIABLES
  clock,
  pc,       \* each job's step
  ord,      \* its place in the slot's line (the order the jobs came)
  tk,       \* a dead waiter's ticket: when it runs out
  sid,      \* the sandbox id the job resumed or created
  t0,       \* when the job resumed or created it
  tw,       \* when the job began to wait for the login
  th,       \* when its harness started
  run,      \* the job's harness runs in the sandbox (also after its backend died)
  ok,       \* release could read and remove the files (so close pauses, else destroys)
  slot,     \* the slot in the store: holder, until, and the sandbox id
  sbx,      \* the provider's sandbox: id, state, timer, login files in it, the watcher marker
  watchers, \* the background watchers: [owner, id, at]
  loan,     \* the loan record of the sandbox: the job that wrote it, or None
  unsaved,  \* the files in the sandbox hold a refresh that the store has not
  tu,       \* when the CLI wrote that refresh
  lost,     \* a refresh was removed or destroyed before byoa saved it
  cut,      \* the provider paused a live job's harness before its time
  early,    \* a watcher removed the login while its own job's harness ran
  lostbox   \* the provider paused (or stopped) the sandbox of a live job before its harness started

vars == <<clock, pc, ord, tk, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

Open == {"setup", "wait", "loading", "loaded", "harness", "release", "pause", "pausing"}
Alive(j) == pc[j] # "dead"

Init ==
  /\ clock = 0
  /\ pc = [j \in Jobs |-> "idle"]
  /\ ord = [j \in Jobs |-> 0]
  /\ tk = [j \in Jobs |-> 0]
  /\ sid = [j \in Jobs |-> 0]
  /\ t0 = [j \in Jobs |-> 0]
  /\ tw = [j \in Jobs |-> 0]
  /\ th = [j \in Jobs |-> 0]
  /\ run = [j \in Jobs |-> FALSE]
  /\ ok = [j \in Jobs |-> FALSE]
  /\ slot = [holder |-> None, until |-> 0, id |-> 0]
  /\ sbx = [id |-> 0, state |-> "none", timer |-> 0, files |-> FALSE, marker |-> None]
  /\ watchers = {}
  /\ loan = None
  /\ unsaved = FALSE
  /\ tu = 0
  /\ lost = FALSE
  /\ cut = FALSE
  /\ early = FALSE
  /\ lostbox = FALSE

SlotFree == slot.holder = None \/ slot.until < clock
HarnessEnd(j) == th[j] + T
Running == sbx.state = "running"
Mine(j) == sid[j] = sbx.id
\* every process in the sandbox stops (a pause, a destroy, STOP_ALL)
Stop(id) == [k \in Jobs |-> IF sid[k] = id THEN FALSE ELSE run[k]]
NoWatcher(id) == {w \in watchers : w.id # id}
\* a ticket in the slot's line (queue.ts live()): a live waiter's, or a dead waiter's that has not run out
InLine(k) == pc[k] = "queued" \/ (pc[k] = "dead" /\ tk[k] > clock)
\* queue.ts 118-119: only the first ticket tries to take
First(j) == \A k \in Jobs \ {j} : InLine(k) => ord[k] > ord[j]
\* Daytona: a call to the sandbox is activity, so it stops only T + TimerExtra steps after the last one
Activity(j) == IF Provider = "idle" /\ Mine(j) /\ Running THEN [sbx EXCEPT !.timer = Max(@, clock + T + TimerExtra)] ELSE sbx

\* the watcher that load starts: its deadline, from when the job had the login (login-stored.ts 168), or at the old code
\* from before it waited (job.ts computed it before load waited in line)
Watcher(j) == [owner |-> j, id |-> sbx.id,
               at |-> Max(clock, IF TimeFromLogin THEN clock + T + WatchExtra ELSE tw[j] + T + WatchExtra)]

Arrive(j) ==
  /\ pc[j] = "idle" /\ clock <= ArriveBy
  /\ pc' = [pc EXCEPT ![j] = "queued"]
  /\ ord' = [ord EXCEPT ![j] = 1 + Max(ord[CHOOSE k \in Jobs : \A i \in Jobs : ord[i] <= ord[k]], 0)]
  /\ UNCHANGED <<clock, tk, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* queue.ts 119-121 and slots.ts 28-36: the first in line takes the slot with compare-and-set while its lease ran out
Take(j) ==
  /\ pc[j] = "queued" /\ SlotFree /\ First(j)
  /\ slot' = [holder |-> j, until |-> clock + T + SlotExtra, id |-> slot.id]
  /\ pc' = [pc EXCEPT ![j] = "starting"]
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, ok, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* the time resume and create give the sandbox (job.ts 250-266): T + 60 s, or with LongStart the beat's T + 60 s + 60 s.
\* Daytona's idle stop takes the create's time as its interval; the model keeps T + 60 s there (shorter: conservative).
StartTimer == clock + T + TimerExtra + (IF LongStart /\ Provider = "e2b" THEN RenewEvery ELSE 0)

\* job.ts 251-268: resume the slot's sandbox (e2b.ts 103-109: connect with timeoutMs, which only makes a running one's
\* time longer; STOP_ALL when it was paused), or create one and record it with slots.set
Start(j) ==
  /\ pc[j] = "starting"
  /\ IF slot.id = sbx.id /\ sbx.state \in {"running", "paused"}
     THEN /\ sbx' = [sbx EXCEPT !.state = "running",
                                !.timer = IF sbx.state = "running" THEN Max(@, StartTimer) ELSE StartTimer]
          /\ run' = IF sbx.state = "paused" THEN Stop(sbx.id) ELSE run
          /\ watchers' = IF sbx.state = "paused" THEN NoWatcher(sbx.id) ELSE watchers
          /\ sid' = [sid EXCEPT ![j] = sbx.id]
          /\ pc' = [pc EXCEPT ![j] = "setup"]
          /\ UNCHANGED <<slot, lost, unsaved>>
     ELSE /\ sbx' = [id |-> sbx.id + 1, state |-> "running", timer |-> StartTimer, files |-> FALSE, marker |-> None]
          /\ lost' = (lost \/ (unsaved /\ sbx.files))
          /\ unsaved' = FALSE
          /\ run' = Stop(sbx.id)
          /\ watchers' = {}
          /\ sid' = [sid EXCEPT ![j] = sbx.id + 1]
          /\ IF slot.holder = j
             THEN /\ slot' = [holder |-> j, until |-> clock + T + SlotExtra, id |-> sbx.id + 1]
                  /\ pc' = [pc EXCEPT ![j] = "setup"]
             \* slots.set fails: the slot is not ours now; the job fails and destroys its new sandbox (job.ts 265-267, 235)
             ELSE /\ slot' = slot
                  /\ pc' = [pc EXCEPT ![j] = "pause"]
  /\ t0' = [t0 EXCEPT ![j] = clock]
  /\ ok' = [ok EXCEPT ![j] = FALSE]
  /\ UNCHANGED <<clock, ord, tk, tw, th, loan, tu, cut, early, lostbox>>

\* job.ts 274-279: the job folder (274-275, no other job can see it), the check, the MCP check and the install; then load waits in line for the login
Setup(j) ==
  /\ pc[j] = "setup"
  /\ pc' = [pc EXCEPT ![j] = "wait"]
  /\ tw' = [tw EXCEPT ![j] = clock]
  /\ sbx' = Activity(j)
  /\ UNCHANGED <<clock, ord, tk, sid, t0, th, run, ok, slot, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* login-stored.ts load 164-189, once take returned the login lease. Step 1: the loan (171-179), then at d7c34b7 the
\* files (180-181); with WatchFirst (a fix this model proposes) the marker and the watcher (182-188) instead
Load(j) ==
  /\ pc[j] = "wait"
  /\ IF Mine(j) /\ Running
     \* a loan left by a dead job: save what its CLI left here (171-178)
     THEN /\ unsaved' = FALSE
          /\ lost' = (lost \/ (unsaved /\ sbx.files /\ loan = None))
          /\ loan' = j
          /\ IF WatchFirst
             THEN /\ sbx' = [Activity(j) EXCEPT !.marker = j]
                  /\ watchers' = watchers \cup {Watcher(j)}
             ELSE /\ sbx' = [Activity(j) EXCEPT !.files = TRUE]
                  /\ UNCHANGED watchers
          /\ pc' = [pc EXCEPT ![j] = "loading"]
     \* the sandbox is paused or gone: writing fails, load gives the lease back, and the job closes
     ELSE /\ pc' = [pc EXCEPT ![j] = "release"]
          /\ UNCHANGED <<unsaved, lost, sbx, watchers, loan>>
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, ok, slot, tu, cut, early, lostbox>>

\* load, step 2: the marker and the watcher (182-188); with WatchFirst, the files (180-181)
Load2(j) ==
  /\ pc[j] = "loading"
  /\ IF Mine(j) /\ Running
     THEN /\ IF WatchFirst
             THEN /\ sbx' = [sbx EXCEPT !.files = TRUE]
                  /\ UNCHANGED watchers
             ELSE /\ sbx' = [sbx EXCEPT !.marker = j]
                  /\ watchers' = watchers \cup {Watcher(j)}
          /\ pc' = [pc EXCEPT ![j] = "loaded"]
     ELSE /\ pc' = [pc EXCEPT ![j] = "release"]
          /\ UNCHANGED <<sbx, watchers>>
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, ok, slot, loan, unsaved, tu, lost, cut, early, lostbox>>

\* job.ts 284-286: the beat stops, the sandbox's time starts again (setTimeout), the slot's lease is renewed; then the
\* checkpoint interval, the harness's files and the harness (288-293, run() 366-399)
SetTime(j) ==
  /\ pc[j] = "loaded"
  /\ IF Mine(j) /\ Running
     THEN /\ sbx' = IF TimeFromLogin /\ Provider = "e2b" THEN [sbx EXCEPT !.timer = clock + T + TimerExtra] ELSE Activity(j)
          /\ run' = [run EXCEPT ![j] = TRUE]
          /\ th' = [th EXCEPT ![j] = clock]
          /\ pc' = [pc EXCEPT ![j] = "harness"]
     ELSE /\ pc' = [pc EXCEPT ![j] = "release"]
          /\ UNCHANGED <<sbx, run, th>>
  /\ slot' = IF Heartbeat /\ slot.holder = j THEN [slot EXCEPT !.until = clock + T + SlotExtra] ELSE slot
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, ok, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* the CLI refreshes its login and writes its files
Refresh(j) ==
  /\ run[j] /\ Mine(j) /\ Running /\ sbx.files /\ ~unsaved
  /\ unsaved' = TRUE
  /\ tu' = clock
  /\ UNCHANGED <<clock, pc, ord, tk, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, lost, cut, early, lostbox>>

CheckpointDue(j) == pc[j] = "harness" /\ Mine(j) /\ Running /\ sbx.files /\ unsaved

\* job.ts 290: every 60 s, login-stored.ts checkpoint 205-214 saves what the CLI changed
Checkpoint(j) ==
  /\ CheckpointDue(j)
  /\ unsaved' = FALSE
  /\ UNCHANGED <<clock, pc, ord, tk, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, tu, lost, cut, early, lostbox>>

\* the harness ends (it finished, or its timeout), and a live job closes
HarnessEnds(j) ==
  /\ run[j]
  /\ run' = [run EXCEPT ![j] = FALSE]
  /\ pc' = IF Alive(j) THEN [pc EXCEPT ![j] = "release"] ELSE pc
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* a live job's harness stopped (its sandbox paused or went): the stream ends, the job closes
Stopped(j) ==
  /\ pc[j] = "harness" /\ ~run[j]
  /\ pc' = [pc EXCEPT ![j] = "release"]
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* job.ts 234 -> login-stored.ts release 215-232: read the files (save a refresh), remove them and the marker, delete
\* the loan, give the lease back
Release(j) ==
  /\ pc[j] = "release"
  /\ IF Mine(j) /\ Running
     THEN /\ sbx' = [Activity(j) EXCEPT !.files = FALSE, !.marker = None]
          /\ unsaved' = FALSE
          /\ loan' = None
          /\ ok' = [ok EXCEPT ![j] = TRUE]
     ELSE /\ UNCHANGED <<sbx, unsaved, loan>>
          /\ ok' = [ok EXCEPT ![j] = FALSE]
  /\ pc' = [pc EXCEPT ![j] = "pause"]
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, slot, watchers, tu, lost, cut, early, lostbox>>

GiveSlot(j) == IF slot.holder = j THEN [holder |-> None, until |-> 0, id |-> slot.id] ELSE slot

\* job.ts 235-240: e2b.ts 64, STOP_ALL before the pause (it ends the watcher too); or destroy when release failed (or
\* with no slot: the job's new sandbox after slots.set failed); a call to a sandbox that is paused or gone fails, and
\* close's finally gives the slot back
Pause(j) ==
  /\ pc[j] = "pause"
  /\ IF Mine(j) /\ Running /\ ok[j]
     THEN /\ run' = Stop(sbx.id)
          /\ watchers' = NoWatcher(sbx.id)
          /\ pc' = [pc EXCEPT ![j] = "pausing"]
          /\ UNCHANGED <<sbx, lost, unsaved, slot>>
     ELSE /\ IF Mine(j) /\ sbx.state \in {"running", "paused"} /\ ~ok[j]
             THEN /\ sbx' = [sbx EXCEPT !.state = "gone", !.files = FALSE]
                  /\ run' = Stop(sbx.id)
                  /\ watchers' = NoWatcher(sbx.id)
                  /\ lost' = (lost \/ (unsaved /\ sbx.files))
                  /\ unsaved' = FALSE
             ELSE UNCHANGED <<sbx, run, watchers, lost, unsaved>>
          /\ slot' = GiveSlot(j)
          /\ pc' = [pc EXCEPT ![j] = "done"]
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, ok, loan, tu, cut, early, lostbox>>

\* e2b.ts 65-67: the full snapshot, or the files only after a 503: both keep the files and no process. Both may fail
\* (PauseFails): close throws, the sandbox runs on until its timer. Then slots.set(slot, sandbox, 0).
Pausing(j) ==
  /\ pc[j] = "pausing"
  /\ \/ /\ Mine(j) /\ Running
        /\ sbx' = [sbx EXCEPT !.state = "paused"]
     \/ /\ PauseFails \/ ~(Mine(j) /\ Running)
        /\ UNCHANGED sbx
  /\ slot' = GiveSlot(j)
  /\ pc' = [pc EXCEPT ![j] = "done"]
  /\ UNCHANGED <<clock, ord, tk, sid, t0, tw, th, run, ok, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* the backend dies: close never runs; what runs in the sandbox goes on. A waiter's ticket runs out within 30 s.
Die(j) ==
  /\ Crash /\ pc[j] \notin {"idle", "done", "dead"}
  /\ pc' = [pc EXCEPT ![j] = "dead"]
  /\ tk' = IF pc[j] = "queued" THEN [tk EXCEPT ![j] = clock + TicketSteps] ELSE tk
  /\ UNCHANGED <<clock, ord, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* E2B: a kept sandbox pauses when its timer runs out (lifecycle onTimeout 'pause': a full snapshot, its processes
\* frozen until the next resume's STOP_ALL); Daytona: a kept sandbox stops when it was idle that long. Its files stay.
ProviderPause ==
  /\ Provider \in {"e2b", "idle"} /\ Running /\ clock >= sbx.timer
  /\ sbx' = [sbx EXCEPT !.state = "paused"]
  /\ run' = Stop(sbx.id)
  /\ cut' = (cut \/ \E j \in Jobs : run[j] /\ Mine(j) /\ Alive(j) /\ clock < HarnessEnd(j))
  /\ lostbox' = (lostbox \/ \E j \in Jobs : Alive(j) /\ Mine(j) /\ pc[j] \in {"setup", "wait", "loading", "loaded"})
  /\ watchers' = NoWatcher(sbx.id)
  /\ UNCHANGED <<clock, pc, ord, tk, sid, t0, tw, th, ok, slot, loan, unsaved, tu, lost, early>>

\* the watcher (login-stored.ts 187): `sleep s; [ marker = nonce ] && rm -f files marker`
Watch(w) ==
  /\ w \in watchers /\ w.id = sbx.id /\ Running /\ clock >= w.at
  /\ IF sbx.marker = w.owner
     THEN /\ sbx' = [sbx EXCEPT !.files = FALSE, !.marker = None]
          /\ lost' = (lost \/ unsaved)
          /\ unsaved' = FALSE
          /\ early' = (early \/ run[w.owner])
     ELSE UNCHANGED <<sbx, lost, unsaved, early>>
  /\ watchers' = watchers \ {w}
  /\ UNCHANGED <<clock, pc, ord, tk, sid, t0, tw, th, run, ok, slot, loan, tu, cut, lostbox>>

\* something must happen before the next 15 s
Urgent ==
  \/ \E j \in Jobs : pc[j] = "queued" /\ SlotFree /\ First(j)
  \/ \E j \in Jobs : pc[j] \in {"starting", "loading", "loaded", "release", "pause", "pausing"}
  \/ \E j \in Jobs : pc[j] = "harness" /\ ~run[j]
  \/ \E j \in Jobs : pc[j] = "setup" /\ clock >= t0[j] + MaxSetup
  \/ \E j \in Jobs : pc[j] = "wait" /\ clock >= tw[j] + MaxLoginWait
  \/ \E j \in Jobs : run[j] /\ clock >= HarnessEnd(j)
  \/ \E j \in Jobs : CheckpointDue(j) /\ clock >= tu + CheckpointEvery
  \/ Provider \in {"e2b", "idle"} /\ Running /\ clock >= sbx.timer
  \/ \E w \in watchers : w.id = sbx.id /\ Running /\ clock >= w.at

\* a live job of this sandbox that waits for its harness: the beat runs (job.ts 249-284)
Beating(j) == Alive(j) /\ pc[j] \in {"starting", "setup", "wait", "loading", "loaded"}
\* a beat set the sandbox's time within the last RenewEvery steps (BeatTimer), surely, at clock + 1
BeatsTimer(j) == BeatTimer /\ Beating(j) /\ pc[j] # "starting" /\ clock + 1 >= t0[j] + RenewEvery
\* Daytona: a checkpoint called the sandbox within the last CheckpointEvery steps, surely, at clock + 1
Checkpoints(j) == Provider = "idle" /\ Alive(j) /\ pc[j] = "harness" /\ clock + 1 >= th[j] + CheckpointEvery

Tick ==
  /\ clock < MaxTime /\ ~Urgent
  /\ clock' = clock + 1
  \* job.ts 249: the beat renews the lease every minute until the harness starts: at its lowest, one minute ago
  /\ slot' = IF Heartbeat /\ slot.holder \in Jobs /\ Beating(slot.holder)
             THEN [slot EXCEPT !.until = Max(@, clock + 1 + T + SlotExtra - RenewEvery)]
             ELSE slot
  \* the fix BeatTimer: the beat also sets the sandbox's time (E2B: to T + 60 s + 60 s; Daytona, the proposal: its
  \* activity, T + 60 s). The beat fires every RenewEvery steps from when open began, at a phase the model does not
  \* know, so its lowest value at clock + 1 is that of a beat RenewEvery steps ago; that holds only once RenewEvery
  \* steps passed since resume or create (t0), as one beat surely fired since then. Before, the sandbox has the time
  \* that resume or create gave it (StartTimer). Daytona, during the harness: each checkpoint's calls are activity.
  /\ sbx' = IF Running /\ \E j \in Jobs : Mine(j) /\ BeatsTimer(j)
            THEN [sbx EXCEPT !.timer = Max(@, clock + 1 + T + TimerExtra - (IF Provider = "e2b" THEN 0 ELSE RenewEvery))]
            ELSE IF Running /\ \E j \in Jobs : Mine(j) /\ Checkpoints(j)
            THEN [sbx EXCEPT !.timer = Max(@, clock + 1 + T + TimerExtra - CheckpointEvery)]
            ELSE sbx
  /\ UNCHANGED <<pc, ord, tk, sid, t0, tw, th, run, ok, watchers, loan, unsaved, tu, lost, cut, early, lostbox>>

\* the steps of job j's own backend (no fairness once it died)
Own(j) == Take(j) \/ Start(j) \/ Setup(j) \/ Load(j) \/ Load2(j) \/ SetTime(j) \/ Stopped(j) \/ Release(j) \/ Pause(j) \/ Pausing(j)

Next ==
  \/ Tick \/ ProviderPause
  \/ \E w \in watchers : Watch(w)
  \/ \E j \in Jobs : Arrive(j) \/ Own(j) \/ Refresh(j) \/ Checkpoint(j) \/ HarnessEnds(j) \/ Die(j)

Spec == Init /\ [][Next]_vars

(* Fairness, as the code gives it:
   - a live backend's steps (Own, Checkpoint): WF. Each is a store or sandbox call, or a poll loop with a sleep
     (queue.ts 131: every 0.5 to 2 s) whose step stays enabled until it is taken: only the first ticket takes, so a
     free slot stays free for it. A dead backend's steps are not enabled (pc = "dead"), so it gets none.
   - time (Tick): WF; it is enabled while nothing is due (Urgent), and Urgent's steps are all WF here.
   - the provider's timer (ProviderPause), the watcher's sleep (Watch), and the end of a harness at its timeout
     (HarnessEnds: envd's timeoutMs on E2B, `timeout -s KILL` elsewhere): WF, also after the backend died.
   - not fair: Arrive (an app may never start a job), Die, Refresh (the CLI decides). *)
Fairness ==
  /\ WF_vars(Tick) /\ WF_vars(ProviderPause) /\ WF_vars(\E w \in watchers : Watch(w))
  /\ \A j \in Jobs : WF_vars(Own(j)) /\ WF_vars(Checkpoint(j)) /\ WF_vars(HarnessEnds(j))

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* a job uses the sandbox: from its resume to its pause, while the sandbox runs; or its harness still runs there
InSandbox(j) == Mine(j) /\ ((Alive(j) /\ pc[j] \in Open /\ Running) \/ run[j])

\* R5.4, R5.9: one job of a slot (a conversation) at a time in its sandbox
OneJobPerSandbox == \A j, k \in Jobs : j # k => ~(InSandbox(j) /\ InSandbox(k))

\* R1.4, R5.4: no copy of the AI login stays in a paused sandbox, also when the backend died. (While a live job of
\* the sandbox is still open, its close destroys a sandbox whose files it could not remove.)
NoLoginInPausedSandbox ==
  (sbx.state = "paused" /\ sbx.files) => \E j \in Jobs : Alive(j) /\ Mine(j) /\ pc[j] \in Open

\* R1.4 "lose little": no refresh the CLI wrote is removed or destroyed before byoa saved it
NoLostRefresh == ~lost

\* the harness of a live job gets its whole time (jobTimeoutMs)
HarnessGetsItsTime == ~cut

\* the watcher removes the login only after its job's harness ended (else the CLI loses its login mid-run)
WatcherSparesHarness == ~early

\* R5.8: a job waits in line for the AI login with no time limit, so the provider never pauses or stops its sandbox
\* while it waits (then load cannot write the files, the job fails, and close destroys the user's kept sandbox)
WaitKeepsSandbox == ~lostbox

(* Liveness (check with LiveSpec, and no SYMMETRY) *)

\* R5.8: a job in the slot's line gets the slot (or its backend dies)
GetsSlot == \A j \in Jobs : pc[j] = "queued" ~> pc[j] # "queued"
\* every job that came ends (closed, or its backend died)
Ends == \A j \in Jobs : pc[j] = "queued" ~> pc[j] \in {"done", "dead"}

Sym == Permutations(Jobs)

TypeOK ==
  /\ pc \in [Jobs -> {"idle", "queued", "starting", "setup", "wait", "loading", "loaded", "harness", "release", "pause", "pausing", "done", "dead"}]
  /\ slot.holder \in Jobs \cup {None}
  /\ sbx.state \in {"none", "running", "paused", "gone"}
=============================================================================
