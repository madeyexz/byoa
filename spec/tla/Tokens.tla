----------------------------- MODULE Tokens -----------------------------
(***************************************************************************)
(* Job tokens (R3.1, R3.4) of one user's jobs, and the proxy's requests    *)
(* with them (src/mcp/proxy.ts JobTokens issue/check/end and mcpProxy;     *)
(* src/agents.ts issue and its close; src/job.ts open and close).          *)
(*                                                                         *)
(* Store entries of each job j: job/<hash> (`tok`: None or [until, ver])   *)
(* and jobid/<job> (`jid`: TRUE when it is there; its value is the hash).  *)
(*                                                                         *)
(* A job: issue puts tok (proxy.ts:26), then jid (proxy.ts:27), two steps; *)
(* then it waits in line for the sandbox and the AI login (job.ts:247,     *)
(* 281: any number of steps of time, at most MaxWait); then the harness    *)
(* starts (job.ts:284-286) and runs Run steps (the job timeout); then      *)
(* close: t.close is end (job.ts:231, agents.ts:282): get jid (proxy.ts:   *)
(* 42), delete tok (proxy.ts:43), delete jid (proxy.ts:44), three steps.   *)
(* Extend (the fix this spec proposes): when the harness starts, the token *)
(* works TTL from then: get jid, get tok, cas tok with the version read.   *)
(*                                                                         *)
(* A request (from the harness, or a copy of the token: any time after     *)
(* issue returned but not during the wait; checkServers' requests,         *)
(* job.ts:278, come before the wait, while the token is new, and nothing   *)
(* in the sandbox uses it until the harness starts): check gets tok        *)
(* (proxy.ts:32); valid (until > clock):                                   *)
(* the handler serves it (proxy.ts:73-108: the relay, or the MCP server);  *)
(* expired: end(r.job) (proxy.ts:37), three steps as above, then 401.      *)
(*                                                                         *)
(* One step of time is 5 minutes: TTL is the job timeout + 5 minutes, so   *)
(* TTL = Run + 1.                                                          *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - The token record is [until, ver]; user, servers and plan are left    *)
(*    out (they are written once, in issue, and only read after).         *)
(*  - A live backend's step takes less than one step of time; serving a   *)
(*    request (an MCP call, a model request through the relay) is one     *)
(*    step, so `serving` after the job's end is a request that was in      *)
(*    flight when close ran. A stream (SSE) can stay open longer.          *)
(*  - The sandbox, its pause and its timer are JobTiming.tla's. A job      *)
(*    whose backend dies keeps running in the sandbox until the provider   *)
(*    ends it; its token works until `until`.                              *)
(*  - The app's own jobToken() (no sandbox) is a job with no wait.        *)
(*  - A sandbox that sends a request during the wait, after a wait longer  *)
(*    than TTL, makes check remove its own token: only that job loses.     *)
(*                                                                         *)
(* Fairness: time passes (WF Tick); each step of a live backend is WF; a   *)
(* request of a live sandbox is WF. A dead backend gets none.             *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Jobs, Reqs, Run, TTL, MaxWait, MaxTime, Extend, Crash, None

VARIABLES
  clock, tok, jid, nver,
  pc, waited, ran, ev,    \* a job's step, how long it waited, how long its harness ran, the tok version it read
  rq,                     \* each request: [job, pc, after] (after: it began after the job's end returned)
  nreq,
  ended,                  \* end of this job returned (close)
  given                   \* issue returned the token (to the job, or the app)

vars == <<clock, tok, jid, nver, pc, waited, ran, ev, rq, nreq, ended, given>>

ReqIds == 1..Reqs

Init ==
  /\ clock = 0 /\ tok = [j \in Jobs |-> None] /\ jid = [j \in Jobs |-> FALSE] /\ nver = 0
  /\ pc = [j \in Jobs |-> "idle"] /\ waited = [j \in Jobs |-> 0] /\ ran = [j \in Jobs |-> 0] /\ ev = [j \in Jobs |-> 0]
  /\ rq = [r \in ReqIds |-> [job |-> None, pc |-> "none", after |-> FALSE]] /\ nreq = 0
  /\ ended = [j \in Jobs |-> FALSE] /\ given = [j \in Jobs |-> FALSE]

Go(j, s) == pc' = [pc EXCEPT ![j] = s]
Put(j, until) == tok' = [tok EXCEPT ![j] = [until |-> until, ver |-> nver + 1]] /\ nver' = nver + 1

\* agents.ts:276, proxy.ts:24-29
Issue(j) == pc[j] = "idle" /\ Put(j, clock + TTL) /\ Go(j, "issue2")
              /\ UNCHANGED <<clock, jid, waited, ran, ev, rq, nreq, ended, given>>
Issue2(j) == pc[j] = "issue2" /\ jid' = [jid EXCEPT ![j] = TRUE] /\ Go(j, "wait") /\ given' = [given EXCEPT ![j] = TRUE]
              /\ UNCHANGED <<clock, tok, nver, waited, ran, ev, rq, nreq, ended>>
\* the wait in line ends (slots.take, login.env's wait), and the harness starts
StartHarness(j) ==
  /\ pc[j] = "wait"
  /\ Go(j, IF Extend THEN "x.jid" ELSE "run")
  /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, ev, rq, nreq, ended, given>>
\* the fix: get jid, get tok, cas tok (until: TTL from now)
XJid(j) == pc[j] = "x.jid" /\ Go(j, IF jid[j] THEN "x.tok" ELSE "run")
             /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, ev, rq, nreq, ended, given>>
XTok(j) == pc[j] = "x.tok" /\ (IF tok[j] = None THEN Go(j, "run") /\ UNCHANGED ev ELSE ev' = [ev EXCEPT ![j] = tok[j].ver] /\ Go(j, "x.cas"))
             /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, rq, nreq, ended, given>>
XCas(j) ==
  /\ pc[j] = "x.cas"
  /\ IF tok[j] # None /\ tok[j].ver = ev[j] THEN Put(j, clock + TTL) ELSE UNCHANGED <<tok, nver>>
  /\ Go(j, "run")
  /\ UNCHANGED <<clock, jid, waited, ran, ev, rq, nreq, ended, given>>
\* the harness ran its time (or ended before): close (job.ts:225-231)
Close(j) == pc[j] = "run" /\ Go(j, "e.jid") /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, ev, rq, nreq, ended, given>>
\* end (proxy.ts:41-45), by the job's close
EJid(j) == pc[j] = "e.jid" /\ Go(j, IF jid[j] THEN "e.tok" ELSE "e.del")
             /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, ev, rq, nreq, ended, given>>
ETok(j) == pc[j] = "e.tok" /\ tok' = [tok EXCEPT ![j] = None] /\ Go(j, "e.del")
             /\ UNCHANGED <<clock, jid, nver, waited, ran, ev, rq, nreq, ended, given>>
EDel(j) == pc[j] = "e.del" /\ jid' = [jid EXCEPT ![j] = FALSE] /\ Go(j, "done") /\ ended' = [ended EXCEPT ![j] = TRUE]
             /\ UNCHANGED <<clock, tok, nver, waited, ran, ev, rq, nreq, given>>

Die(j) == Crash /\ pc[j] \notin {"idle", "done", "dead"} /\ Go(j, "dead")
            /\ UNCHANGED <<clock, tok, jid, nver, waited, ran, ev, rq, nreq, ended, given>>

\* --- requests with job j's token, once issue returned ---
Send(j) ==
  /\ nreq < Reqs /\ given[j] /\ pc[j] \notin {"wait", "x.jid", "x.tok", "x.cas"}
  /\ rq' = [rq EXCEPT ![nreq + 1] = [job |-> j, pc |-> "check", after |-> ended[j]]]
  /\ nreq' = nreq + 1
  /\ UNCHANGED <<clock, tok, jid, nver, pc, waited, ran, ev, ended, given>>
RGo(r, s) == rq' = [rq EXCEPT ![r].pc = s]
\* proxy.ts:32-38
Check(r) ==
  /\ rq[r].pc = "check"
  /\ LET t == tok[rq[r].job] IN
       IF t = None THEN RGo(r, "refused")
       ELSE IF t.until > clock THEN RGo(r, "serving")
       ELSE RGo(r, "c.jid")
  /\ UNCHANGED <<clock, tok, jid, nver, pc, waited, ran, ev, nreq, ended, given>>
\* end(r.job), by check
CJid(r) == rq[r].pc = "c.jid" /\ RGo(r, IF jid[rq[r].job] THEN "c.tok" ELSE "c.jdel")
             /\ UNCHANGED <<clock, tok, jid, nver, pc, waited, ran, ev, nreq, ended, given>>
CTok(r) == rq[r].pc = "c.tok" /\ tok' = [tok EXCEPT ![rq[r].job] = None] /\ RGo(r, "c.jdel")
             /\ UNCHANGED <<clock, jid, nver, pc, waited, ran, ev, nreq, ended, given>>
CJdel(r) == rq[r].pc = "c.jdel" /\ jid' = [jid EXCEPT ![rq[r].job] = FALSE] /\ RGo(r, "refused")
             /\ UNCHANGED <<clock, tok, nver, pc, waited, ran, ev, nreq, ended, given>>
\* the handler serves it (the relay or the MCP server answers)
Serve(r) == rq[r].pc = "serving" /\ RGo(r, "served")
              /\ UNCHANGED <<clock, tok, jid, nver, pc, waited, ran, ev, nreq, ended, given>>

\* time: a job waits at most MaxWait steps, and its harness runs at most Run steps
Tick ==
  /\ clock < MaxTime
  /\ \A j \in Jobs : pc[j] \notin {"issue2", "x.jid", "x.tok", "x.cas", "e.jid", "e.tok", "e.del"}
  /\ \A j \in Jobs : (pc[j] = "wait" => waited[j] < MaxWait) /\ (pc[j] = "run" => ran[j] < Run)
  /\ \A r \in ReqIds : rq[r].pc \in {"none", "refused", "served", "serving", "check"}
  /\ clock' = clock + 1
  /\ waited' = [j \in Jobs |-> IF pc[j] = "wait" THEN waited[j] + 1 ELSE waited[j]]
  /\ ran' = [j \in Jobs |-> IF pc[j] = "run" THEN ran[j] + 1 ELSE ran[j]]
  /\ UNCHANGED <<tok, jid, nver, pc, ev, rq, nreq, ended, given>>

JobStep(j) == Issue2(j) \/ StartHarness(j) \/ XJid(j) \/ XTok(j) \/ XCas(j) \/ Close(j) \/ EJid(j) \/ ETok(j) \/ EDel(j)
ReqStep(r) == Check(r) \/ CJid(r) \/ CTok(r) \/ CJdel(r) \/ Serve(r)
Next ==
  \/ Tick
  \/ \E j \in Jobs : Issue(j) \/ JobStep(j) \/ Send(j) \/ Die(j)
  \/ \E r \in ReqIds : ReqStep(r)

Fairness == WF_vars(Tick) /\ \A j \in Jobs : WF_vars(JobStep(j)) /\ \A r \in ReqIds : WF_vars(ReqStep(r))
Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* R3.4: a request that the proxy gets after the job's end returned is refused
RefusedAfterEnd == \A r \in ReqIds : rq[r].after => rq[r].pc \notin {"serving", "served"}
\* R3.4: after end, the token stays gone (nothing puts it back: an extend that read it before end cannot)
StaysGone == \A j \in Jobs : ended[j] => tok[j] = None
\* R3.1: the job's token works while its harness runs (its MCP servers, and its plan's relay)
WorksWhileRunning == \A j \in Jobs : pc[j] = "run" => (tok[j] # None /\ tok[j].until > clock)
\* no request is served after its job ended: false, a request checked just before end runs on (in flight)
NoServeAfterEnd == \A r \in ReqIds : (rq[r].job # None /\ ended[rq[r].job]) => rq[r].pc # "serving"
\* every token leaves the store: false when a backend dies during the job (or between issue's two puts) and no
\* request checks its token after its time ran out: nothing else removes it (a store with no TTL keeps it)
Clean == (clock = MaxTime /\ \A j \in Jobs : pc[j] \in {"idle", "done", "dead"}) => \A j \in Jobs : tok[j] = None

\* every job of a live backend ends, and every request is answered
JobsEnd == \A j \in Jobs : (pc[j] \notin {"idle", "done", "dead"}) ~> (pc[j] \in {"done", "dead"})
Answered == \A r \in ReqIds : (rq[r].pc = "check") ~> (rq[r].pc \in {"refused", "served"})
=============================================================================
