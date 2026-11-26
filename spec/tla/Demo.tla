------------------------------- MODULE Demo -------------------------------
(***************************************************************************)
(* The hosted mail demo (examples/mail/convex, at d7c34b7), for strangers: *)
(* its limits and its promise in SPEC.md ("keeps each visitor's ... login *)
(* ... for at most one hour after the visitor's last request, and then     *)
(* signs it out with the CLI and deletes it; sooner when the visitor       *)
(* clicks Sign out or Delete my data").                                    *)
(*                                                                         *)
(* What runs, in the model:                                                *)
(*  - the page's requests (demo.html): touch (every 5 minutes while it is  *)
(*    open, line 418), startJob, the sign-in (agents.login, then           *)
(*    agents.finishLogin, which the page calls again while it says         *)
(*    `pending`), agents.signOut and agents.deleteData. A visitor who left *)
(*    the page makes no request; the page gets no fairness.                *)
(*  - the Convex mutations of demo.ts (seen, pump, startJob, beginSignin,  *)
(*    seenSignin, endSignin, endJob, sweep, drop) and the query `idle`:    *)
(*    each is ONE step, because Convex runs a mutation as one serializable *)
(*    transaction ("true serializability", docs.convex.dev/database/       *)
(*    advanced/occ) and retries it on a conflict; the scheduler.runAfter   *)
(*    in it is atomic with it ("Scheduling functions from mutations is     *)
(*    atomic with the rest of the mutation", docs.convex.dev/scheduling/   *)
(*    scheduled-functions).                                                *)
(*  - the Node actions of agents.ts (runJob, forget, deleteData, signOut,  *)
(*    login, finishLogin) as processes, one of each kind per visitor, with *)
(*    each byoa call that another process can interleave with as its own   *)
(*    step. Actions are not transactions, are not retried ("actions will   *)
(*    be executed at most once", same page), may die between any two steps *)
(*    (Crash), and "time out after 10 minutes" (docs.convex.dev/functions/ *)
(*    actions): a live action that reaches A steps of time is killed.      *)
(*  - the cron (crons.ts: sweep every minute). "At most one run of each    *)
(*    cron job can be executing at any moment" (docs.convex.dev/scheduling/*)
(*    cron-jobs); here it runs once in each step of time (Sweep, then      *)
(*    Tick), and it is weakly fair.                                        *)
(*  - byoa's state of each visitor (one lab): the stored login and its     *)
(*    login state (login-stored.ts, login.ts), the lease of the login      *)
(*    (take/give), the pending sign-in entry, and the provider's sandboxes *)
(*    with their timers: the job's kept sandbox (job.ts timeoutMs = job    *)
(*    timeout + 60 s, again at setTimeout after the login; paused at the   *)
(*    end), the sign-in sandbox (create: LOGIN_MAX_MS; keepAlive: 2 min,   *)
(*    and 2 min + waitMs at each finish), and the sign-out sandbox of      *)
(*    login-stored.ts signOut (timeoutMs 5 minutes).                       *)
(*                                                                         *)
(* Fidelity: each action below names its code. A live backend's step takes*)
(* less than one step of time (Tick waits for every live action that is   *)
(* not waiting), as in the other specs of this folder; an action waits    *)
(* only for the login's lease (inLine, with no time limit: storedLogin's  *)
(* waitMs is not set) and while the harness runs.                          *)
(*                                                                         *)
(* Time: one step of time is one run of the sweep (a minute in the code). *)
(* The model scales the other times down and keeps their order: F (the    *)
(* hour, FORGET_MS and the HOUR of startJob) > R (the sweep's 10 minutes  *)
(* before it forgets again) >= A (the action limit, 10 min) ; S (STALE_JOB *)
(* 11 min) > A > J (JOB_MS, 5 min) ; SS (STALE_SIGNIN 3 min) > I + W (2 min*)
(* + the 20 s that Codex and Grok wait) ; LM (15 min) > SS ; LO (5 min).  *)
(* In ci models F is smaller than in the code (F = 2), so that two        *)
(* visitors can make a wait in line longer than the hour; in the code the *)
(* same order of events needs a longer line (about 5 jobs ahead of each   *)
(* job place: HOUR - STALE_JOB = 49 minutes).                              *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - One lab per visitor (the code has three; signOut of one lab and a    *)
(*    job of another do not touch). The budget (BUDGET_HOURS), PER_HOUR,   *)
(*    the task and the harness check of startJob are left out: they only   *)
(*    refuse. take(20) of the sweep is left out (V has at most 3).         *)
(*  - A visitor has one job record. When startJob accepts a second job    *)
(*    while one is in line or runs, the model only records it (dup) and  *)
(*    checks OneJobPerVisitor; it does not run the second job.            *)
(*  - The sweep starts forget only when the visitor's last forget action  *)
(*    has ended or died; the code would start a second one. That is sound *)
(*    while R >= A (the first one has been killed by then); TwoForgets     *)
(*    checks that it never happens.                                        *)
(*  - The scheduler starts an action in the same step of time; runJob's   *)
(*    age (for the action limit) counts from pump, when `started` is set. *)
(*  - byoa's dropPending (get, delete, destroy) is one step; byoa's job    *)
(*    `check` and `load` (take the lease, write the files, setTimeout) are *)
(*    one step (both fail the same way when the login is gone); close     *)
(*    (release: save, remove the files, give the lease; then pause) is one *)
(*    step; slots.take with resume or create is one step; deleteSandbox   *)
(*    (slots.remove) is one step that finds every sandbox of the visitor  *)
(*    that exists then (Index_*_fixed); the sign-out's CLI run and the     *)
(*    destroy of its sandbox are one step. Merging these does not hide an *)
(*    order that matters here: each merged part touches only state that   *)
(*    the other steps of the model read at the merged step's end.          *)
(*  - The sign-in is byoa's at 1a58e3c (997742e): connectLogin writes its *)
(*    entry first and names its sandbox in it only while the entry is     *)
(*    still its own; finishLogin saves the login and the state only while *)
(*    the entry is its own (whileSigningIn); dropPending ends the entry and*)
(*    keeps the sandbox it names. Each whileSigningIn (get, get, cas) is  *)
(*    one step: see G3b. finishLogin's read of the CLI's status and the   *)
(*    visitor's success on the lab's page are one choice (g3); the wait   *)
(*    loop and a CLI sign-in that fails are left out; agents.cancel and   *)
(*    cancelLogin (http.ts /cancel, the sweep's cancel) are left out: they *)
(*    are dropPending, as forgetVisitor calls it. The model's provider has *)
(*    keepAlive (E2B). On Instabox (no keepAlive) a sign-in sandbox lives *)
(*    LOGIN_MAX_MS after the demo stops counting it.                       *)
(*  - byoa's rows that hold no login (the login state, the sign-in's ended *)
(*    entry, the lease, the line, the empty slot index) are not modeled;  *)
(*    fix2.patch has drop delete them (demo.test.ts "Demo_main_touch").   *)
(*  - The login and its state are one record each; a CLI's refresh and the *)
(*    lab are left out (LoginLease.tla has them): a job's save cannot put *)
(*    back a login that signOut deleted (its cas is of a version that is  *)
(*    gone), so the model's close writes no login.                         *)
(*  - The job's sandbox gets J + 1 steps from create and from the login    *)
(*    (job.ts lines 262, 285); its setup takes less than one step.        *)
(*  - The events, mail, decisions and drafts rows and the PostHog calls    *)
(*    are left out; drop deletes them with the jobs.                        *)
(*                                                                         *)
(* Fixes (the flags are FALSE for the code at d7c34b7; 03cfc7d has        *)
(* FixForget, FixOneJob and FixOld; fix2.patch adds FixTouch):             *)
(*  FixForget: forgetVisitor signs out of every lab, also one whose state *)
(*    says signed-out; the sweep fails a forgotten visitor's job in line, *)
(*    waits while their job runs, and drop deletes nothing when the       *)
(*    visitor's stamp changed since the forget (or Delete my data's idle) *)
(*    read it; deleteData then throws. The stamp is `seen`, which every   *)
(*    request sets, also the page's touch every 5 minutes.                *)
(*  FixTouch: the stamp is `acts` instead, which only startJob,            *)
(*    beginSignin and seenSignin count: the requests that may start a      *)
(*    sandbox or save a login.                                             *)
(*  FixOneJob: startJob looks at every job of the visitor, not only those  *)
(*    of the last hour.                                                    *)
(*  FixOld: beginSignin checks the places after it ends the old sign-in.  *)
(*  FixCap: a sign-out sandbox takes a place and waits for one. Not a fix:*)
(*    the forget starves (Demo_proposal_cap_starve).                       *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS V, MAX, SIP, F, R, S, A, J, SS, I, W, LM, LO, LL, Bound,
          Crash, MaxCrash, MaxCalls, PageCalls, Return, Page, InitLogin,
          FixForget, FixTouch, FixOneJob, FixOld, FixCap

Kinds == {"run", "forget", "del", "out", "login", "fin"}
P == Kinds \X V
Idle == {"idle", "dead"}

VARIABLES
  row, seen, req,       \* the visitors row; its `seen` field (age); the ghost: steps since the visitor's last request
  since, sinceAct,      \* per action: the visitor made a request (any; one that may start a sandbox or save a login:
                        \* an act) since it read the stamp (drop compares seen, or with FixTouch acts)
  deleted, outd,        \* ghost: deleteData / signOut returned, and the visitor made no request since it began
  jst, jage, jat, line, dup, \* the visitor's job: state, age since `started`, age since `at`; the line; ghost: 2 jobs
  sr, sseen,            \* the demo's signins row is pending; its `seen` (age)
  pend, pgen, psb, sib, \* byoa's sign-in entry (loginjob/): in progress; which sign-in wrote it; it names its sandbox;
                        \* the sign-in sandbox's time left (0: none)
  login, st,            \* byoa's stored login; its login state ("in", "out")
  lh, lage,             \* the holder of the login's lease ("none", or the kind of the visitor's action), and its age
  jsb, jleft, hage,     \* the job's kept sandbox ("none", "run", "paused"), its time left, the harness's age
  los,                  \* each action's sign-out sandbox: time left (0: none)
  pc, age, mine,        \* each action: its step, its age, and the sign-in entry it wrote or read (pgen)
  swept, crashes, calls, twoForgets, delFail \* delFail: Delete my data threw with no act since it began

vis == <<row, seen, req, since, sinceAct, deleted, outd>>
jobv == <<jst, jage, jat, line, dup>>
sign == <<sr, sseen, pend, pgen, psb, sib>>
lg == <<login, st, lh, lage>>
box == <<jsb, jleft, hage, los>>
proc == <<pc, age, mine>>
glob == <<swept, crashes, calls, twoForgets, delFail>>
vars == <<vis, jobv, sign, lg, box, proc, glob>>

Min(a, b) == IF a < b THEN a ELSE b
Max0(a) == IF a < 0 THEN 0 ELSE a
Sat(x, m) == IF x >= m THEN m ELSE x + 1
Active(v) == jst[v] \in {"queued", "running"}
LeaseFree(v) == lh[v] = "none" \/ lage[v] >= LL

Init ==
  \* InitLogin: every visitor has signed in already (to shorten a model's traces)
  /\ row = [v \in V |-> InitLogin] /\ seen = [v \in V |-> 0] /\ req = [v \in V |-> 0]
  /\ since = [p \in P |-> FALSE] /\ sinceAct = [p \in P |-> FALSE] /\ deleted = [v \in V |-> FALSE] /\ outd = [v \in V |-> FALSE]
  /\ jst = [v \in V |-> "none"] /\ jage = [v \in V |-> 0] /\ jat = [v \in V |-> 0] /\ line = <<>>
  /\ dup = [v \in V |-> FALSE]
  /\ sr = [v \in V |-> FALSE] /\ sseen = [v \in V |-> 0] /\ pend = [v \in V |-> FALSE] /\ sib = [v \in V |-> 0]
  /\ pgen = [v \in V |-> 0] /\ psb = [v \in V |-> FALSE]
  /\ login = [v \in V |-> InitLogin] /\ st = [v \in V |-> IF InitLogin THEN "in" ELSE "out"] /\ lh = [v \in V |-> "none"] /\ lage = [v \in V |-> 0]
  /\ jsb = [v \in V |-> "none"] /\ jleft = [v \in V |-> 0] /\ hage = [v \in V |-> 0] /\ los = [p \in P |-> 0]
  /\ pc = [p \in P |-> "idle"] /\ age = [p \in P |-> 0] /\ mine = [p \in P |-> 0]
  /\ swept = FALSE /\ crashes = 0 /\ calls = 0 /\ twoForgets = FALSE /\ delFail = FALSE

(* demo.ts seen (lines 48-53): the visitors row, now. `act`: startJob, beginSignin, seenSignin, which count in      *)
(* `acts` with FixTouch (fix2.patch); touch does not. Only an act can start a sandbox or save a login, so only an    *)
(* act ends the ghosts deleted and outd (the page of a deleted visitor may still touch).                           *)
Seen(v, act) ==
  /\ row' = [row EXCEPT ![v] = TRUE] /\ seen' = [seen EXCEPT ![v] = 0] /\ req' = [req EXCEPT ![v] = 0]
  /\ since' = [p \in P |-> IF p[2] = v THEN TRUE ELSE since[p]]
  /\ sinceAct' = [p \in P |-> IF p[2] = v /\ act THEN TRUE ELSE sinceAct[p]]
  /\ deleted' = [deleted EXCEPT ![v] = deleted[v] /\ ~act] /\ outd' = [outd EXCEPT ![v] = outd[v] /\ ~act]

(* demo.ts usage (lines 32-40): running jobs, and pending sign-ins whose seen > now - STALE_SIGNIN_MS. With FixCap,  *)
(* also the sign-out sandboxes.                                                                                    *)
Used(js, s_r, s_s) ==
  Cardinality({v \in V : js[v] = "running"}) + Cardinality({v \in V : s_r[v] /\ s_s[v] < SS})
  + (IF FixCap THEN Cardinality({p \in P : los[p] > 0}) ELSE 0)

(* demo.ts pump (lines 56-64): free = max - signInPlaces - used; the first `free` jobs in line run, and each gets  *)
(* its runJob action (runAfter 0, atomic with the mutation).                                                       *)
Pump(js, ln, s_r, s_s, pc0, age0) ==
  LET free == MAX - SIP - Used(js, s_r, s_s)
      n == IF free <= 0 THEN 0 ELSE Min(free, Len(ln))
      G == {ln[i] : i \in 1..n}
  IN /\ jst' = [v \in V |-> IF v \in G THEN "running" ELSE js[v]]
     /\ jage' = [v \in V |-> IF v \in G THEN 0 ELSE jage[v]]
     /\ line' = SubSeq(ln, n + 1, Len(ln))
     /\ pc' = [p \in P |-> IF p[1] = "run" /\ p[2] \in G THEN "r1" ELSE pc0[p]]
     /\ age' = [p \in P |-> IF p[1] = "run" /\ p[2] \in G THEN 0 ELSE age0[p]]
     /\ UNCHANGED mine

Go(p, s) == pc' = [pc EXCEPT ![p] = s] /\ UNCHANGED <<age, mine>>

(* ---- the page's requests (demo.html); no fairness: a visitor may leave at any time *)

(* Return = FALSE: a visitor makes no request an hour or more after their last one (one who left does not come back)*)
Req(v) == calls < MaxCalls /\ calls' = calls + 1 /\ (Return \/ req[v] < F)

(* demo.ts touch (line 69); demo.html lines 417-418: every 5 minutes, also while Delete my data runs *)
Touch(v) ==
  /\ Req(v)
  /\ Seen(v, FALSE)
  /\ UNCHANGED <<jobv, sign, lg, box, proc, swept, crashes, twoForgets, delFail>>

(* demo.ts startJob (lines 98-113): seen; refuse while a job of the last HOUR waits or runs; else in line, pump *)
StartJob(v) ==
  /\ Req(v)
  /\ Seen(v, TRUE)
  /\ IF Active(v) /\ (FixOneJob \/ jat[v] < F)
     THEN UNCHANGED <<jobv, proc>>
     ELSE IF Active(v)
     THEN dup' = [dup EXCEPT ![v] = TRUE] /\ UNCHANGED <<jst, jage, jat, line, proc>>
     ELSE /\ jat' = [jat EXCEPT ![v] = 0] /\ UNCHANGED dup
          /\ Pump([jst EXCEPT ![v] = "queued"], Append(line, v), sr, sseen, pc, age)
  /\ UNCHANGED <<sign, lg, box, swept, crashes, twoForgets, delFail>>

First == [k \in Kinds |-> CASE k = "del" -> "d0" [] k = "out" -> "o0" [] k = "login" -> "l1" [] k = "fin" -> "g1"
                            [] OTHER -> "idle"]
(* the page calls an action: agents.deleteData, signOut, login, finishLogin (PageCalls: the ones a model lets the *)
(* page call; a subset of {"del", "out", "login", "fin"})                                                        *)
Begin(p) ==
  /\ p[1] \in PageCalls
  /\ pc[p] \in Idle /\ los[p] = 0
  \* Page: one tab of demo.html, which calls finishLogin only after login returned the lab's page (lines 354-374),
  \* and starts a sign-in only when its last one is done
  /\ (Page /\ p[1] = "fin") => pc[<<"login", p[2]>>] \in Idle /\ pend[p[2]] /\ psb[p[2]]
  /\ (Page /\ p[1] = "login") => pc[<<"fin", p[2]>>] \in Idle
  /\ Req(p[2])
  /\ pc' = [pc EXCEPT ![p] = First[p[1]]] /\ age' = [age EXCEPT ![p] = 0]
  /\ UNCHANGED <<vis, mine, jobv, sign, lg, box, swept, crashes, twoForgets, delFail>>

(* ---- runJob (agents.ts lines 77-97), with byoa's run (job.ts) *)

(* agents.ts 80-81: runQuery(demo.job); returns unless the job runs *)
R1(p) ==
  /\ p[1] = "run" /\ pc[p] = "r1"
  /\ Go(p, IF jst[p[2]] = "running" THEN "r2" ELSE "idle")
  /\ UNCHANGED <<vis, jobv, sign, lg, box, glob>>
(* job.ts 247-266: slots.take, resume the kept sandbox or create it (timeoutMs: job timeout + 60 s). A lab login's *)
(* `ready` does nothing (credential.ts 43), so the sandbox starts before byoa looks for the login.                 *)
R2(p) ==
  /\ p[1] = "run" /\ pc[p] = "r2"
  /\ jsb' = [jsb EXCEPT ![p[2]] = "run"] /\ jleft' = [jleft EXCEPT ![p[2]] = J + 1]
  /\ Go(p, "r3")
  /\ UNCHANGED <<vis, jobv, sign, lg, hage, los, glob>>
(* job.ts 273 (cred.check: the stored login is there), 280 (load: take the lease in line, write the files;      *)
(* login-stored.ts 164-193), 285 (setTimeout: job timeout + 60 s). Fails when the login or the sandbox is gone;  *)
(* waits while another holds the lease.                                                                          *)
R3(p) ==
  LET v == p[2] IN
  /\ p[1] = "run" /\ pc[p] = "r3"
  /\ IF jsb[v] # "run" \/ ~login[v]
     THEN Go(p, "r5") /\ UNCHANGED <<lh, lage, jleft, hage>>
     ELSE /\ LeaseFree(v)
          /\ lh' = [lh EXCEPT ![v] = p[1]] /\ lage' = [lage EXCEPT ![v] = 0]
          /\ jleft' = [jleft EXCEPT ![v] = J + 1] /\ hage' = [hage EXCEPT ![v] = 0]
          /\ Go(p, "r4")
  /\ UNCHANGED <<vis, jobv, sign, login, st, jsb, los, glob>>
(* the harness runs until it ends, at most J (byoa's jobTimeoutMs); at once when its sandbox is gone *)
R4(p) ==
  /\ p[1] = "run" /\ pc[p] = "r4"
  /\ Go(p, "r5")
  /\ UNCHANGED <<vis, jobv, sign, lg, box, glob>>
(* job.ts 225-242 close: release (save, remove the files, give the lease), then pause the kept sandbox *)
R5(p) ==
  LET v == p[2] IN
  /\ p[1] = "run" /\ pc[p] = "r5"
  /\ lh' = [lh EXCEPT ![v] = IF lh[v] = p[1] THEN "none" ELSE lh[v]]
  /\ jsb' = [jsb EXCEPT ![v] = IF jsb[v] = "run" THEN "paused" ELSE jsb[v]]
  /\ jleft' = [jleft EXCEPT ![v] = 0]
  /\ Go(p, "r6")
  /\ UNCHANGED <<vis, jobv, sign, login, st, lage, hage, los, glob>>
(* agents.ts 93 -> demo.ts endJob (135-144): the job ends, its place is free, pump *)
R6(p) ==
  LET v == p[2] IN
  /\ p[1] = "run" /\ pc[p] = "r6"
  /\ IF jst[v] = "running"
     THEN Pump([jst EXCEPT ![v] = "done"], line, sr, sseen, [pc EXCEPT ![p] = "idle"], age)
     ELSE Go(p, "idle") /\ UNCHANGED <<jst, jage, line>>
  /\ UNCHANGED <<vis, jat, dup, sign, lg, box, glob>>

(* ---- deleteData (agents.ts 130-137), signOut (108-115), forget (140-143): forgetVisitor (119-127) and byoa's   *)
(* signOut (agents.ts 165-169; login-stored.ts 234-255)                                                          *)

(* agents.ts noJob -> demo.ts idle: refuses while the visitor's job waits or runs; else returns the stamp (seen, or *)
(* with FixTouch acts) that drop compares, so the ghosts since and sinceAct start here                            *)
D0(p) ==
  LET v == p[2] IN
  /\ p[1] \in {"del", "out"} /\ pc[p] \in {"d0", "o0"}
  /\ Go(p, IF Active(v) THEN "idle" ELSE IF p[1] = "del" THEN "f1" ELSE "f3a")
  /\ since' = [since EXCEPT ![p] = FALSE] /\ sinceAct' = [sinceAct EXCEPT ![p] = FALSE]
  /\ UNCHANGED <<row, seen, req, deleted, outd, jobv, sign, lg, box, glob>>
(* login.ts dropPending (1a58e3c, lines 140-148): the entry ends with compare-and-set and keeps the sandbox it      *)
(* names, which it destroys (also again). A sandbox that connectLogin still creates is not named: that connectLogin*)
(* finds its entry ended and destroys it (L3).                                                                    *)
DropPending(v) ==
  /\ pend' = [pend EXCEPT ![v] = FALSE]
  /\ sib' = [sib EXCEPT ![v] = IF psb[v] THEN 0 ELSE sib[v]]
  /\ UNCHANGED <<pgen, psb>>
(* agents.ts forgetVisitor: cancelLogin -> dropPending *)
F1(p) ==
  LET v == p[2] IN
  /\ pc[p] = "f1"
  /\ DropPending(v)
  /\ Go(p, "f2")
  /\ UNCHANGED <<vis, jobv, sr, sseen, lg, box, glob>>
(* agents.ts 123: loginState (login.ts 136, the state entry); signOut only when it is not signed-out. FixForget: *)
(* always signOut (it looks for the stored login itself, login-stored.ts 237; with none it starts no sandbox)   *)
F2(p) ==
  /\ pc[p] = "f2"
  /\ Go(p, IF st[p[2]] = "out" /\ ~FixForget THEN "f4" ELSE "f3a")
  /\ UNCHANGED <<vis, jobv, sign, lg, box, glob>>
(* agents.ts 168: deleteSandbox of the lab (slots.remove): a job's harness in it ends *)
F3a(p) ==
  /\ pc[p] = "f3a"
  /\ jsb' = [jsb EXCEPT ![p[2]] = "none"] /\ jleft' = [jleft EXCEPT ![p[2]] = 0]
  /\ Go(p, "f3b")
  /\ UNCHANGED <<vis, jobv, sign, lg, hage, los, glob>>
(* login-stored.ts 235-238: cli.cancel (dropPending), store.get(login); then the sign-out sandbox (timeoutMs 5 min).*)
(* FixCap: the sign-out sandbox waits for a place.                                                                *)
F3b(p) ==
  LET v == p[2] IN
  /\ pc[p] = "f3b"
  /\ DropPending(v)
  /\ IF login[v]
     THEN /\ (FixCap => Used(jst, sr, sseen) < MAX)
          /\ los' = [los EXCEPT ![p] = LO] /\ Go(p, "f3c")
     ELSE Go(p, "f3e") /\ UNCHANGED los
  /\ UNCHANGED <<vis, jobv, sr, sseen, lg, jsb, jleft, hage, glob>>
(* login-stored.ts 240: load(alone) -> take: waits in line for the lease (no time limit); throws when the login is *)
(* gone (caught at 250)                                                                                            *)
F3c(p) ==
  LET v == p[2] IN
  /\ pc[p] = "f3c"
  /\ IF ~login[v] THEN Go(p, "f3d") /\ UNCHANGED <<lh, lage>>
     ELSE /\ LeaseFree(v)
          /\ lh' = [lh EXCEPT ![v] = p[1]] /\ lage' = [lage EXCEPT ![v] = 0]
          /\ Go(p, "f3d")
  /\ UNCHANGED <<vis, jobv, sign, login, st, box, glob>>
(* login-stored.ts 241-249: the CLI's logout, give the lease, destroy the sign-out sandbox *)
F3d(p) ==
  LET v == p[2] IN
  /\ pc[p] = "f3d"
  /\ lh' = [lh EXCEPT ![v] = IF lh[v] = p[1] THEN "none" ELSE lh[v]]
  /\ los' = [los EXCEPT ![p] = 0]
  /\ Go(p, "f3e")
  /\ UNCHANGED <<vis, jobv, sign, login, st, lage, jsb, jleft, hage, glob>>
(* login-stored.ts 252: store.delete(login) *)
F3e(p) ==
  /\ pc[p] = "f3e"
  /\ login' = [login EXCEPT ![p[2]] = FALSE]
  /\ Go(p, "f3f")
  /\ UNCHANGED <<vis, jobv, sign, st, lh, lage, box, glob>>
(* login-stored.ts 253: setState signed-out; signOut returns (to forgetVisitor, or to the page) *)
F3f(p) ==
  /\ pc[p] = "f3f"
  /\ st' = [st EXCEPT ![p[2]] = "out"]
  /\ Go(p, IF p[1] = "out" THEN "ret" ELSE "f4")
  /\ UNCHANGED <<vis, jobv, sign, login, lh, lage, box, glob>>
(* agents.ts 125: deleteSandbox of every lab *)
F4(p) ==
  /\ pc[p] = "f4"
  /\ jsb' = [jsb EXCEPT ![p[2]] = "none"] /\ jleft' = [jleft EXCEPT ![p[2]] = 0]
  /\ Go(p, "f5")
  /\ UNCHANGED <<vis, jobv, sign, lg, hage, los, glob>>
(* agents.ts forgetVisitor -> demo.ts drop: the visitor's rows, except a job that waits or runs; their sign-ins end;*)
(* the visitors row goes; pump. FixForget: nothing when the stamp changed since D0 (or the sweep) read it, and      *)
(* deleteData then throws: the stamp is seen (03cfc7d: any request, also touch) or, with FixTouch, acts (fix2).    *)
F5(p) ==
  LET v == p[2]
      changed == IF FixTouch THEN sinceAct[p] ELSE since[p]
  IN
  /\ pc[p] = "f5"
  /\ IF FixForget /\ changed
     THEN /\ Go(p, "idle") /\ UNCHANGED <<row, jst, jage, line, sr>>
          /\ delFail' = (delFail \/ (p[1] = "del" /\ ~sinceAct[p]))
     ELSE /\ row' = [row EXCEPT ![v] = FALSE]
          /\ sr' = [sr EXCEPT ![v] = FALSE]
          /\ Pump([jst EXCEPT ![v] = IF Active(v) THEN jst[v] ELSE "none"], line, [sr EXCEPT ![v] = FALSE], sseen,
                  [pc EXCEPT ![p] = IF p[1] = "del" THEN "ret" ELSE "idle"], age)
          /\ UNCHANGED delFail
  /\ UNCHANGED <<seen, req, since, sinceAct, deleted, outd, jat, dup, sseen, pend, pgen, psb, sib, lg, box,
                 swept, crashes, calls, twoForgets>>
(* deleteData or signOut returns to the page *)
Ret(p) ==
  LET v == p[2] IN
  /\ pc[p] = "ret"
  /\ deleted' = [deleted EXCEPT ![v] = deleted[v] \/ (p[1] = "del" /\ ~sinceAct[p])]
  /\ outd' = [outd EXCEPT ![v] = outd[v] \/ (p[1] = "out" /\ ~sinceAct[p])]
  /\ Go(p, "idle")
  /\ UNCHANGED <<row, seen, req, since, sinceAct, jobv, sign, lg, box, glob>>

(* ---- login (agents.ts login): beginSignin, then byoa's connectLogin (login.ts start at 1a58e3c, 156-190) *)

(* demo.ts beginSignin: seen (an act); an old pending sign-in of this lab ends and the new one needs no place;     *)
(* else refuse when used >= max. FixOld: the places are counted after the old one ends.                          *)
L1(p) ==
  LET v == p[2]
      noPlace == IF sr[v] THEN FixOld /\ Used(jst, [sr EXCEPT ![v] = FALSE], sseen) >= MAX
                 ELSE Used(jst, sr, sseen) >= MAX
  IN
  /\ p[1] = "login" /\ pc[p] = "l1"
  /\ Seen(v, TRUE)
  /\ IF noPlace THEN Go(p, "idle") /\ UNCHANGED <<sr, sseen>>
     ELSE sr' = [sr EXCEPT ![v] = TRUE] /\ sseen' = [sseen EXCEPT ![v] = 0] /\ Go(p, "l2")
  /\ UNCHANGED <<jobv, pend, pgen, psb, sib, lg, box, glob>>
(* login.ts start 158-166: the entry first: destroy the sandbox the earlier entry names, then compare-and-set the *)
(* entry to this sign-in's, in progress, with no sandbox (one step: a cas that fails reads and destroys again)     *)
L2(p) ==
  LET v == p[2] IN
  /\ p[1] = "login" /\ pc[p] = "l2"
  /\ sib' = [sib EXCEPT ![v] = IF psb[v] THEN 0 ELSE sib[v]]
  /\ pend' = [pend EXCEPT ![v] = TRUE] /\ pgen' = [pgen EXCEPT ![v] = pgen[v] + 1] /\ psb' = [psb EXCEPT ![v] = FALSE]
  /\ pc' = [pc EXCEPT ![p] = "l2b"] /\ mine' = [mine EXCEPT ![p] = pgen[v] + 1] /\ UNCHANGED age
  /\ UNCHANGED <<vis, jobv, sr, sseen, lg, box, glob>>
(* login.ts 169: create the sandbox (timeoutMs LOGIN_MAX_MS), the CLI, the lab's page *)
L2b(p) ==
  /\ p[1] = "login" /\ pc[p] = "l2b"
  /\ sib' = [sib EXCEPT ![p[2]] = LM]
  /\ Go(p, "l3")
  /\ UNCHANGED <<vis, jobv, sr, sseen, pend, pgen, psb, lg, box, glob>>
(* login.ts 179-181: whileSigningIn: the entry names the sandbox only while it is still this sign-in's (get, get, *)
(* cas of one key: an end of the entry between them makes the cas fail, and the loop reads it ended, so one step); *)
(* keepAlive(LOGIN_IDLE_MS). Else it throws (185-188): destroy the sandbox; endPending changes nothing (the entry  *)
(* is not this one's); agents.ts login's catch -> endSignin (l4).                                                 *)
L3(p) ==
  LET v == p[2] IN
  /\ p[1] = "login" /\ pc[p] = "l3"
  /\ IF pend[v] /\ pgen[v] = mine[p]
     THEN psb' = [psb EXCEPT ![v] = TRUE] /\ sib' = [sib EXCEPT ![v] = Min(sib[v], I)] /\ Go(p, "idle")
     ELSE sib' = [sib EXCEPT ![v] = 0] /\ Go(p, "l4") /\ UNCHANGED psb
  /\ UNCHANGED <<vis, jobv, sr, sseen, pend, pgen, lg, box, glob>>

(* ---- finishLogin (agents.ts finishLogin), with byoa's finish (login.ts 192-226 at 1a58e3c) *)

(* demo.ts seenSignin: seen (an act: finishLogin may save a login), and the pending sign-in's seen *)
G1(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g1"
  /\ Seen(v, TRUE)
  /\ sseen' = [sseen EXCEPT ![v] = IF sr[v] THEN 0 ELSE sseen[v]]
  /\ Go(p, "g2")
  /\ UNCHANGED <<jobv, sr, pend, pgen, psb, sib, lg, box, glob>>
(* login.ts 196-207: the entry: ended -> the state (not `pending`, so endSignin); no sandbox yet -> `pending`; the *)
(* sandbox is gone -> ranOut (dropPending); else resume (timeoutMs LOGIN_IDLE_MS + waitMs) and keepAlive          *)
G2(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g2"
  /\ IF ~pend[v] THEN Go(p, "g6") /\ UNCHANGED <<pend, pgen, psb, sib>>
     ELSE IF ~psb[v] THEN Go(p, "idle") /\ UNCHANGED <<pend, pgen, psb, sib>>
     ELSE IF sib[v] = 0 THEN DropPending(v) /\ Go(p, "g6")
     ELSE /\ sib' = [sib EXCEPT ![v] = I + W]
          /\ pc' = [pc EXCEPT ![p] = "g3"] /\ mine' = [mine EXCEPT ![p] = pgen[v]] /\ UNCHANGED age
          /\ UNCHANGED <<pend, pgen, psb>>
  /\ UNCHANGED <<vis, jobv, sr, sseen, lg, box, glob>>
(* login.ts 208-214: the CLI's status: not done (`pending`: the page calls again; no endSignin), or done. A sandbox *)
(* that went meanwhile: read throws, the action fails.                                                           *)
G3(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g3"
  /\ IF sib[v] = 0 THEN Go(p, "idle")
     ELSE Go(p, "idle") \/ Go(p, "g3b")
  /\ UNCHANGED <<vis, jobv, sign, lg, box, glob>>
(* login.ts 215-218 -> login-stored.ts signedIn: read the login files, then save them with whileSigningIn: only    *)
(* while the entry is still this sign-in's. One step: a delete or put of the login between its check and its cas   *)
(* changes the version, so the cas fails and the loop reads the entry ended; one after the cas wins anyway. (The   *)
(* model's login is there from the check on; only signOut's get at F3b could read the gap, so the model may start a*)
(* sign-out sandbox the code does not: more behaviors, none fewer.)                                                *)
G3b(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g3b"
  /\ IF sib[v] = 0 THEN Go(p, "idle") /\ UNCHANGED login
     ELSE IF pend[v] /\ pgen[v] = mine[p] THEN login' = [login EXCEPT ![v] = TRUE] /\ Go(p, "g5")
     ELSE Go(p, "g4") /\ UNCHANGED login
  /\ UNCHANGED <<vis, jobv, sign, st, lh, lage, box, glob>>
(* login.ts 218: the state signed-in, with whileSigningIn (the same argument) *)
G5(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g5"
  /\ st' = [st EXCEPT ![v] = IF pend[v] /\ pgen[v] = mine[p] THEN "in" ELSE st[v]]
  /\ Go(p, "g4")
  /\ UNCHANGED <<vis, jobv, sign, login, lh, lage, box, glob>>
(* login.ts 219-222 finally: destroy the sign-in sandbox; endPending: the entry ends if it is still this one's *)
G4(p) ==
  LET v == p[2] IN
  /\ p[1] = "fin" /\ pc[p] = "g4"
  /\ sib' = [sib EXCEPT ![v] = 0]
  /\ IF pend[v] /\ pgen[v] = mine[p] THEN pend' = [pend EXCEPT ![v] = FALSE] /\ psb' = [psb EXCEPT ![v] = FALSE]
     ELSE UNCHANGED <<pend, psb>>
  /\ Go(p, "g6")
  /\ UNCHANGED <<vis, jobv, sr, sseen, pgen, lg, box, glob>>
(* agents.ts finishLogin (not `pending`) and login's catch -> demo.ts endSignin: the sign-in ends, pump *)
EndSignin(p) ==
  LET v == p[2] IN
  /\ IF sr[v]
     THEN sr' = [sr EXCEPT ![v] = FALSE] /\ Pump(jst, line, [sr EXCEPT ![v] = FALSE], sseen, [pc EXCEPT ![p] = "idle"], age)
     ELSE Go(p, "idle") /\ UNCHANGED <<sr, jst, jage, line>>
  /\ UNCHANGED <<vis, jat, dup, sseen, pend, pgen, psb, sib, lg, box, glob>>
G6(p) == p[1] = "fin" /\ pc[p] = "g6" /\ EndSignin(p)
L4(p) == p[1] = "login" /\ pc[p] = "l4" /\ EndSignin(p)

Step(p) ==
  \/ R1(p) \/ R2(p) \/ R3(p) \/ R4(p) \/ R5(p) \/ R6(p)
  \/ D0(p) \/ F1(p) \/ F2(p) \/ F3a(p) \/ F3b(p) \/ F3c(p) \/ F3d(p) \/ F3e(p) \/ F3f(p) \/ F4(p) \/ F5(p) \/ Ret(p)
  \/ L1(p) \/ L2(p) \/ L2b(p) \/ L3(p) \/ L4(p)
  \/ G1(p) \/ G2(p) \/ G3(p) \/ G3b(p) \/ G4(p) \/ G5(p) \/ G6(p)

(* an action dies between two steps (a crash of Convex's Node runtime) *)
Die(p) ==
  /\ Crash /\ crashes < MaxCrash /\ pc[p] \notin Idle
  /\ pc' = [pc EXCEPT ![p] = "dead"] /\ crashes' = crashes + 1
  /\ UNCHANGED <<vis, jobv, sign, lg, box, age, mine, swept, calls, twoForgets, delFail>>

(* ---- the cron: demo.ts sweep (190-211), one mutation *)
Sweep ==
  /\ ~swept /\ swept' = TRUE
  /\ LET sr1 == [v \in V |-> sr[v] /\ ~(sseen[v] > SS)]                                     \* lines 194-198
         js1 == [v \in V |-> IF jst[v] = "running" /\ jage[v] >= S THEN "done" ELSE jst[v]] \* lines 199-203
         stale == {v \in V : row[v] /\ seen[v] > F}                                          \* lines 204-208
         Q == IF FixForget THEN {v \in stale : js1[v] = "queued"} ELSE {}
         Rn == IF FixForget THEN {v \in stale : js1[v] = "running"} ELSE {}
         Fg == stale \ Rn
         js2 == [v \in V |-> IF v \in Q THEN "done" ELSE js1[v]]
         ln2 == SelectSeq(line, LAMBDA x : x \notin Q)
         fp(v) == <<"forget", v>>
         can(v) == pc[fp(v)] \in Idle /\ los[fp(v)] = 0
         pc0 == [p \in P |-> IF p[1] = "forget" /\ p[2] \in Fg /\ can(p[2]) THEN "f1" ELSE pc[p]]
         age0 == [p \in P |-> IF p[1] = "forget" /\ p[2] \in Fg /\ can(p[2]) THEN 0 ELSE age[p]]
     IN /\ sr' = sr1
        /\ seen' = [v \in V |-> IF v \in Rn THEN F ELSE IF v \in Fg THEN Max0(F - R) ELSE seen[v]]
        /\ since' = [p \in P |-> IF p[1] = "forget" /\ p[2] \in Fg /\ can(p[2]) THEN FALSE ELSE since[p]]
        /\ sinceAct' = [p \in P |-> IF p[1] = "forget" /\ p[2] \in Fg /\ can(p[2]) THEN FALSE ELSE sinceAct[p]]
        /\ twoForgets' = (twoForgets \/ \E v \in Fg : ~can(v))
        /\ Pump(js2, ln2, sr1, sseen, pc0, age0)
  /\ UNCHANGED <<row, req, deleted, outd, jat, dup, sseen, pend, pgen, psb, sib, lg, box, crashes, calls, delFail>>

(* a live action whose next step does not wait: Tick waits for it *)
Urgent(p) ==
  LET v == p[2] IN
  /\ pc[p] \notin Idle
  /\ ~(pc[p] = "r4" /\ hage[v] < J /\ jsb[v] = "run")
  /\ ~(pc[p] = "r3" /\ jsb[v] = "run" /\ login[v] /\ ~LeaseFree(v))
  /\ ~(pc[p] = "f3c" /\ login[v] /\ ~LeaseFree(v))
  /\ ~(pc[p] = "f3b" /\ FixCap /\ login[v] /\ Used(jst, sr, sseen) >= MAX)

(* one step of time, after the sweep: ages, the providers' timers (a job's sandbox pauses at its time), and the   *)
(* action limit                                                                                                    *)
Tick ==
  /\ swept /\ swept' = FALSE
  /\ \A p \in P : ~Urgent(p)
  /\ seen' = [v \in V |-> Sat(seen[v], F + 1)]
  /\ req' = [v \in V |-> Sat(req[v], Bound + 1)]
  /\ jage' = [v \in V |-> IF jst[v] = "running" THEN Sat(jage[v], S) ELSE jage[v]]
  /\ jat' = [v \in V |-> IF Active(v) THEN Sat(jat[v], F) ELSE jat[v]]
  /\ sseen' = [v \in V |-> IF sr[v] THEN Sat(sseen[v], SS + 1) ELSE sseen[v]]
  /\ sib' = [v \in V |-> Max0(sib[v] - 1)]
  /\ jleft' = [v \in V |-> Max0(jleft[v] - 1)]
  /\ jsb' = [v \in V |-> IF jsb[v] = "run" /\ jleft[v] <= 1 THEN "paused" ELSE jsb[v]]
  /\ hage' = [v \in V |-> IF pc[<<"run", v>>] = "r4" THEN Sat(hage[v], J) ELSE hage[v]]
  /\ lage' = [v \in V |-> IF lh[v] # "none" THEN Sat(lage[v], LL) ELSE lage[v]]
  /\ los' = [p \in P |-> Max0(los[p] - 1)]
  /\ age' = [p \in P |-> IF pc[p] \notin Idle THEN Sat(age[p], A) ELSE age[p]]
  /\ pc' = [p \in P |-> IF pc[p] \notin Idle /\ age[p] + 1 >= A THEN "dead" ELSE pc[p]]
  /\ UNCHANGED <<row, since, sinceAct, deleted, outd, jst, line, dup, sr, pend, pgen, psb, login, st, lh, mine,
                 crashes, calls, twoForgets, delFail>>

Next ==
  \/ \E v \in V : Touch(v) \/ StartJob(v)
  \/ \E p \in P : Begin(p) \/ Step(p) \/ Die(p)
  \/ Sweep \/ Tick

(* Fairness: a live action's steps run (Convex runs it; a dead one gets none), the cron runs every minute, and     *)
(* time passes. The page and the visitor get none.                                                               *)
Fairness == WF_vars(Sweep) /\ WF_vars(Tick) /\ \A p \in P : WF_vars(Step(p))

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

(* ---- properties *)

Sandboxes == Cardinality({v \in V : jsb[v] = "run"}) + Cardinality({v \in V : sib[v] > 0})
             + Cardinality({p \in P : los[p] > 0})
Kept(v) == login[v] \/ jsb[v] # "none" \/ sib[v] > 0

(* no visitor login or sandbox stays more than Bound steps after the visitor's last request *)
ForgetWithinHour == \A v \in V : Kept(v) => req[v] <= Bound
(* a shorter check of the same: a login or a job's sandbox of a visitor whose row is gone, while no action of the  *)
(* visitor runs. The sweep finds visitors only by their row, so nothing ever deletes it.                         *)
NoOrphan == \A v \in V : (login[v] \/ jsb[v] # "none") => row[v] \/ \E k \in Kinds : pc[<<k, v>>] \notin Idle
(* no login and no job sandbox after Delete my data returned (and the visitor made no act since it began). A sign- *)
(* in sandbox is left out: a beginSignin before idle whose connectLogin writes its entry after forgetVisitor's      *)
(* cancelLogin keeps its sandbox, with no login in it, until LOGIN_IDLE_MS after it (no page checks in with the old *)
(* visitor id); a finishLogin then is an act, so its login has a visitors row again (seen inserts it).            *)
AfterDelete == \A v \in V : deleted[v] => ~login[v] /\ jsb[v] = "none"
(* Delete my data does not refuse when the visitor made no act (startJob, a sign-in) while it ran *)
DeleteWorks == ~delFail
(* no stored login and no sandbox of that lab after Sign out returned *)
AfterSignOut == \A v \in V : outd[v] => ~login[v] /\ jsb[v] = "none"
(* never more than MAX sandboxes run: sign-ins, jobs and sign-outs together *)
SandboxCap == Sandboxes <= MAX
OneJobPerVisitor == \A v \in V : ~dup[v]
(* the model's own simplification holds: no second forget of a visitor while one runs *)
NoTwoForgets == ~twoForgets
(* a job in line eventually runs or is dropped; a running job ends *)
LineMoves == \A v \in V : (jst[v] = "queued") ~> (jst[v] # "queued")
RunningEnds == \A v \in V : (jst[v] = "running") ~> (jst[v] # "running")
=============================================================================
