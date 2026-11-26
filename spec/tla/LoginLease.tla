---------------------------- MODULE LoginLease ----------------------------
(***************************************************************************)
(* The stored AI login of one user and harness (src/login-stored.ts): the *)
(* lease (one job alone, or jobs that share it, and `want`), take() with  *)
(* its second read of the login's version, give(), the saves with         *)
(* compare-and-set (checkpoint, release, the loan of a kept sandbox),     *)
(* accept(), and the lab, which rotates the refresh token at each refresh *)
(* and refuses the one before. A user may sign in again at any time       *)
(* (cliLogin's finish: store.put, with no lease).                         *)
(*                                                                         *)
(* One step of time is about a minute. LeaseExtra is the lease's margin   *)
(* beyond the job's time (5 min in the code). A token is due Life steps   *)
(* after its refresh (the CLIs refresh 5 min before the end: refreshDue). *)
(*                                                                         *)
(* Actions and the code they stand for (d7c34b7):                          *)
(*   Arrive     a job asks for the login: login-stored.ts load 164-166,    *)
(*              take 119-121, and inLine's first read (queue.ts 115-118)   *)
(*   ReadLogin  take 122-125: get the login, open it, decide to share      *)
(*              (refreshDue(login) - now > leaseMs, and `parallel`)        *)
(*   ReadLease  take 126: get the lease, readLease drops what ran out      *)
(*   CasLease   take 127-131 (free: compare-and-set the lease), 139 (set   *)
(*              `want` for 5 s), 136/140 (return undefined: the line's     *)
(*              loop sleeps, queue.ts 125-132, and tries again)            *)
(*   Check      take 133-134: the login's version again; give() if it moved*)
(*   Load       load 169-189: the loan (171-178), its put (179), the files *)
(*              (180-181), the watcher (182-188), held (189); and          *)
(*              inLine's leave (queue.ts 135) before take returned         *)
(*   Refresh    the CLI (harness/*.ts: it refreshes 5 min before the end, *)
(*              and the lab rotates the refresh token)                     *)
(*   Checkpoint job.ts 290 -> checkpoint 205-214                           *)
(*   HarnessEnds the harness ends (job.ts 399-417, stream 519-524)         *)
(*   Release    release 215-230: read, accept, save, rm, the loan's delete *)
(*   GiveLease  release 231 -> give 143-152 (update: get and CAS in a loop) *)
(*   Die        the backend dies between two of its steps                 *)
(*   Watch      the dead job's watcher (load 187)                          *)
(*   SignIn     cliLogin finish -> signedIn 156-160: store.put, no lease    *)
(*   Tick       about a minute passes                                      *)
(* Since the first pass (fdd8347) only load's deadline changed in this    *)
(* code (168: the time it waited in line is added); this model has no     *)
(* watcher deadline (JobTiming.tla has), so its steps are the same.       *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - The login line (queue.ts) is optional (Line): without it, any        *)
(*    waiting job may try to take, a superset of what the code does, so   *)
(*    the safety checks hold for the line too; with Line, BoundedWait and *)
(*    GetsLogin check its order. A live waiter's ticket never runs out (it *)
(*    renews it at half its 30 s, queue.ts 125); a dead waiter's runs out *)
(*    at the next step (TICKET_MS = 30 s is less than a step).            *)
(*  - A backend's step takes less than a step of time, and a waiting job  *)
(*    tries again at the next step (the code polls every 0.5 to 2 s, and  *)
(*    `want` lasts 5 s: a job that wants the login alone renews it at     *)
(*    each poll, here at each step).                                      *)
(*  - Steps merged, with why it is sound: Check and its give() (the lease *)
(*    is this job's, so nobody else can take it in between; a death       *)
(*    between them leaves the lease until it runs out, as a death at      *)
(*    Check does); Load's store calls and writes (the job holds the lease *)
(*    and its sandbox; its saves are compare-and-set on the version, so a *)
(*    sign-in in between only makes them fail, as it does before the     *)
(*    step); Release's read, save and rm (one sandbox, one job).          *)
(*  - The harness starts when load ends, and runs at most T steps. A dead *)
(*    backend's CLI runs on until then.                                    *)
(*  - Each backend's clock is the true one plus its skew (0 or Skew); the *)
(*    CLI in the sandbox uses the true clock.                              *)
(*  - A login file is one record: account, refresh token, when it was     *)
(*    refreshed (`fresh`) and when it is due. The CLI may refresh early on *)
(*    a 401 only with Early401.                                            *)
(*  - Kept: all jobs run in one kept sandbox, one at a time (the slot,    *)
(*    which JobTiming.tla checks); the next job comes after the CLI of a  *)
(*    dead job stopped. Watcher: the dead job's watcher removed the files *)
(*    before then (as in the code, where the slot's lease outlasts it).   *)
(*  - Store versions never repeat for a key (Postgres: one sequence;       *)
(*    Convex: the row id; memoryStore: one counter).                       *)
(*  - Not modeled: signOut's load with `alone` (241), listModels' login   *)
(*    (job.ts 470, 480), waitMs (a job that gives up leaves the line).    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Jobs,
  T,            \* the job's time (jobTimeoutMs)
  LeaseExtra,   \* the lease beyond it: 5 min
  Life,         \* a token is due this long after its refresh
  InitDue,      \* when the first login is due
  MaxTime,
  Parallel,     \* storedLogin's `parallel` (default true)
  Line,         \* only the first job in line takes (queue.ts)
  Kept,         \* the jobs share one kept sandbox (the loan record)
  Watcher,      \* a dead job's watcher removes its files before the next job
  Crash,        \* a backend may die
  Skew,         \* a backend's clock may be this far ahead
  Early401,     \* a CLI may refresh before its token is due (a 401)
  SignIns,      \* how many times the user may sign in again (a new grant: its tokens are new)
  ArriveBy,     \* jobs come until then
  None          \* a model value: no record
Accounts == {"a", "b"}
Max(a, b) == IF a > b THEN a ELSE b
Sbx(j) == IF Kept THEN "s" ELSE j
Sandboxes == {Sbx(j) : j \in Jobs}

VARIABLES
  clock, skew,
  pc,       \* each job's step
  arr,      \* when it came
  ord,      \* its place in the line: the line's order
  polled,   \* it tried to take in this step of time, and tries again at the next
  tk,       \* a dead waiter's ticket in the line: it runs out then
  lv, lt,   \* the login's version and content that take read
  share,    \* take decided to share
  lread,    \* the lease (and its version) that take read
  held,     \* the version and login that the job's sandbox got: [ver, rec]
  th,       \* when its harness started
  cli,      \* its CLI runs
  files,    \* the login files in each sandbox: a login record, or None
  loan,     \* the loan record of each sandbox: a version, or 0
  login,    \* the store's login entry: [ver, rec], or None
  lease,    \* the store's lease entry: [ver, alone, shared, want]
  nver,     \* the store's next version
  used,     \* the lab: the refresh tokens that a refresh used up (it rotates them), with the job whose CLI did
  nrt,      \* the lab's next token
  signins,  \* sign-ins so far
  raced,    \* a CLI refreshed with a token that another refresh had revoked
  regress   \* a save put an older login, or another account's, over the stored one

vars == <<clock, skew, pc, arr, ord, polled, tk, lv, lt, share, lread, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

Now(j) == clock + skew[j]
LeaseMs == T + LeaseExtra
NoLease == [alone |-> None, shared |-> {}, want |-> 0]

\* readLease: the parts that have not run out by the reader's clock
Live(l, t) == [alone |-> IF l.alone # None /\ l.alone.until > t THEN l.alone ELSE None,
               shared |-> {x \in l.shared : x.until > t},
               want |-> IF l.want > t THEN l.want ELSE 0]

\* accept(): the CLI changed the files, and they are the same account's and not older
Accept(stored, found) ==
  /\ found # None /\ found # stored
  /\ found.acct = stored.acct /\ found.fresh >= stored.fresh

Waiting(j) == pc[j] \in {"login", "lease", "cas", "check"}
\* queue.ts 116-119: only the first live ticket tries; a dead waiter's ticket stays until it runs out
InLine(k) == Waiting(k) \/ (pc[k] = "dead" /\ tk[k] > clock)
MayTry(j) == ~Line \/ \A k \in Jobs \ {j} : InLine(k) => ord[k] > ord[j]

Init ==
  /\ clock = 0
  /\ skew \in [Jobs -> {0, Skew}]
  /\ pc = [j \in Jobs |-> "idle"]
  /\ arr = [j \in Jobs |-> 0]
  /\ ord = [j \in Jobs |-> 0]
  /\ polled = [j \in Jobs |-> FALSE]
  /\ tk = [j \in Jobs |-> 0]
  /\ lv = [j \in Jobs |-> 0]
  /\ lt = [j \in Jobs |-> None]
  /\ share = [j \in Jobs |-> FALSE]
  /\ lread = [j \in Jobs |-> None]
  /\ held = [j \in Jobs |-> None]
  /\ th = [j \in Jobs |-> 0]
  /\ cli = [j \in Jobs |-> FALSE]
  /\ files = [s \in Sandboxes |-> None]
  /\ loan = [s \in Sandboxes |-> 0]
  /\ login = [ver |-> 1, rec |-> [acct |-> "a", rt |-> 1, fresh |-> 0, due |-> InitDue]]
  /\ lease = [ver |-> 0] @@ NoLease
  /\ nver = 2
  /\ used = {}
  /\ nrt = 2
  /\ signins = 0
  /\ raced = FALSE
  /\ regress = FALSE

\* the slot: a job of a kept sandbox starts after the job before it closed, or died and its CLI stopped
SlotFree(j) ==
  ~Kept \/ \A k \in Jobs \ {j} :
    \/ pc[k] \in {"idle", "done"}
    \/ (pc[k] = "dead" /\ ~cli[k] /\ (Watcher => files[Sbx(k)] = None \/ held[k] = None))

Arrive(j) ==
  /\ pc[j] = "idle" /\ SlotFree(j) /\ clock <= ArriveBy
  /\ pc' = [pc EXCEPT ![j] = "login"]
  /\ arr' = [arr EXCEPT ![j] = clock]
  /\ ord' = [ord EXCEPT ![j] = 1 + Max(ord[CHOOSE k \in Jobs : \A i \in Jobs : ord[i] <= ord[k]], 0)]
  /\ UNCHANGED <<clock, skew, tk, polled, lv, lt, share, lread, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* take, 1: read the login and decide whether this job may share it
ReadLogin(j) ==
  /\ pc[j] = "login" /\ ~polled[j] /\ MayTry(j)
  /\ IF login = None
     THEN /\ pc' = [pc EXCEPT ![j] = "done"]   \* "not signed in": the job fails
          /\ UNCHANGED <<lv, lt, share>>
     ELSE /\ lv' = [lv EXCEPT ![j] = login.ver]
          /\ lt' = [lt EXCEPT ![j] = login.rec]
          /\ share' = [share EXCEPT ![j] = Parallel /\ login.rec.due - Now(j) > LeaseMs]
          /\ pc' = [pc EXCEPT ![j] = "lease"]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lread, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* take, 2: read the lease
ReadLease(j) ==
  /\ pc[j] = "lease"
  /\ lread' = [lread EXCEPT ![j] = [ver |-> lease.ver] @@ Live(lease, Now(j))]
  /\ pc' = [pc EXCEPT ![j] = "cas"]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lv, lt, share, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* take, 3: compare-and-set the lease; or set `want`; or try again at the next poll
CasLease(j) ==
  /\ pc[j] = "cas"
  /\ LET l == lread[j]
         free == l.alone = None /\ IF share[j] THEN l.want = 0 ELSE l.shared = {}
         until == Now(j) + LeaseMs
         mine == IF share[j] THEN [ver |-> nver, alone |-> None, shared |-> l.shared \cup {[id |-> j, until |-> until]}, want |-> 0]
                 ELSE [ver |-> nver, alone |-> [id |-> j, until |-> until], shared |-> {}, want |-> 0]
         wanted == [ver |-> nver, alone |-> l.alone, shared |-> l.shared, want |-> Now(j) + 1]
     IN IF free
        THEN IF lease.ver = l.ver
             THEN /\ lease' = mine /\ nver' = nver + 1
                  /\ pc' = [pc EXCEPT ![j] = "check"]
                  /\ UNCHANGED polled
             ELSE /\ pc' = [pc EXCEPT ![j] = "login"] /\ polled' = [polled EXCEPT ![j] = TRUE]
                  /\ UNCHANGED <<lease, nver>>
        ELSE /\ IF ~share[j] /\ l.alone = None /\ l.want = 0 /\ lease.ver = l.ver
                THEN lease' = wanted /\ nver' = nver + 1
                ELSE UNCHANGED <<lease, nver>>
             /\ pc' = [pc EXCEPT ![j] = "login"] /\ polled' = [polled EXCEPT ![j] = TRUE]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, lv, lt, share, lread, held, th, cli, files, loan, login, used, nrt, signins, raced, regress>>

\* give(): update() removes the job from the lease (it reads the lease and writes it in one compare-and-set)
Give(j, l) ==
  LET k == Live(l, Now(j)) IN
  IF k.alone # None /\ k.alone.id = j THEN [ver |-> nver, alone |-> None, shared |-> k.shared, want |-> k.want]
  ELSE IF \E x \in k.shared : x.id = j THEN [ver |-> nver, alone |-> k.alone, shared |-> {x \in k.shared : x.id # j}, want |-> k.want]
  ELSE l

GiveBack(j) ==
  /\ lease' = Give(j, lease)
  /\ nver' = IF Give(j, lease) = lease THEN nver ELSE nver + 1

\* take, 4: the login's version again; a refresh saved between the two reads: give the lease back, decide again
Check(j) ==
  /\ pc[j] = "check"
  /\ IF login # None /\ login.ver = lv[j]
     THEN /\ pc' = [pc EXCEPT ![j] = "load"]
          /\ UNCHANGED <<lease, nver, polled>>
     ELSE /\ GiveBack(j)
          /\ pc' = [pc EXCEPT ![j] = "login"] /\ polled' = [polled EXCEPT ![j] = TRUE]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, lv, lt, share, lread, held, th, cli, files, loan, login, used, nrt, signins, raced, regress>>

\* save(): compare-and-set on the version the job has; true when it wrote
Saved(ver, rec) == login # None /\ login.ver = ver
\* a save that passed accept() against the login of `ver`; flags a save over a newer or other account's login
Regress(rec) == login # None /\ (rec.acct # login.rec.acct \/ rec.fresh < login.rec.fresh)

\* load: under the lease, the loan of a dead job first, then the files and the harness
Load(j) ==
  /\ pc[j] = "load"
  /\ LET s == Sbx(j)
         left == files[s]
         useLoan == Kept /\ loan[s] = lv[j] /\ loan[s] # 0 /\ Accept(lt[j], left) /\ Saved(lv[j], left)
         ver == IF useLoan THEN nver ELSE lv[j]
         rec == IF useLoan THEN left ELSE lt[j]
     IN /\ login' = IF useLoan THEN [ver |-> nver, rec |-> left] ELSE login
        /\ regress' = (regress \/ (useLoan /\ Regress(left)))
        /\ nver' = IF useLoan THEN nver + 1 ELSE nver
        /\ loan' = [loan EXCEPT ![s] = ver]
        /\ files' = [files EXCEPT ![s] = rec]
        /\ held' = [held EXCEPT ![j] = [ver |-> ver, rec |-> rec]]
  /\ cli' = [cli EXCEPT ![j] = TRUE]
  /\ th' = [th EXCEPT ![j] = clock]
  /\ pc' = [pc EXCEPT ![j] = "run"]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lv, lt, share, lread, lease, used, nrt, signins, raced>>

\* the CLI refreshes: when its token is due, or (Early401) at any time. The lab rotates the refresh token.
Refresh(j) ==
  LET s == Sbx(j) IN
  /\ cli[j] /\ files[s] # None
  /\ clock >= files[s].due \/ Early401
  /\ IF files[s].rt \notin {u.rt : u \in used}
     THEN /\ used' = used \cup {[rt |-> files[s].rt, by |-> j]}
          /\ files' = [files EXCEPT ![s] = [acct |-> files[s].acct, rt |-> nrt, fresh |-> clock, due |-> clock + Life]]
          /\ nrt' = nrt + 1
          /\ UNCHANGED raced
     \* the lab refuses a used-up token. A race: the CLI that used it up still runs, in another sandbox. (Else the
     \* refresh it got was lost: LoginWorks.)
     ELSE /\ raced' = (raced \/ \E u \in used : u.rt = files[s].rt /\ u.by # j /\ cli[u.by])
          /\ UNCHANGED <<used, files, nrt>>
  /\ UNCHANGED <<clock, skew, tk, pc, arr, ord, polled, lv, lt, share, lread, held, th, cli, loan, login, lease, nver, signins, regress>>

\* checkpoint, about every minute: saves what the CLI changed, and moves the loan to the new version
Checkpoint(j) ==
  LET s == Sbx(j) IN
  /\ pc[j] = "run" /\ Accept(held[j].rec, files[s])
  /\ IF Saved(held[j].ver, files[s])
     THEN /\ login' = [ver |-> nver, rec |-> files[s]]
          /\ regress' = (regress \/ Regress(files[s]))
          /\ held' = [held EXCEPT ![j] = [ver |-> nver, rec |-> files[s]]]
          /\ loan' = [loan EXCEPT ![s] = nver]
          /\ nver' = nver + 1
     ELSE UNCHANGED <<login, regress, held, loan, nver>>
  /\ UNCHANGED <<clock, skew, tk, pc, arr, ord, polled, lv, lt, share, lread, th, cli, files, lease, used, nrt, signins, raced>>

\* the harness ends (it finished, or its time ran out)
HarnessEnds(j) ==
  /\ cli[j]
  /\ cli' = [cli EXCEPT ![j] = FALSE]
  /\ pc' = IF pc[j] = "run" THEN [pc EXCEPT ![j] = "release"] ELSE pc
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lv, lt, share, lread, held, th, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* release, 1: save what the CLI changed, remove the files, delete the loan
Release(j) ==
  LET s == Sbx(j) IN
  /\ pc[j] = "release"
  /\ IF Accept(held[j].rec, files[s]) /\ Saved(held[j].ver, files[s])
     THEN /\ login' = [ver |-> nver, rec |-> files[s]]
          /\ regress' = (regress \/ Regress(files[s]))
          /\ nver' = nver + 1
     ELSE UNCHANGED <<login, regress, nver>>
  /\ files' = [files EXCEPT ![s] = None]
  /\ loan' = [loan EXCEPT ![s] = 0]
  /\ pc' = [pc EXCEPT ![j] = "give"]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lv, lt, share, lread, held, th, cli, lease, used, nrt, signins, raced>>

\* release, 2: give the lease back
GiveLease(j) ==
  /\ pc[j] = "give"
  /\ GiveBack(j)
  /\ pc' = [pc EXCEPT ![j] = "done"]
  /\ UNCHANGED <<clock, skew, tk, arr, ord, polled, lv, lt, share, lread, held, th, cli, files, loan, login, used, nrt, signins, raced, regress>>

\* the backend dies: no step of this job runs again; its CLI runs on
Die(j) ==
  /\ Crash /\ pc[j] \notin {"idle", "done", "dead"}
  /\ pc' = [pc EXCEPT ![j] = "dead"]
  /\ tk' = IF Waiting(j) THEN [tk EXCEPT ![j] = clock + 1] ELSE tk
  /\ UNCHANGED <<clock, skew, arr, ord, polled, lv, lt, share, lread, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* the dead job's watcher removes the files in its sandbox once its CLI stopped
Watch(j) ==
  /\ Watcher /\ pc[j] = "dead" /\ ~cli[j] /\ held[j] # None /\ files[Sbx(j)] # None
  /\ files' = [files EXCEPT ![Sbx(j)] = None]
  /\ UNCHANGED <<clock, skew, tk, pc, arr, ord, polled, lv, lt, share, lread, held, th, cli, loan, login, lease, nver, used, nrt, signins, raced, regress>>

\* the user signs in again (finishLogin: store.put, with no lease), maybe to another account
SignIn ==
  /\ signins < SignIns
  /\ \E a \in Accounts : login' = [ver |-> nver, rec |-> [acct |-> a, rt |-> nrt, fresh |-> clock, due |-> clock + Life]]
  /\ nver' = nver + 1 /\ nrt' = nrt + 1 /\ signins' = signins + 1
  /\ UNCHANGED <<clock, skew, tk, pc, arr, ord, polled, lv, lt, share, lread, held, th, cli, files, loan, lease, used, raced, regress>>

\* a live backend acts within the step; a due CLI refreshes; a harness at its time ends
Urgent ==
  \/ \E j \in Jobs : pc[j] \in {"lease", "cas", "check", "load", "release", "give"}
  \/ \E j \in Jobs : pc[j] = "login" /\ ~polled[j] /\ MayTry(j)
  \* a due CLI refreshes (one whose refresh token is used up fails, and time goes on)
  \/ \E j \in Jobs : cli[j] /\ files[Sbx(j)] # None /\ clock >= files[Sbx(j)].due /\ files[Sbx(j)].rt \notin {u.rt : u \in used}
  \/ \E j \in Jobs : cli[j] /\ clock >= th[j] + T
  \/ \E j \in Jobs : pc[j] = "run" /\ Accept(held[j].rec, files[Sbx(j)]) /\ Saved(held[j].ver, files[Sbx(j)])

Tick ==
  /\ clock < MaxTime /\ ~Urgent
  /\ clock' = clock + 1
  /\ polled' = [j \in Jobs |-> FALSE]
  /\ UNCHANGED <<skew, tk, pc, arr, ord, lv, lt, share, lread, held, th, cli, files, loan, login, lease, nver, used, nrt, signins, raced, regress>>

Next ==
  \/ Tick \/ SignIn
  \/ \E j \in Jobs : Arrive(j) \/ ReadLogin(j) \/ ReadLease(j) \/ CasLease(j) \/ Check(j) \/ Load(j) \/ Refresh(j)
                     \/ Checkpoint(j) \/ HarnessEnds(j) \/ Release(j) \/ GiveLease(j) \/ Die(j) \/ Watch(j)

Spec == Init /\ [][Next]_vars

\* the steps of job j's own backend (none once it died: pc = "dead" enables none of them)
Own(j) == ReadLogin(j) \/ ReadLease(j) \/ CasLease(j) \/ Check(j) \/ Load(j) \/ Checkpoint(j) \/ Release(j) \/ GiveLease(j)

(* Fairness, as the code gives it:
   - a live backend's steps (Own): WF. Each is a store call; the line's loop (queue.ts 114-133) polls with a sleep of
     0.5 to 2 s, so a waiting job that may take tries again within a step of time: ReadLogin is enabled again after
     each Tick (polled), and stays enabled while it is first in line. A dead backend gets none.
   - time (Tick): WF. The CLI's refresh when it is due (Refresh: the CLI refreshes 5 min before its token ends),
     the end of the harness at its timeout (HarnessEnds: envd's timeoutMs, `timeout -s KILL`), and the dead job's
     watcher (Watch, a `sleep` in the sandbox): WF, also after the backend died.
   - not fair: Arrive (an app may never start a job), SignIn, Die. *)
Fairness ==
  /\ WF_vars(Tick)
  /\ \A j \in Jobs : WF_vars(Own(j)) /\ WF_vars(Refresh(j)) /\ WF_vars(HarnessEnds(j)) /\ WF_vars(Watch(j))

LiveSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Safety *)

\* R1.4: two sandboxes never refresh one login: no CLI refreshes with a token that a CLI still running used up
NoRefreshRace == ~raced

\* R1.4: a save never puts an older login, or another account's, over the stored one (a sign-in may)
StoreNeverRegresses == ~regress

\* R1.4: once no job runs, the stored refresh token still works (no refresh was lost)
Quiet == \A j \in Jobs : ~cli[j] /\ pc[j] \in {"idle", "done", "dead"}
LoginWorks == (Quiet /\ login # None) => login.rec.rt \notin {u.rt : u \in used}

\* liveness as a bound: with the line, a waiting job takes the login within the time of the jobs before it
BoundedWait == \A j \in Jobs : Waiting(j) => clock - arr[j] <= Cardinality(Jobs) * (LeaseMs + 1)

(* Liveness (check with LiveSpec, and no SYMMETRY). The horizon MaxTime must leave time for every job that came by
   ArriveBy, and for the leases of the dead ones to run out: else time stops with a job still in line. *)

\* R5.8: a job that waits in line for the login takes it, or fails (not signed in), or its backend dies
GetsLogin == \A j \in Jobs : Waiting(j) ~> ~Waiting(j)
\* and every job that came ends
Ends == \A j \in Jobs : pc[j] = "login" ~> pc[j] \in {"done", "dead"}

Sym == Permutations(Jobs)
=============================================================================
