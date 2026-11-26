------------------------------- MODULE Help -------------------------------
(***************************************************************************)
(* The help agent (madeyexz/byoa-help at 8c26677, convex/): every         *)
(* visitor's question runs as a job of ONE byoa user (OWNER), on the       *)
(* maintainer's one Codex login, each visitor's chat in its own kept       *)
(* sandbox (a byoa conversation). SPEC.md, "Lab rules": "every visitor's   *)
(* question runs on Ian Hsiao's own ChatGPT plan ... limits keep its use   *)
(* small".                                                                 *)
(*                                                                         *)
(* What runs, in the model (one step of time is one minute: JOB_MS is   *)
(* J = 3, STALE_JOB_MS S = 6, the action limit A = 10, leaseMs LL = 8;   *)
(* E2B's timer and the watcher, JOB_MS + 60 s and + 45 s, are J + 1; the *)
(* checkpoint runs once in each step; a job's setup takes < 1 step):     *)
(*  - ask (help.ts 103-122: seen, one job of a visitor, in line, pump),    *)
(*    the sweep (help.ts 228-249: jobs older than STALE_JOB_MS fail, a     *)
(*    visitor seen more than an hour ago is forgotten, pump), endJob       *)
(*    (151-165) and drop (252-259): each one step (a Convex mutation, one  *)
(*    serializable transaction; scheduler.runAfter is atomic with it).     *)
(*  - runJob (agents.ts 44-101) with byoa's run (job.ts): the job's kept  *)
(*    sandbox (create or resume; E2B's timeoutMs = JOB_MS + 60 s, again at *)
(*    setTimeout after the login), the wait in line for the login's lease  *)
(*    (queue.ts, login-stored.ts take: no time limit, storedLogin's waitMs *)
(*    is not set), the harness (at most JOB_MS), the checkpoint of the     *)
(*    login every minute (job.ts CHECKPOINT_MS), the watcher that removes  *)
(*    the login files JOB_MS + 45 s after the login (login-stored.ts      *)
(*    182-187), and close (release: save a refresh, remove the files, give *)
(*    the lease; pause). An action may die (Crash), and Convex kills a     *)
(*    Node action after 10 minutes (A): then its sandbox runs on until its *)
(*    timer, and its lease until LL (leaseMs = JOB_MS + 5 min).            *)
(*  - forget (agents.ts 104-110, from the sweep and from clear, help.ts   *)
(*    125-135, with keepRows): deleteConversation (its                    *)
(*    sandbox goes, also while a job runs in it), then drop.              *)
(*  - the login: `due` is TRUE while the login is due for a refresh within *)
(*    a job's lease (refreshDue - now <= leaseMs, login-stored.ts 125):    *)
(*    then each job takes the lease alone. Codex's CLI in a job that holds *)
(*    it alone may refresh (it rotates the refresh token, so the stored   *)
(*    login stops working: storeOk); a save (checkpoint or close) puts the *)
(*    new login in the store and the login is no longer due.               *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - The model starts in the window when the login is due (Due), or with *)
(*    the login not due (shared leases); it does not model the clock that *)
(*    moves from one to the other (LoginLease.tla does, with `want`).     *)
(*  - The owner's sign-in (agents.signIn, finishSignIn), offline and       *)
(*    resting (setOffline, setResting, failLine), clear, the budget,       *)
(*    DAILY_JOBS, PER_HOUR, MAX_CHARS, the feedback and the traces are     *)
(*    left out: they only refuse or fail jobs in line.                    *)
(*  - slots.take with resume or create is one step; load (take, write the *)
(*    files, setTimeout) is one step; close is one step; a line ticket of *)
(*    a dead action leaves the line at the next step of time (TICKET_MS is *)
(*    30 s). The watcher and E2B's timer end in the same step of time (45 s*)
(*    and 60 s after the login); the watcher acts first.                   *)
(*  - A live action's step takes less than a minute; a live action waits  *)
(*    only in line for the lease and while its harness runs.              *)
(*  - The scheduler starts runJob at once: its age counts from pump.       *)
(* Fixes (proposals for byoa-help; the flags are FALSE for 8c26677):       *)
(*  S: STALE_JOB_MS; the code has 6. A value of A + 1 (11) is the fix.     *)
(*  LW: the most minutes a job waits for the login (storedLogin waitMs);   *)
(*    0: no limit, the code, and every model. Not needed: E2B pauses a    *)
(*    kept sandbox (autoResume false) JOB_MS + 60 s after create while its *)
(*    job still waits, so a job that gets the login has waited <= J + 1.  *)
(*    In the code the job then waits on for the lease and fails at load's *)
(*    writeFile; the model ends it when its sandbox pauses (H3).          *)
(*  FixForget: as Demo.tla: the sweep fails a job in line of a visitor it *)
(*    forgets and waits while it runs, and drop deletes nothing when the  *)
(*    visitor's `seen` changed since the sweep set it (ask and clear set  *)
(*    it; the help page has no touch: site/help.html calls only view, ask *)
(*    and clear).                                                          *)
(*  FixOneJob: ask looks at the visitor's last job of any age, not only    *)
(*    those of the last hour (help.ts 113-114).                            *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS V, MAX, F, S, A, J, LL, LW, Due, Crash, MaxCrash, MaxCalls, Return, Clear, FixForget, FixOneJob

VARIABLES
  row, seen, req,        \* the visitors row, its seen (age; F = 0: no forget), the ghost age since the last request
  jst, jage, jat, line,  \* the visitor's job: state, age since started, age since `at`; the line of jobs
  dup,                   \* ghost: ask took a second job of the visitor while one is in line or runs
  fsince,                \* the visitor asked or cleared since the sweep began their forget (drop's seen check)
  cpc,                   \* clear's forget (keepRows) of each visitor: its step
  pc, aage,              \* runJob of each visitor: its step, its age (the action limit)
  fpc,                   \* forget of each visitor: its step
  sbx, sleft,            \* the visitor's conversation sandbox ("none", "run", "paused") and E2B's time left
  files, fresh, wleft,   \* the login files in it; they hold a refresh that is not saved; the watcher's time left
  hold, lage, lline,     \* the lease of the owner's login, per job ("none", "alone", "shared"), its age; the line
  hage, ck,              \* the harness's age; a checkpoint is due (once each minute)
  due, storeOk, lost,    \* the login is due; the stored login works; ghost: a refresh was lost
  swept, calls, crashes

vars == <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, pc, aage, fpc, sbx, sleft, files, fresh, wleft, hold, lage, lline,
          hage, ck, due, storeOk, lost, swept, calls, crashes>>

Idle == {"idle", "dead"}
Min(a, b) == IF a < b THEN a ELSE b
Max0(a) == IF a < 0 THEN 0 ELSE a
Sat(x, m) == IF x >= m THEN m ELSE x + 1
Active(v) == jst[v] \in {"queued", "running"}
Live(v) == hold[v] # "none" /\ lage[v] < LL     \* a lease that has not run out

Init ==
  /\ row = [v \in V |-> FALSE] /\ seen = [v \in V |-> 0] /\ req = [v \in V |-> 0]
  /\ jst = [v \in V |-> "none"] /\ jage = [v \in V |-> 0] /\ jat = [v \in V |-> 0] /\ line = <<>>
  /\ dup = [v \in V |-> FALSE] /\ fsince = [v \in V |-> FALSE] /\ cpc = [v \in V |-> "idle"]
  /\ pc = [v \in V |-> "idle"] /\ aage = [v \in V |-> 0] /\ fpc = [v \in V |-> "idle"]
  /\ sbx = [v \in V |-> "none"] /\ sleft = [v \in V |-> 0]
  /\ files = [v \in V |-> FALSE] /\ fresh = [v \in V |-> FALSE] /\ wleft = [v \in V |-> 0]
  /\ hold = [v \in V |-> "none"] /\ lage = [v \in V |-> 0] /\ lline = <<>>
  /\ hage = [v \in V |-> 0] /\ ck = [v \in V |-> FALSE]
  /\ due = Due /\ storeOk = TRUE /\ lost = FALSE
  /\ swept = FALSE /\ calls = 0 /\ crashes = 0

(* help.ts pump (68-78): free = max - running *)
Pump(js, ln, pc0, a0) ==
  LET free == MAX - Cardinality({v \in V : js[v] = "running"})
      n == IF free <= 0 THEN 0 ELSE Min(free, Len(ln))
      G == {ln[i] : i \in 1..n}
  IN /\ jst' = [v \in V |-> IF v \in G THEN "running" ELSE js[v]]
     /\ jage' = [v \in V |-> IF v \in G THEN 0 ELSE jage[v]]
     /\ line' = SubSeq(ln, n + 1, Len(ln))
     /\ pc' = [v \in V |-> IF v \in G THEN "h1" ELSE pc0[v]]
     /\ aage' = [v \in V |-> IF v \in G THEN 0 ELSE a0[v]]

login == <<files, fresh, wleft, hold, lage, lline, hage, ck, due, storeOk, lost>>

(* the hour of ask's "jobs of the last hour" (F = 0: the models with no forget, where no job is that old) *)
Young(v) == F = 0 \/ jat[v] < F
(* help.ts seen (60-65), as ask and clear call it *)
Seen(v) ==
  /\ row' = [row EXCEPT ![v] = TRUE] /\ seen' = [seen EXCEPT ![v] = 0] /\ req' = [req EXCEPT ![v] = 0]
  /\ fsince' = [fsince EXCEPT ![v] = TRUE]
Req(v) == calls < MaxCalls /\ (Return \/ req[v] < F) /\ calls' = calls + 1

(* help.ts ask (103-122): seen; refuse while a job of the last hour waits or runs (FixOneJob: the last job of any *)
(* age); else in line, pump. A second job is only recorded (dup): the model keeps one job per visitor.            *)
Ask(v) ==
  /\ Req(v) /\ Seen(v)
  /\ IF Active(v) /\ (FixOneJob \/ Young(v)) THEN UNCHANGED <<jst, jage, jat, line, pc, aage, dup>>
     ELSE IF Active(v) THEN dup' = [dup EXCEPT ![v] = TRUE] /\ UNCHANGED <<jst, jage, jat, line, pc, aage>>
     ELSE /\ jat' = [jat EXCEPT ![v] = 0] /\ UNCHANGED dup
          /\ Pump([jst EXCEPT ![v] = "queued"], Append(line, v), pc, aage)
  /\ UNCHANGED <<fpc, cpc, sbx, sleft, login, swept, crashes>>

(* help.ts clear (125-135): seen; refuse while the visitor's last job (of any age) waits or runs; else dropChat (the *)
(* job rows that ended) and runAfter forget with keepRows. A clear while clear's last forget runs merges with it:  *)
(* deleteConversation twice is the same as once.                                                                 *)
ClearChat(v) ==
  /\ Clear /\ Req(v) /\ Seen(v)
  /\ IF Active(v) THEN UNCHANGED <<jst, cpc>>
     ELSE jst' = [jst EXCEPT ![v] = "none"] /\ cpc' = [cpc EXCEPT ![v] = "c1"]
  /\ UNCHANGED <<jage, jat, line, dup, pc, aage, fpc, sbx, sleft, login, swept, crashes>>

Go(v, s) == pc' = [pc EXCEPT ![v] = s] /\ UNCHANGED aage

(* agents.ts 47-48 *)
H1(v) ==
  /\ pc[v] = "h1" /\ Go(v, IF jst[v] = "running" THEN "h2" ELSE "idle")
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, fpc, sbx, sleft, login, swept, calls, crashes>>
(* job.ts 247-266: the conversation's kept sandbox, resumed or created (timeoutMs JOB_MS + 60 s); join the line *)
(* for the login (queue.ts inLine)                                                                               *)
H2(v) ==
  /\ pc[v] = "h2"
  /\ sbx' = [sbx EXCEPT ![v] = "run"] /\ sleft' = [sleft EXCEPT ![v] = J + 1]
  /\ lline' = Append(lline, v)
  /\ Go(v, "h3")
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, fpc, files, fresh, wleft, hold, lage, hage, ck, due, storeOk, lost,
                 swept, calls, crashes>>
CanTake(v) ==
  /\ Len(lline) > 0 /\ lline[1] = v
  /\ IF due THEN \A w \in V : ~Live(w) ELSE \A w \in V : ~(Live(w) /\ hold[w] = "alone")
Drop1(s, v) == SelectSeq(s, LAMBDA x : x # v)
(* job.ts 280-285 -> login-stored.ts load (164-193) and take (119-142): first in line, take the lease (alone while *)
(* the login is due), write the files, start the watcher, setTimeout. LW > 0: give up after LW minutes.          *)
H3(v) ==
  /\ pc[v] = "h3"
  /\ IF sbx[v] # "run"
     THEN lline' = Drop1(lline, v) /\ Go(v, "h5") /\ UNCHANGED <<files, hold, lage, wleft, sleft, hage>>
     ELSE IF CanTake(v)
     THEN /\ lline' = Drop1(lline, v)
          /\ hold' = [hold EXCEPT ![v] = IF due THEN "alone" ELSE "shared"] /\ lage' = [lage EXCEPT ![v] = 0]
          /\ files' = [files EXCEPT ![v] = TRUE] /\ wleft' = [wleft EXCEPT ![v] = J + 1]
          /\ sleft' = [sleft EXCEPT ![v] = J + 1] /\ hage' = [hage EXCEPT ![v] = 0]
          /\ Go(v, "h4")
     ELSE /\ LW > 0 /\ aage[v] >= LW
          /\ lline' = Drop1(lline, v) /\ Go(v, "h5") /\ UNCHANGED <<files, hold, lage, wleft, sleft, hage>>
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, fpc, sbx, fresh, ck, due, storeOk, lost, swept, calls, crashes>>
(* Codex refreshes the login in a job that holds it alone, while it is due: the stored refresh token stops working *)
Refresh(v) ==
  /\ pc[v] = "h4" /\ hold[v] = "alone" /\ files[v] /\ sbx[v] = "run" /\ due /\ storeOk /\ ~fresh[v]
  /\ fresh' = [fresh EXCEPT ![v] = TRUE] /\ storeOk' = FALSE
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, pc, aage, fpc, sbx, sleft, files, wleft, hold, lage, lline, hage, ck,
                 due, lost, swept, calls, crashes>>
Save(v) ==
  /\ fresh' = [fresh EXCEPT ![v] = FALSE] /\ storeOk' = TRUE /\ due' = FALSE
(* job.ts 287-291 -> login-stored.ts checkpoint (199-208): once a minute, save a refresh *)
Checkpoint(v) ==
  /\ pc[v] = "h4" /\ ck[v]
  /\ ck' = [ck EXCEPT ![v] = FALSE]
  /\ IF fresh[v] /\ files[v] /\ sbx[v] = "run" THEN Save(v) ELSE UNCHANGED <<fresh, storeOk, due>>
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, pc, aage, fpc, sbx, sleft, files, wleft, hold, lage, lline, hage,
                 lost, swept, calls, crashes>>
(* the harness ends (at most JOB_MS), or at once when its sandbox went *)
H4(v) ==
  /\ pc[v] = "h4" /\ ~ck[v]
  /\ Go(v, "h5")
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, fpc, sbx, sleft, login, swept, calls, crashes>>
(* job.ts 225-242 close: release (save a refresh, remove the files, give the lease), pause *)
H5(v) ==
  /\ pc[v] = "h5"
  /\ IF fresh[v] /\ files[v] /\ sbx[v] = "run" THEN Save(v) ELSE UNCHANGED <<fresh, storeOk, due>>
  /\ files' = [files EXCEPT ![v] = FALSE]
  /\ hold' = [hold EXCEPT ![v] = "none"]
  /\ sbx' = [sbx EXCEPT ![v] = IF sbx[v] = "run" THEN "paused" ELSE sbx[v]] /\ sleft' = [sleft EXCEPT ![v] = 0]
  /\ Go(v, "h6")
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, fpc, wleft, lage, lline, hage, ck, lost, swept, calls, crashes>>
(* agents.ts 80 -> help.ts endJob (151-165): the job ends, pump *)
H6(v) ==
  /\ pc[v] = "h6"
  /\ IF jst[v] = "running" THEN Pump([jst EXCEPT ![v] = "done"], line, [pc EXCEPT ![v] = "idle"], aage)
     ELSE Go(v, "idle") /\ UNCHANGED <<jst, jage, line>>
  /\ UNCHANGED <<row, seen, req, jat, dup, fsince, cpc, fpc, sbx, sleft, login, swept, calls, crashes>>

(* forget (agents.ts 104-110): deleteConversation, its sandbox goes (a job in it ends); then drop (help.ts 252-259),*)
(* not for clear's forget (keepRows)                                                                               *)
K1(v) ==
  /\ fpc[v] = "k1"
  /\ sbx' = [sbx EXCEPT ![v] = "none"] /\ sleft' = [sleft EXCEPT ![v] = 0]
  /\ files' = [files EXCEPT ![v] = FALSE] /\ fresh' = [fresh EXCEPT ![v] = FALSE]
  /\ lost' = (lost \/ fresh[v])
  /\ fpc' = [fpc EXCEPT ![v] = "k2"]
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, pc, aage, wleft, hold, lage, lline, hage, ck, due, storeOk,
                 swept, calls, crashes>>
(* FixForget: drop deletes nothing when the visitor's seen changed since the sweep set it *)
K2(v) ==
  /\ fpc[v] = "k2"
  /\ IF FixForget /\ fsince[v] THEN UNCHANGED <<row, jst>>
     ELSE row' = [row EXCEPT ![v] = FALSE] /\ jst' = [jst EXCEPT ![v] = IF Active(v) THEN jst[v] ELSE "none"]
  /\ fpc' = [fpc EXCEPT ![v] = "idle"]
  /\ UNCHANGED <<seen, req, jage, jat, line, dup, fsince, cpc, pc, aage, sbx, sleft, login, swept, calls, crashes>>
(* clear's forget: deleteConversation only (keepRows) *)
C1(v) ==
  /\ cpc[v] = "c1"
  /\ sbx' = [sbx EXCEPT ![v] = "none"] /\ sleft' = [sleft EXCEPT ![v] = 0]
  /\ files' = [files EXCEPT ![v] = FALSE] /\ fresh' = [fresh EXCEPT ![v] = FALSE]
  /\ lost' = (lost \/ fresh[v])
  /\ cpc' = [cpc EXCEPT ![v] = "idle"]
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, pc, aage, fpc, wleft, hold, lage, lline, hage, ck,
                 due, storeOk, swept, calls, crashes>>

Step(v) == H1(v) \/ H2(v) \/ H3(v) \/ Refresh(v) \/ Checkpoint(v) \/ H4(v) \/ H5(v) \/ H6(v)
FStep(v) == K1(v) \/ K2(v) \/ C1(v)

Die(v) ==
  /\ Crash /\ crashes < MaxCrash /\ pc[v] \notin Idle
  /\ pc' = [pc EXCEPT ![v] = "dead"] /\ crashes' = crashes + 1
  /\ UNCHANGED <<row, seen, req, jst, jage, jat, line, dup, fsince, cpc, aage, fpc, sbx, sleft, login, swept, calls>>

(* help.ts sweep (228-249) *)
Sweep ==
  /\ ~swept /\ swept' = TRUE
  /\ LET js1 == [v \in V |-> IF jst[v] = "running" /\ jage[v] >= S THEN "failed" ELSE jst[v]]
         stale == {v \in V : F > 0 /\ row[v] /\ seen[v] > F}
         Q == IF FixForget THEN {v \in stale : js1[v] = "queued"} ELSE {}
         Rn == IF FixForget THEN {v \in stale : js1[v] = "running"} ELSE {}
         Fg == {v \in stale \ Rn : fpc[v] = "idle"}
         js2 == [v \in V |-> IF v \in Q THEN "failed" ELSE js1[v]]
     IN /\ seen' = [v \in V |-> IF v \in Rn THEN F ELSE IF v \in stale THEN Max0(F - 10) ELSE seen[v]]
        /\ fpc' = [v \in V |-> IF v \in Fg THEN "k1" ELSE fpc[v]]
        /\ fsince' = [v \in V |-> IF v \in Fg THEN FALSE ELSE fsince[v]]
        /\ Pump(js2, SelectSeq(line, LAMBDA x : x \notin Q), pc, aage)
  /\ UNCHANGED <<row, req, jat, dup, cpc, sbx, sleft, login, calls, crashes>>

Urgent(v) ==
  \/ pc[v] \in {"h1", "h2", "h5", "h6"}
  \/ pc[v] = "h3" /\ (sbx[v] # "run" \/ CanTake(v) \/ (LW > 0 /\ aage[v] >= LW))
  \/ pc[v] = "h4" /\ (ck[v] \/ hage[v] >= J \/ sbx[v] # "run")
  \/ fpc[v] # "idle"
  \/ cpc[v] # "idle"

(* one minute: ages, E2B's timers (the watcher removes the files first), the action limit, dead line tickets *)
Tick ==
  /\ swept /\ swept' = FALSE
  /\ \A v \in V : ~Urgent(v)
  /\ LET killed == {v \in V : pc[v] \notin Idle /\ aage[v] + 1 >= A}
         gone == {v \in V : files[v] /\ wleft[v] = 1}     \* the watcher's time is up
         alive(v) == pc[v] \notin Idle /\ v \notin killed
     IN /\ seen' = [v \in V |-> IF F > 0 THEN Sat(seen[v], F + 1) ELSE 0]
        /\ req' = [v \in V |-> IF F > 0 THEN Sat(req[v], F) ELSE 0]
        /\ jage' = [v \in V |-> IF jst[v] = "running" THEN Sat(jage[v], S) ELSE jage[v]]
        /\ jat' = [v \in V |-> IF F > 0 /\ Active(v) THEN Sat(jat[v], F) ELSE jat[v]]
        /\ aage' = [v \in V |-> IF pc[v] \notin Idle THEN Sat(aage[v], A) ELSE aage[v]]
        /\ pc' = [v \in V |-> IF v \in killed THEN "dead" ELSE pc[v]]
        /\ files' = [v \in V |-> files[v] /\ v \notin gone]
        /\ lost' = (lost \/ \E v \in gone : fresh[v])
        /\ fresh' = [v \in V |-> fresh[v] /\ v \notin gone]
        /\ wleft' = [v \in V |-> Max0(wleft[v] - 1)]
        /\ sleft' = [v \in V |-> Max0(sleft[v] - 1)]
        /\ sbx' = [v \in V |-> IF sbx[v] = "run" /\ sleft[v] <= 1 THEN "paused" ELSE sbx[v]]
        /\ lage' = [v \in V |-> IF hold[v] # "none" THEN Sat(lage[v], LL) ELSE lage[v]]
        /\ hage' = [v \in V |-> IF pc[v] = "h4" THEN Sat(hage[v], J) ELSE hage[v]]
        /\ ck' = [v \in V |-> pc[v] = "h4" /\ alive(v)]
        /\ lline' = SelectSeq(lline, LAMBDA x : alive(x))
  /\ UNCHANGED <<row, jst, line, dup, fsince, cpc, fpc, hold, due, storeOk, calls, crashes>>

Next == (\E v \in V : Ask(v) \/ ClearChat(v) \/ Step(v) \/ FStep(v) \/ Die(v)) \/ Sweep \/ Tick

Fairness == WF_vars(Sweep) /\ WF_vars(Tick) /\ \A v \in V : WF_vars(Step(v)) /\ WF_vars(FStep(v))
Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

(* R1.4: never two sandboxes with the owner's login files while the login is due (two CLIs may refresh it) *)
OneRefresher == due => Cardinality({v \in V : files[v]}) <= 1
(* a refresh that Codex made is saved before its files go: else the owner's login stops working for every visitor *)
NoLostRefresh == ~lost
(* never more than MAX_SANDBOXES jobs' sandboxes run *)
HelpCap == Cardinality({v \in V : sbx[v] = "run"}) <= MAX
(* the conversation's sandbox of a visitor whose row is gone, while no action of the visitor runs *)
NoOrphan == \A v \in V : sbx[v] # "none" => row[v] \/ pc[v] \notin Idle \/ fpc[v] # "idle" \/ cpc[v] # "idle"
(* a visitor has one job in line or running *)
OneJobPerVisitor == \A v \in V : ~dup[v]
LineMoves == \A v \in V : (jst[v] = "queued") ~> (jst[v] # "queued")
=============================================================================
