---------------------------- MODULE JobTiming ----------------------------
(***************************************************************************)
(* The jobs of one kept sandbox (one user, harness and sandbox key, or one *)
(* conversation) in time: src/job.ts (open, close), src/slots.ts (the      *)
(* slot's lease), the login watcher of src/login-stored.ts (load), and the *)
(* provider's own timer (src/sandbox/e2b.ts: `timeoutMs` at create and at  *)
(* resume, and a kept sandbox pauses when it runs out).                    *)
(*                                                                         *)
(* One step of time is 15 s. With the defaults of the code:                *)
(*   the slot's lease     take + jobTimeoutMs + 5 min                      *)
(*   the provider's timer resume (or create) + jobTimeoutMs + 60 s (E2B)   *)
(*   the watcher          job.ts computes its deadline, now +              *)
(*                        jobTimeoutMs + 45 s, before load waits in line   *)
(*                        for the AI login                                 *)
(*   the harness          its start + jobTimeoutMs                         *)
(*   checkpoints          every 60 s                                       *)
(* The models keep the 60 s and 45 s margins (4 and 3 steps) and scale    *)
(* the job's time, the 5 min margin and the 60 s periods down, so TLC can *)
(* check them: what matters is how the times order, not their size.       *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - The slot's line (queue.ts) is not modeled: a waiting job takes the   *)
(*    slot as soon as its lease is free. The line's order is the same     *)
(*    code as the login's line, which LoginLease.tla checks (Line).       *)
(*  - A step of a live backend (take, resume or create, release, pause)    *)
(*    takes less than 15 s. Setup (check, MCP check, install) takes up to  *)
(*    MaxSetup steps, and the wait for the AI login up to MaxLoginWait.    *)
(*  - The AI login is one flag, `files` (the login files are in the        *)
(*    sandbox), and `unsaved` (they hold a refresh that the store has      *)
(*    not). LoginLease.tla models the login itself.                        *)
(*  - "notimer" stands for Daytona, Instabox and the local sandbox, whose  *)
(*    kept sandboxes do not pause by a timer within the horizon.          *)
(*  - Heartbeat (the fix in job.ts) renews the slot's lease every 60 s     *)
(*    until the harness starts, and once more when it starts. The model   *)
(*    renews it at each step to what a renewal a minute ago would give.   *)
(*  - TimeFromLogin (the fix in job.ts and login-stored.ts): when the job  *)
(*    has the login, the provider's timer is set again to now +           *)
(*    jobTimeoutMs + 60 s (Sandbox.setTimeout), and the watcher's         *)
(*    deadline is now + jobTimeoutMs + 45 s.                               *)
(*  - A dead backend's harness ends at its own timeout (Daytona and        *)
(*    Instabox run it under `timeout -s KILL`; on E2B the sandbox pauses). *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Jobs,          \* the jobs of this sandbox key, such as {"j1", "j2"}
  T,             \* jobTimeoutMs, in steps of 15 s
  MaxSetup,      \* the most steps from resume (or create) to the wait for the login
  MaxLoginWait,  \* the most steps a job waits in line for the AI login
  MaxTime,       \* the horizon
  Provider,      \* "e2b" or "notimer"
  Crash,         \* TRUE: a backend may die at any step of its job
  Heartbeat,     \* fix (job.ts): a job renews its slot's lease until its harness starts, and then
  TimeFromLogin, \* fix: once the job has the login, the provider's timer and the watcher start again
  SlotExtra,     \* the slot lease beyond the job's time: 5 min (20 steps)
  TimerExtra,    \* the provider's timer beyond the job's time: 60 s (4 steps)
  WatchExtra,    \* the watcher beyond the job's time: 45 s (3 steps)
  CheckpointEvery, \* 60 s (4 steps)
  RenewEvery     \* the fix: the slot's lease is renewed every 60 s (4 steps)


None == "none"
Max(a, b) == IF a > b THEN a ELSE b
Min(a, b) == IF a < b THEN a ELSE b

VARIABLES
  clock,
  pc,       \* each job's step
  sid,      \* the sandbox id the job resumed or created
  t0,       \* when the job resumed or created it: the provider's timer starts then
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
  early     \* a watcher removed the login while its own job's harness ran

vars == <<clock, pc, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

Open == {"setup", "wait", "harness", "release", "pause"}
Alive(j) == pc[j] # "dead"

Init ==
  /\ clock = 0
  /\ pc = [j \in Jobs |-> "idle"]
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

SlotFree == slot.holder = None \/ slot.until < clock
HarnessEnd(j) == th[j] + T
Running == sbx.state = "running"
Mine(j) == sid[j] = sbx.id
\* every process in the sandbox stops (a pause, a destroy, or E2B's STOP_ALL at resume)
Stop(id) == [k \in Jobs |-> IF sid[k] = id THEN FALSE ELSE run[k]]

Arrive(j) ==
  /\ pc[j] = "idle"
  /\ pc' = [pc EXCEPT ![j] = "queued"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* slots.ts take: compare-and-set while the lease ran out
Take(j) ==
  /\ pc[j] = "queued" /\ SlotFree
  /\ slot' = [holder |-> j, until |-> clock + T + SlotExtra, id |-> slot.id]
  /\ pc' = [pc EXCEPT ![j] = "starting"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, run, ok, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* job.ts open: resume the slot's sandbox (E2B: connect with timeoutMs T + 60 s; a paused one runs STOP_ALL),
\* or create one and record it with slots.set
Start(j) ==
  /\ pc[j] = "starting"
  /\ IF slot.id = sbx.id /\ sbx.state \in {"running", "paused"}
     THEN /\ sbx' = [sbx EXCEPT !.state = "running", !.timer = clock + T + TimerExtra]
          /\ run' = IF sbx.state = "paused" THEN Stop(sbx.id) ELSE run
          /\ watchers' = IF sbx.state = "paused" THEN {w \in watchers : w.id # sbx.id} ELSE watchers
          /\ sid' = [sid EXCEPT ![j] = sbx.id]
          /\ pc' = [pc EXCEPT ![j] = "setup"]
          /\ UNCHANGED <<slot, lost, unsaved>>
     ELSE /\ sbx' = [id |-> sbx.id + 1, state |-> "running", timer |-> clock + T + TimerExtra, files |-> FALSE, marker |-> None]
          /\ lost' = (lost \/ (unsaved /\ sbx.files))
          /\ unsaved' = FALSE
          /\ run' = Stop(sbx.id)
          /\ watchers' = {}
          /\ sid' = [sid EXCEPT ![j] = sbx.id + 1]
          /\ IF slot.holder = j
             THEN /\ slot' = [holder |-> j, until |-> clock + T + SlotExtra, id |-> sbx.id + 1]
                  /\ pc' = [pc EXCEPT ![j] = "setup"]
             \* the slot is not ours now: the job fails and destroys its new sandbox
             ELSE /\ slot' = slot
                  /\ pc' = [pc EXCEPT ![j] = "pause"]
  /\ t0' = [t0 EXCEPT ![j] = clock]
  /\ ok' = [ok EXCEPT ![j] = FALSE]
  /\ UNCHANGED <<clock, tw, th, loan, tu, cut, early>>

\* the check, the MCP check and the install
Setup(j) ==
  /\ pc[j] = "setup"
  /\ pc' = [pc EXCEPT ![j] = "wait"]
  /\ tw' = [tw EXCEPT ![j] = clock]
  /\ UNCHANGED <<clock, sid, t0, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* login-stored.ts load, once the job has the login lease: the loan, the files, the watcher; then the harness starts
Load(j) ==
  /\ pc[j] = "wait"
  /\ IF Mine(j) /\ Running
     \* job.ts computes the deadline (now + jobTimeoutMs + 45 s) before load waits in line for the login
     THEN LET deadline == IF TimeFromLogin THEN clock + T + WatchExtra ELSE tw[j] + T + WatchExtra IN
          \* a loan left by a dead job: save what its CLI left here
          /\ unsaved' = FALSE
          /\ lost' = (lost \/ (unsaved /\ sbx.files /\ loan = None))
          /\ sbx' = [sbx EXCEPT !.files = TRUE, !.marker = j,
                                 !.timer = IF TimeFromLogin THEN clock + T + TimerExtra ELSE @]
          /\ watchers' = watchers \cup {[owner |-> j, id |-> sbx.id, at |-> Max(clock, deadline)]}
          /\ loan' = j
          /\ run' = [run EXCEPT ![j] = TRUE]
          /\ th' = [th EXCEPT ![j] = clock]
          /\ pc' = [pc EXCEPT ![j] = "harness"]
          /\ slot' = IF Heartbeat /\ slot.holder = j THEN [slot EXCEPT !.until = clock + T + SlotExtra] ELSE slot
          /\ UNCHANGED ok
     \* the sandbox is paused or gone: writing the files fails, and the job closes
     ELSE /\ pc' = [pc EXCEPT ![j] = "release"]
          /\ UNCHANGED <<unsaved, lost, sbx, watchers, loan, run, th, ok, slot>>
  /\ UNCHANGED <<clock, sid, t0, tw, tu, cut, early>>

\* the CLI refreshes its login and writes its files
Refresh(j) ==
  /\ run[j] /\ Mine(j) /\ Running /\ sbx.files /\ ~unsaved
  /\ unsaved' = TRUE
  /\ tu' = clock
  /\ UNCHANGED <<clock, pc, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, lost, cut, early>>

CheckpointDue(j) == pc[j] = "harness" /\ Mine(j) /\ Running /\ sbx.files /\ unsaved

\* job.ts: every 60 s, login-stored.ts checkpoint saves what the CLI changed
Checkpoint(j) ==
  /\ CheckpointDue(j)
  /\ unsaved' = FALSE
  /\ UNCHANGED <<clock, pc, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, tu, lost, cut, early>>

\* the harness ends (it finished, or its timeout), and a live job closes
HarnessEnds(j) ==
  /\ run[j]
  /\ run' = [run EXCEPT ![j] = FALSE]
  /\ pc' = IF Alive(j) THEN [pc EXCEPT ![j] = "release"] ELSE pc
  /\ UNCHANGED <<clock, sid, t0, tw, th, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* a live job's harness stopped (its sandbox paused or went): the stream ends, the job closes
Stopped(j) ==
  /\ pc[j] = "harness" /\ ~run[j]
  /\ pc' = [pc EXCEPT ![j] = "release"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* close: credential release reads the files (saves a refresh), removes them and the marker, deletes the loan
Release(j) ==
  /\ pc[j] = "release"
  /\ IF Mine(j) /\ Running
     THEN /\ sbx' = [sbx EXCEPT !.files = FALSE, !.marker = None]
          /\ unsaved' = FALSE
          /\ loan' = None
          /\ ok' = [ok EXCEPT ![j] = TRUE]
     ELSE /\ UNCHANGED <<sbx, unsaved, loan>>
          /\ ok' = [ok EXCEPT ![j] = FALSE]
  /\ pc' = [pc EXCEPT ![j] = "pause"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, run, slot, watchers, tu, lost, cut, early>>

\* close: pause the sandbox (destroy it when release failed), then slots.set(slot, sandbox, 0) if still the holder
Pause(j) ==
  /\ pc[j] = "pause"
  /\ IF ~Mine(j) \/ sbx.state \notin {"running", "paused"}
     THEN UNCHANGED <<sbx, run, watchers, lost, unsaved>>
     ELSE IF ok[j] /\ Running
          THEN /\ sbx' = [sbx EXCEPT !.state = "paused"]
               /\ run' = Stop(sbx.id)
               /\ watchers' = {w \in watchers : w.id # sbx.id}
               /\ UNCHANGED <<lost, unsaved>>
          ELSE /\ sbx' = [sbx EXCEPT !.state = "gone", !.files = FALSE]
               /\ run' = Stop(sbx.id)
               /\ watchers' = {w \in watchers : w.id # sbx.id}
               /\ lost' = (lost \/ (unsaved /\ sbx.files))
               /\ unsaved' = FALSE
  /\ slot' = IF slot.holder = j THEN [holder |-> None, until |-> 0, id |-> slot.id] ELSE slot
  /\ pc' = [pc EXCEPT ![j] = "done"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, ok, loan, tu, cut, early>>

\* the backend dies: close never runs; what runs in the sandbox goes on
Die(j) ==
  /\ Crash /\ pc[j] \notin {"idle", "done", "dead"}
  /\ pc' = [pc EXCEPT ![j] = "dead"]
  /\ UNCHANGED <<clock, sid, t0, tw, th, run, ok, slot, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

\* E2B: a kept sandbox pauses when its timer runs out (lifecycle onTimeout: 'pause'); its files stay
ProviderPause ==
  /\ Provider = "e2b" /\ Running /\ clock >= sbx.timer
  /\ sbx' = [sbx EXCEPT !.state = "paused"]
  /\ run' = Stop(sbx.id)
  /\ cut' = (cut \/ \E j \in Jobs : run[j] /\ Mine(j) /\ Alive(j) /\ clock < HarnessEnd(j))
  /\ watchers' = {w \in watchers : w.id # sbx.id}
  /\ UNCHANGED <<clock, pc, sid, t0, tw, th, ok, slot, loan, unsaved, tu, lost, early>>

\* the watcher: `sleep s; [ marker = nonce ] && rm -f files marker`
Watch(w) ==
  /\ w \in watchers /\ w.id = sbx.id /\ Running /\ clock >= w.at
  /\ IF sbx.marker = w.owner
     THEN /\ sbx' = [sbx EXCEPT !.files = FALSE, !.marker = None]
          /\ lost' = (lost \/ unsaved)
          /\ unsaved' = FALSE
          /\ early' = (early \/ run[w.owner])
     ELSE UNCHANGED <<sbx, lost, unsaved, early>>
  /\ watchers' = watchers \ {w}
  /\ UNCHANGED <<clock, pc, sid, t0, tw, th, run, ok, slot, loan, tu, cut>>

\* something must happen before the next 15 s
Urgent ==
  \/ \E j \in Jobs : pc[j] = "queued" /\ SlotFree
  \/ \E j \in Jobs : pc[j] \in {"starting", "release", "pause"}
  \/ \E j \in Jobs : pc[j] = "harness" /\ ~run[j]
  \/ \E j \in Jobs : pc[j] = "setup" /\ clock >= t0[j] + MaxSetup
  \/ \E j \in Jobs : pc[j] = "wait" /\ clock >= tw[j] + MaxLoginWait
  \/ \E j \in Jobs : run[j] /\ clock >= HarnessEnd(j)
  \/ \E j \in Jobs : CheckpointDue(j) /\ clock >= tu + CheckpointEvery
  \/ Provider = "e2b" /\ Running /\ clock >= sbx.timer
  \/ \E w \in watchers : w.id = sbx.id /\ Running /\ clock >= w.at

Tick ==
  /\ clock < MaxTime /\ ~Urgent
  /\ clock' = clock + 1
  \* the fix renews the lease every minute until the harness starts: at its lowest, one minute ago
  /\ slot' = IF Heartbeat /\ slot.holder \in Jobs /\ pc[slot.holder] \in {"starting", "setup", "wait"}
             THEN [slot EXCEPT !.until = Max(@, clock + 1 + T + SlotExtra - RenewEvery)]
             ELSE slot
  /\ UNCHANGED <<pc, sid, t0, tw, th, run, ok, sbx, watchers, loan, unsaved, tu, lost, cut, early>>

Next ==
  \/ Tick \/ ProviderPause
  \/ \E w \in watchers : Watch(w)
  \/ \E j \in Jobs : Arrive(j) \/ Take(j) \/ Start(j) \/ Setup(j) \/ Load(j) \/ Refresh(j) \/ Checkpoint(j)
                     \/ HarnessEnds(j) \/ Stopped(j) \/ Release(j) \/ Pause(j) \/ Die(j)

Spec == Init /\ [][Next]_vars

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

Sym == Permutations(Jobs)

TypeOK ==
  /\ pc \in [Jobs -> {"idle", "queued", "starting", "setup", "wait", "harness", "release", "pause", "done", "dead"}]
  /\ slot.holder \in Jobs \cup {None}
=============================================================================
