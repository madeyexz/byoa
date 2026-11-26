----------------------------- MODULE SignIn -----------------------------
(***************************************************************************)
(* The sign-in of one user and harness (src/login.ts, cliLogin; storedLogin *)
(* uses it with its signedIn hook): connectLogin (start), finishLogin       *)
(* (finish, also a check-in), cancelLogin (cancel = dropPending), and       *)
(* signOut, called by the app's backends at the same time, and the         *)
(* provider's timer of each sign-in sandbox (create: LOGIN_MAX_MS; resume  *)
(* and keepAlive: the time they set).                                      *)
(*                                                                         *)
(* One step of time is one minute: LOGIN_MAX_MS is 15, LOGIN_IDLE_MS 2.    *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - A call of a live backend ends within one step of time.             *)
(*  - The CLI's sign-in is one flag of its sandbox (`done`: the user       *)
(*    finished on the lab's page, so the CLI exited and wrote its login).  *)
(*    A sign-in that fails, and finish's wait loop, are left out: finish   *)
(*    reads the status once (waitMs is the time resume gives the sandbox). *)
(*  - signOut is its cancel, then the delete of the login and the state;   *)
(*    its sign-out sandbox and deleteSandbox are left out.                 *)
(*  - The provider has keepAlive (E2B, Daytona, local); Instabox has none, *)
(*    so there a sign-in sandbox lives its LOGIN_MAX_MS.                   *)
(*  - All backends have one clock (login.ts uses Date.now, not time.ts).   *)
(*  - keepAlive gives a sandbox at least 1 s in the code; the model gives  *)
(*    it 0 steps at the cap.                                               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Procs, MaxCalls, Max, Idle, Wait, MaxTime, Crash, None

VARIABLES
  clock,
  pending,  \* the store's loginjob entry: [sbx, at], or None
  sbx,      \* the provider's sign-in sandboxes: id -> [run, end, at, done]
  nsbx,
  login,    \* the store holds a login
  state,    \* the login state: "in" or "out"
  pc, call, loc,
  calls,
  cancelOk, \* a cancelLogin returned, and no connectLogin ran meanwhile
  outOk     \* a signOut returned, and no finishLogin or connectLogin ran meanwhile

vars == <<clock, pending, sbx, nsbx, login, state, pc, call, loc, calls, cancelOk, outOk>>

Ids == 1..MaxCalls
Min(a, b) == IF a < b THEN a ELSE b
Max0(a) == IF a < 0 THEN 0 ELSE a

Init ==
  /\ clock = 0 /\ pending = None
  /\ sbx = [i \in Ids |-> [run |-> FALSE, end |-> 0, at |-> 0, done |-> FALSE]]
  /\ nsbx = 0 /\ login = FALSE /\ state = "out"
  /\ pc = [p \in Procs |-> "idle"] /\ call = [p \in Procs |-> "none"] /\ loc = [p \in Procs |-> None]
  /\ calls = 0 /\ cancelOk = FALSE /\ outOk = FALSE

InCall(k) == \E p \in Procs : call[p] = k /\ pc[p] \notin {"idle", "dead"}
Go(p, s) == pc' = [pc EXCEPT ![p] = s]
Ret(p) == pc' = [pc EXCEPT ![p] = "idle"] /\ call' = [call EXCEPT ![p] = "none"]
Kill(i) == [sbx EXCEPT ![i].run = FALSE]
Running(i) == i \in Ids /\ sbx[i].run

Begin(p) ==
  /\ pc[p] = "idle" /\ calls < MaxCalls
  /\ \E k \in {"start", "finish", "cancel", "signout"} :
       /\ call' = [call EXCEPT ![p] = k]
       /\ Go(p, k)
       /\ cancelOk' = (cancelOk /\ k # "start")
       /\ outOk' = (outOk /\ k \notin {"start", "finish"})
  /\ calls' = calls + 1
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, state, loc>>

\* dropPending, as start, cancel and signOut run it: read the entry, then delete it and destroy its sandbox
DropRead(p, from, next) ==
  /\ pc[p] = from
  /\ loc' = [loc EXCEPT ![p] = pending]
  /\ Go(p, next)
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, state, call, calls, cancelOk, outOk>>
DropDel(p, from, next) ==
  /\ pc[p] = from
  /\ IF loc[p] = None THEN UNCHANGED <<pending, sbx>>
     ELSE pending' = None /\ sbx' = Kill(loc[p].sbx)
  /\ UNCHANGED <<clock, nsbx, login, state, loc, calls, outOk>>

\* start: dropPending, then a new sandbox (timeoutMs LOGIN_MAX_MS), the CLI, the pending entry, keepAlive(Idle)
StartDrop(p) == DropRead(p, "start", "start.del")
StartDel(p) == DropDel(p, "start.del", "start.create") /\ Go(p, "start.create") /\ UNCHANGED <<call, cancelOk>>
StartCreate(p) ==
  /\ pc[p] = "start.create"
  /\ nsbx' = nsbx + 1
  /\ sbx' = [sbx EXCEPT ![nsbx + 1] = [run |-> TRUE, end |-> clock + Max, at |-> clock, done |-> FALSE]]
  /\ loc' = [loc EXCEPT ![p] = [sbx |-> nsbx + 1, at |-> clock]]
  /\ Go(p, "start.put")
  /\ UNCHANGED <<clock, pending, login, state, call, calls, cancelOk, outOk>>
StartPut(p) ==
  /\ pc[p] = "start.put"
  /\ pending' = loc[p]
  /\ Go(p, "start.keep")
  /\ UNCHANGED <<clock, sbx, nsbx, login, state, call, loc, calls, cancelOk, outOk>>
KeepAlive(i, at, ms) == IF Running(i) THEN [sbx EXCEPT ![i].end = clock + Max0(Min(ms, at + Max - clock))] ELSE sbx
StartKeep(p) ==
  /\ pc[p] = "start.keep"
  /\ sbx' = KeepAlive(loc[p].sbx, loc[p].at, Idle)
  /\ Ret(p)
  /\ UNCHANGED <<clock, pending, nsbx, login, state, loc, calls, cancelOk, outOk>>

\* finish: read the entry; after LOGIN_MAX_MS, dropPending; resume (timeoutMs Idle + waitMs), keepAlive, read the status
FinishRead(p) ==
  /\ pc[p] = "finish"
  /\ loc' = [loc EXCEPT ![p] = pending]
  /\ IF pending = None THEN Ret(p)
     ELSE IF clock - pending.at > Max THEN Go(p, "finish.drop") /\ UNCHANGED call   \* ranOut
     ELSE Go(p, "finish.resume") /\ UNCHANGED call
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, state, calls, cancelOk, outOk>>
FinishDrop(p) == DropRead(p, "finish.drop", "finish.dropdel")
FinishDropDel(p) == DropDel(p, "finish.dropdel", "idle") /\ Ret(p) /\ UNCHANGED cancelOk
FinishResume(p) ==
  /\ pc[p] = "finish.resume"
  /\ IF Running(loc[p].sbx)
     THEN /\ sbx' = [sbx EXCEPT ![loc[p].sbx].end = clock + Idle + Wait]
          /\ Go(p, "finish.keep") /\ UNCHANGED call
     \* the sandbox is gone: ranOut, which is dropPending
     ELSE /\ Go(p, "finish.drop") /\ UNCHANGED <<sbx, call>>
  /\ UNCHANGED <<clock, pending, nsbx, login, state, loc, calls, cancelOk, outOk>>
FinishKeep(p) ==
  /\ pc[p] = "finish.keep"
  /\ sbx' = KeepAlive(loc[p].sbx, loc[p].at, Idle + Wait)
  /\ IF Running(loc[p].sbx) /\ sbx[loc[p].sbx].done THEN Go(p, "finish.del") /\ UNCHANGED call
     ELSE Ret(p)   \* `pending` (or the sandbox went meanwhile)
  /\ UNCHANGED <<clock, pending, nsbx, login, state, loc, calls, cancelOk, outOk>>
FinishDel(p) ==
  /\ pc[p] = "finish.del"
  /\ pending' = None
  /\ Go(p, "finish.save")
  /\ UNCHANGED <<clock, sbx, nsbx, login, state, call, loc, calls, cancelOk, outOk>>
\* storedLogin's signedIn: store.put of the login files read from the sandbox
FinishSave(p) ==
  /\ pc[p] = "finish.save"
  /\ login' = (login \/ Running(loc[p].sbx))
  /\ sbx' = Kill(loc[p].sbx)
  /\ Go(p, "finish.state")
  /\ UNCHANGED <<clock, pending, nsbx, state, call, loc, calls, cancelOk, outOk>>
FinishState(p) ==
  /\ pc[p] = "finish.state"
  /\ state' = IF login THEN "in" ELSE state
  /\ Ret(p)
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, loc, calls, cancelOk, outOk>>

CancelRead(p) == DropRead(p, "cancel", "cancel.del")
CancelDel(p) ==
  /\ DropDel(p, "cancel.del", "idle") /\ Ret(p)
  /\ cancelOk' = ~InCall("start")

OutRead(p) == DropRead(p, "signout", "signout.del")
OutDel(p) == DropDel(p, "signout.del", "signout.login") /\ Go(p, "signout.login") /\ UNCHANGED <<call, cancelOk>>
OutLogin(p) ==
  /\ pc[p] = "signout.login"
  /\ login' = FALSE
  /\ Go(p, "signout.state")
  /\ UNCHANGED <<clock, pending, sbx, nsbx, state, call, loc, calls, cancelOk, outOk>>
OutState(p) ==
  /\ pc[p] = "signout.state"
  /\ state' = "out"
  /\ Ret(p)
  /\ outOk' = ~InCall("finish") /\ ~InCall("start")
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, loc, calls, cancelOk>>

\* the user finishes on the lab's page: the CLI writes its login and exits
UserDone == \E i \in Ids : Running(i) /\ ~sbx[i].done /\ sbx' = [sbx EXCEPT ![i].done = TRUE]
              /\ UNCHANGED <<clock, pending, nsbx, login, state, pc, call, loc, calls, cancelOk, outOk>>

Die(p) ==
  /\ Crash /\ pc[p] \notin {"idle", "dead"}
  /\ pc' = [pc EXCEPT ![p] = "dead"]
  /\ UNCHANGED <<clock, pending, sbx, nsbx, login, state, call, loc, calls, cancelOk, outOk>>

\* the provider ends a sandbox at its time
\* a live backend's call ends within the minute it began
Tick ==
  /\ clock < MaxTime
  /\ \A p \in Procs : pc[p] \in {"idle", "dead"}
  /\ clock' = clock + 1
  /\ sbx' = [i \in Ids |-> IF sbx[i].run /\ sbx[i].end <= clock + 1 THEN [sbx[i] EXCEPT !.run = FALSE] ELSE sbx[i]]
  /\ UNCHANGED <<pending, nsbx, login, state, pc, call, loc, calls, cancelOk, outOk>>

Next ==
  \/ Tick \/ UserDone
  \/ \E p \in Procs :
       \/ Begin(p) \/ Die(p)
       \/ StartDrop(p) \/ StartDel(p) \/ StartCreate(p) \/ StartPut(p) \/ StartKeep(p)
       \/ FinishRead(p) \/ FinishDrop(p) \/ FinishDropDel(p) \/ FinishResume(p) \/ FinishKeep(p) \/ FinishDel(p) \/ FinishSave(p) \/ FinishState(p)
       \/ CancelRead(p) \/ CancelDel(p)
       \/ OutRead(p) \/ OutDel(p) \/ OutLogin(p) \/ OutState(p)

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
\* R1.7: a sign-in lasts LOGIN_MAX_MS at most: no sign-in sandbox runs past its start + 15 min (while a finish of a
\* live backend is between its resume and its keepAlive, the sandbox may for that moment)
Resuming(i) == \E p \in Procs : pc[p] = "finish.keep" /\ loc[p] # None /\ loc[p].sbx = i
Cap == \A i \in Ids : (Running(i) /\ ~Resuming(i)) => sbx[i].end <= sbx[i].at + Max

\* R1.7: cancelLogin ends the sign-in and its sandbox at once
CancelEnds == cancelOk => \A i \in Ids : ~Running(i)

\* signOut: once it returned, the user is signed out, and stays so until the next sign-in starts
SignOutWins == outOk => (~login /\ state = "out")
=============================================================================
