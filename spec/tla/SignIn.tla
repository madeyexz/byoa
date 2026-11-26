----------------------------- MODULE SignIn -----------------------------
(***************************************************************************)
(* The sign-in and sign-out of one user and harness, and the login state  *)
(* that jobs report, called by the app's backends at the same time:        *)
(*  - connectLogin (agents.ts:133 -> login.ts start, 156-183),             *)
(*  - finishLogin (agents.ts:137-142 -> login.ts finish, 185-211, with     *)
(*    storedLogin's signedIn hook, login-stored.ts:156-160; then           *)
(*    limits.clear, R1.9),                                                 *)
(*  - cancelLogin (agents.ts:144 -> login.ts dropPending, 138-143),        *)
(*  - signOut (agents.ts:165-169: deleteSandbox, then login.signOut, then  *)
(*    limits.clear; storedLogin's signOut login-stored.ts:234-255, or     *)
(*    cliLogin's login.ts:215-227),                                        *)
(*  - a job (job.ts run: the usage limit 364-365, the kept sandbox         *)
(*    247-265, cred.check 276, cred.load 281, the harness 399, and what it *)
(*    reports: 413, 414, 423; credential.ts labLogin 45-53),               *)
(*  - the provider's timer of each sign-in sandbox (create: LOGIN_MAX_MS;  *)
(*    resume and keepAlive: the time they set), and the user, who finishes *)
(*    on the lab's page once connectLogin showed it.                       *)
(* Driver "stored" is storedLogin (the login in the store, R1.4); "volume" *)
(* is cliLogin (the login in a volume of the user, R1.5: the CLI in the    *)
(* sign-in sandbox writes it there when the user finishes).                *)
(*                                                                         *)
(* Fix is the set of fixes the code has: {} is the code at d7c34b7.        *)
(*  "record" (CancelEnds): no delete of the sign-in's entry (loginjob/)  *)
(*    any more; every write of it is store.ts `update` (get, then cas),   *)
(*    and an entry with no `at` is a sign-in that ended (it keeps its      *)
(*    sandbox, so a later dropPending, such as signOut's, destroys it      *)
(*    again). connectLogin destroys the sandbox of the entry it finds,    *)
(*    then puts {at} with cas (again when the cas fails), before it        *)
(*    creates its sandbox; it registers {sandbox, at} only while the       *)
(*    entry is still its {at}, else it                                      *)
(*    destroys its sandbox and throws. dropPending ends the entry and      *)
(*    destroys the sandbox of exactly the entry it ended. At d7c34b7 a     *)
(*    get-then-delete could end an entry and miss the sandbox registered   *)
(*    between the two, and a second connectLogin's put hid the first one's *)
(*    sandbox from every later cancel (main_cancel, main_twostarts).       *)
(*  "fence" (SignOutWins): finishLogin ends the entry after it saved, not  *)
(*    before, and saves the login (storedLogin's signedIn) and the state   *)
(*    with compare-and-set only while the entry is still its own           *)
(*    (login.ts whileSigningIn: get the key, get the entry, cas); a key    *)
(*    that is not there gets an empty value first, so that signOut's       *)
(*    delete changes its version.                                          *)
(*  "undo" (CancelWins, 1a58e3c has not): when the state's save fails      *)
(*    after the login's save worked (the state's check of the entry comes  *)
(*    after the login's cas, so it is the check again), finish puts the    *)
(*    login's value before back, with cas while the key still has the     *)
(*    value it wrote. Before, the cas on the login could win after a       *)
(*    cancelLogin returned: the login stayed, while finishLogin answered   *)
(*    "the sign-in was cancelled". The state is never undone: two          *)
(*    finishLogin of one sign-in at once would undo each other's           *)
(*    'signed-in' (a first try of this fix did; TLC found it), and with    *)
(*    cliLogin a 'signed-in' after a cancel is true (the login is in the   *)
(*    volume).                                                             *)
(*  "keep" (NoStray with DestroyFails, 1a58e3c has not): when finish's     *)
(*    destroy of the sign-in sandbox fails, its ended entry keeps the      *)
(*    sandbox id, so the next cancelLogin or signOut destroys it.          *)
(*  "derive": storedLogin's `state` is signed-out when no login is stored *)
(*    (login-stored.ts), whatever a sign-in or a job wrote last (StateTrue).*)
(*  "again": proposed, not in fix.patch: signOut runs deleteSandbox again  *)
(*    after login.signOut, which ends a job that started during the       *)
(*    sign-out (NoJobAfterSignOut).                                        *)
(*                                                                         *)
(* One step of time is one minute: LOGIN_MAX_MS is Max, LOGIN_IDLE_MS is   *)
(* Idle, and waitMs is Wait.                                               *)
(*                                                                         *)
(* Each store call (get, put, delete, cas) and each sandbox call that      *)
(* another process can see is one step. Merged, and why that is sound:     *)
(*  - start: create, ensureHarness, the CLI and the poll for its page      *)
(*    (159-170) are one step: no other process knows the new sandbox until *)
(*    its id is in the store, and the provider's timer does not run during *)
(*    a call (see below).                                                  *)
(*  - finish: typing the code, the status loop and `present` (198-206) are *)
(*    one step: they only read the sign-in sandbox; when it is destroyed   *)
(*    between them, the code throws at the next one, as the merged step   *)
(*    does when it runs after the destroy.                                 *)
(*  - whileSigningIn on the pending key itself (start's registration):     *)
(*    get(key) and get(pending) read the same key; a write between them   *)
(*    makes the cas fail and the loop read again, so one read gives the    *)
(*    same outcomes.                                                       *)
(*  - signOut's sign-out sandbox (login-stored.ts 238-251; login.ts        *)
(*    218-224) is two steps for storedLogin (take the login alone, which   *)
(*    waits for the jobs that hold it; give it back) and one for cliLogin; *)
(*    the CLI's sign-out writes nothing that this model has.               *)
(*  - deleteSandbox (slots.remove) is one step that ends every job whose   *)
(*    kept sandbox is in the index: spec/tla/Index.tla checks the index    *)
(*    with its fix, so here every job is listed from its slot step on.     *)
(*  - the job's take (login-stored.ts take: line, lease, two reads of the  *)
(*    login) is one read of the login; LoginLease.tla checks the lease.    *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - A call of a live backend ends within one step of time: Tick waits    *)
(*    until every live backend is between calls. A backend that dies      *)
(*    (Crash) stops anywhere; its leases run out (a dead job does not      *)
(*    hold the login).                                                     *)
(*  - The CLI's sign-in always works once the user finished (`done`); a    *)
(*    sign-in that fails, and finish's wait loop, are left out: finish     *)
(*    reads the status once (Wait is the time resume gives the sandbox).   *)
(*  - The value of the pending entry is told apart by the sign-in's number *)
(*    g; the code compares {at} (and {sandbox, at}), so two connectLogin   *)
(*    calls in the same millisecond have equal values: then one of them    *)
(*    registers on the other's entry and the other one fails, which is    *)
(*    also one sign-in in the end.                                         *)
(*  - The provider has keepAlive (E2B, Daytona, local); on Instabox a      *)
(*    sign-in sandbox lives its LOGIN_MAX_MS.                              *)
(*  - All backends have one clock (login.ts uses Date.now, not time.ts).   *)
(*  - keepAlive gives a sandbox at least 1 s; the model gives 0 steps at   *)
(*    the cap.                                                             *)
(*  - A usage limit has no end time here (it holds until cleared), and a   *)
(*    job's `held` clear (job.ts:425) is left out: a kept limit stops the  *)
(*    job before its sandbox.                                              *)
(*  - The volume: deleteVolume removes the login; a CLI that writes into a *)
(*    volume that was deleted while mounted writes it again (the worst     *)
(*    case; providers differ). The sign-in's own `present` reads the       *)
(*    volume.                                                              *)
(*  - Only finish's destroy of the sign-in sandbox may fail (DestroyFails); *)
(*    the others always work.                                              *)
(*  - Between finish's cas and its undo, the login of a cancelled sign-in  *)
(*    is stored for a moment: a job that takes it then runs with it. A     *)
(*    finish whose backend dies there leaves it (CancelWins counts a dead  *)
(*    finish as one still running).                                        *)
(*  - The job's release (save of a refresh) and checkpoint are left out    *)
(*    (LoginLease.tla); so is the plan's key (R1.8).                       *)
(*  - Only one sign-in sandbox per sign-in, and at most MaxStarts; the     *)
(*    sign-out sandbox, listModels' sandbox and the job's sandbox are not  *)
(*    in `sbx` (Cap and CancelEnds are about sign-in sandboxes).           *)
(*  - The app's calls stop at LastCall, so that liveness is checked on an  *)
(*    app that leaves (no fairness for Begin, UserDone or a dead backend). *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, Sequences

CONSTANTS Procs, MaxCalls, MaxStarts, Max, Idle, Wait, MaxTime, LastCall, Crash, None,
          DestroyFails, \* finish's destroy of the sign-in sandbox may fail (a provider error)
          Fix,     \* a subset of {"record", "fence", "derive", "undo", "keep", "again"}
          Driver,  \* "stored" or "volume"
          Kinds    \* the calls the app makes: a subset of {"start", "finish", "cancel", "signout", "job"}

VARIABLES
  clock,
  cnt,      \* the last version of each key: [p, l, s] (versions never repeat for a key)
  pending,  \* loginjob/: None, or [s (0: no sandbox yet), at, g (the sign-in's number; 0: ended), ver]
  sbx,      \* the provider's sign-in sandboxes: id -> [run, end, at, done, g, shown]
  nsbx,
  login,    \* ailogin/ (stored): [k: "none", "empty" or "in", g, ver]; ver 0: no entry
  vol,      \* the login volume (volume): [has, g]
  st,       \* login/ state: [v: "in", "out" or "expired", by, g, ver]; ver 0: no entry ("signed-out")
  limit,    \* usagelimit/: [kept, g]
  pc, call, loc,
  calls, nstart,
  outOld,   \* the sign-ins whose sandbox was created before a signOut began that has returned
  cancelled, \* the sign-in sandboxes created before a cancelLogin began that has returned
  cancelledG, \* the sign-ins that a cancelLogin that has returned ended (it ended their entry)
  committed  \* the sign-ins whose finishLogin saved for good (passed its last check that the sign-in is in progress)

vars == <<clock, cnt, pending, sbx, nsbx, login, vol, st, limit, pc, call, loc, calls, nstart, outOld, cancelled, cancelledG, committed>>
store == <<cnt, pending, login, vol, st, limit>>
ghost == <<calls, nstart, outOld, cancelled, cancelledG, committed>>
ghost0 == <<calls, nstart, outOld, cancelled, cancelledG>>

Ids == 1..MaxStarts
Min(a, b) == IF a < b THEN a ELSE b
Max0(a) == IF a < 0 THEN 0 ELSE a
L0 == [pend |-> None, ver |-> 0, s |-> 0, at |-> 0, g |-> 0, ok |-> FALSE, old |-> {}, kill |-> FALSE, out |-> "none",
       lw |-> 0, uv |-> 0, pl |-> [k |-> "none", g |-> 0], ls |-> FALSE, ks |-> FALSE]
Stored == Driver = "stored"

Init ==
  /\ clock = 0 /\ cnt = [p |-> 0, l |-> 0, s |-> 0]
  /\ pending = None
  /\ sbx = [i \in Ids |-> [run |-> FALSE, end |-> 0, at |-> 0, done |-> FALSE, g |-> 0, shown |-> FALSE]]
  /\ nsbx = 0
  /\ login = [k |-> "none", g |-> 0, ver |-> 0]
  /\ vol = [has |-> FALSE, g |-> 0]
  /\ st = [v |-> "out", by |-> "none", g |-> 0, ver |-> 0]
  /\ limit = [kept |-> FALSE, g |-> 0]
  /\ pc = [p \in Procs |-> "idle"] /\ call = [p \in Procs |-> "none"] /\ loc = [p \in Procs |-> L0]
  /\ calls = 0 /\ nstart = 0 /\ outOld = {} /\ cancelled = {} /\ cancelledG = {} /\ committed = {}

Running(i) == i \in Ids /\ sbx[i].run
Kill(i) == IF i \in Ids THEN [sbx EXCEPT ![i].run = FALSE] ELSE sbx
KeepAlive(i, at, ms) == IF Running(i) THEN [sbx EXCEPT ![i].end = clock + Max0(Min(ms, at + Max - clock))] ELSE sbx
Val(r) == [s |-> r.s, at |-> r.at, g |-> r.g]
Mine(r) == pending # None /\ Val(pending) = Val(r)
LoginStored == IF Stored THEN login.k = "in" ELSE vol.has
LoginGen == IF Stored THEN login.g ELSE vol.g
\* state (login.ts:136); "derive": storedLogin's state is signed-out when no login is stored
StateV == IF "derive" \in Fix /\ Stored /\ login.k # "in" THEN "out" ELSE st.v
Busy(k) == \E p \in Procs : call[p] = k /\ pc[p] # "idle"   \* in a call, or its backend died in it
JobAt == {"j.check", "j.take", "j.run"}                     \* a job that deleteSandbox ends
Holds == {"j.run", "j.rep", "j.rput"}                        \* a job that holds the stored login (take .. close)

Go(p, s) == pc' = [pc EXCEPT ![p] = s]
GoL(p, s, l) == pc' = [pc EXCEPT ![p] = s] /\ loc' = [loc EXCEPT ![p] = l]
Ret(p) == pc' = [pc EXCEPT ![p] = "idle"] /\ call' = [call EXCEPT ![p] = "none"] /\ loc' = [loc EXCEPT ![p] = L0]
NewPending(s, at, g) == pending' = [s |-> s, at |-> at, g |-> g, ver |-> cnt.p + 1] /\ cnt' = [cnt EXCEPT !.p = @ + 1]
PutLogin(k, g) == login' = [k |-> k, g |-> g, ver |-> cnt.l + 1] /\ cnt' = [cnt EXCEPT !.l = @ + 1]
PutState(v, by, g) == st' = [v |-> v, by |-> by, g |-> g, ver |-> cnt.s + 1] /\ cnt' = [cnt EXCEPT !.s = @ + 1]
\* deleteSandbox ends the jobs whose kept sandbox it finds (all from their slot step on, Index.tla)
EndJobs == loc' = [q \in Procs |-> IF call[q] = "job" /\ pc[q] \in JobAt THEN [loc[q] EXCEPT !.kill = TRUE] ELSE loc[q]]

FirstPc == [start |-> "s.get", finish |-> "f.get", cancel |-> "c.get", signout |-> "o.dels", job |-> "j.lim"]
Begin(p) ==
  /\ pc[p] = "idle" /\ calls < MaxCalls /\ clock <= LastCall
  /\ \E k \in Kinds :
       /\ k = "start" => nstart < MaxStarts
       /\ call' = [call EXCEPT ![p] = k]
       /\ pc' = [pc EXCEPT ![p] = FirstPc[k]]
       /\ nstart' = IF k = "start" THEN nstart + 1 ELSE nstart
       /\ loc' = [loc EXCEPT ![p] = [L0 EXCEPT
                    !.g = IF k = "start" THEN nstart + 1 ELSE 0,
                    !.old = CASE k = "signout" -> {sbx[i].g : i \in 1..nsbx}
                              [] k = "cancel" -> 1..nsbx
                              [] OTHER -> {}]]
  /\ calls' = calls + 1
  /\ UNCHANGED <<clock, store, sbx, nsbx, outOld, cancelled, cancelledG, committed>>

-----------------------------------------------------------------------------
\* dropPending (login.ts:138-143), as start, finish's ranOut, cancel and signOut run it: get, then delete, then destroy.
\* "record": update (store.ts:25-32) puts an empty entry with cas, so the entry it ends is the one it read; no delete
\* (a delete after the cas would remove the entry of a connectLogin that registered meanwhile). An ended entry
\* (g = 0) is no sign-in; it keeps its sandbox, which a later dropPending destroys again.
Empty(e) == e = None \/ e.g = 0
DropGet(p, from, del, kill, next) ==
  /\ pc[p] = from
  /\ Go(p, CASE pending = None -> next
              [] "record" \notin Fix -> del
              [] pending.g = 0 -> IF pending.s # 0 THEN kill ELSE next
              [] OTHER -> from \o ".cas")
  /\ loc' = [loc EXCEPT ![p].pend = pending]
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
DropCas(p, get, kill) ==
  /\ pc[p] = get \o ".cas"
  /\ IF pending # None /\ pending.ver = loc[p].pend.ver
     THEN NewPending(loc[p].pend.s, 0, 0) /\ Go(p, kill)
     ELSE Go(p, get) /\ UNCHANGED <<cnt, pending>>
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, call, loc, ghost>>
DropDel(p, from, next) ==
  /\ pc[p] = from
  /\ pending' = None
  /\ Go(p, next)
  /\ UNCHANGED <<clock, cnt, login, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* the sandbox of the entry it read; "record": an entry with no sandbox yet has none (its connectLogin destroys it)
DropKill(p, from) ==
  /\ pc[p] = from
  /\ sbx' = IF loc[p].pend.s # 0 THEN Kill(loc[p].pend.s) ELSE sbx

\* ---- connectLogin: login.ts start
\* d7c34b7: 157 dropPending, then 158-171 below
SGet(p) == "record" \notin Fix /\ DropGet(p, "s.get", "s.del", "s.kill", "s.create")
SDel(p) == DropDel(p, "s.del", "s.kill")
SKill(p) == DropKill(p, "s.kill") /\ Go(p, "s.create") /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
\* "record": get the entry, destroy its sandbox, then cas {at} (again from the get when the cas fails)
SRGet(p) ==
  /\ "record" \in Fix /\ pc[p] = "s.get"
  /\ GoL(p, "s.okill", [loc[p] EXCEPT !.pend = pending])
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
SOKill(p) ==
  /\ pc[p] = "s.okill"
  /\ sbx' = IF loc[p].pend # None /\ loc[p].pend.s # 0 THEN Kill(loc[p].pend.s) ELSE sbx
  /\ Go(p, "s.rec")
  /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
SRec(p) ==
  /\ pc[p] = "s.rec"
  /\ IF IF pending = None THEN loc[p].pend = None ELSE loc[p].pend # None /\ loc[p].pend.ver = pending.ver
     THEN NewPending(0, clock, loc[p].g) /\ GoL(p, "s.create", [loc[p] EXCEPT !.at = clock, !.pend = [s |-> 0, at |-> clock, g |-> loc[p].g]])
     ELSE Go(p, "s.get") /\ UNCHANGED <<cnt, pending, loc>>
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, call, ghost>>
\* 158-170: at, create (timeoutMs LOGIN_MAX_MS), ensureHarness, the CLI, the poll until it shows its page
SCreate(p) ==
  /\ pc[p] = "s.create" /\ nsbx < MaxStarts
  /\ nsbx' = nsbx + 1
  /\ sbx' = [sbx EXCEPT ![nsbx + 1] = [run |-> TRUE, end |-> clock + Max, at |-> clock, done |-> FALSE, g |-> loc[p].g, shown |-> FALSE]]
  /\ GoL(p, IF "record" \in Fix THEN "s.fget" ELSE "s.put",
          [loc[p] EXCEPT !.s = nsbx + 1, !.at = IF "record" \in Fix THEN loc[p].at ELSE clock])
  /\ UNCHANGED <<clock, store, call, ghost>>
\* 171: the entry, put
SPut(p) ==
  /\ pc[p] = "s.put"
  /\ NewPending(loc[p].s, loc[p].at, loc[p].g)
  /\ Go(p, "s.keep")
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* "record": whileSigningIn on the entry itself: read it; it must still be {at} of this sign-in
SFGet(p) ==
  /\ pc[p] = "s.fget"
  /\ IF Mine(loc[p].pend) THEN GoL(p, "s.fcas", [loc[p] EXCEPT !.ver = pending.ver]) ELSE Go(p, "s.catch") /\ UNCHANGED loc
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
SFCas(p) ==
  /\ pc[p] = "s.fcas"
  /\ IF pending # None /\ pending.ver = loc[p].ver
     THEN NewPending(loc[p].s, loc[p].at, loc[p].g) /\ Go(p, "s.keep")
     ELSE Go(p, "s.fget") /\ UNCHANGED <<cnt, pending>>
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* 173: keepAlive(LOGIN_IDLE_MS); then connectLogin returns the page, and the user can sign in there
SKeep(p) ==
  /\ pc[p] = "s.keep"
  /\ sbx' = LET k == KeepAlive(loc[p].s, loc[p].at, Idle) IN [k EXCEPT ![loc[p].s].shown = TRUE]
  /\ Ret(p)
  /\ UNCHANGED <<clock, store, nsbx, ghost>>
\* "record": 180 catch: destroy the sandbox, then endPending: update the entry to empty if it is still {at} of this
\* sign-in (get, then cas)
SCatch(p) ==
  /\ pc[p] = "s.catch"
  /\ sbx' = Kill(loc[p].s)
  /\ Go(p, "s.end1")
  /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
SEnd1(p) ==
  /\ pc[p] = "s.end1"
  /\ IF Mine(loc[p].pend) THEN GoL(p, "s.end2", [loc[p] EXCEPT !.ver = pending.ver]) /\ UNCHANGED call ELSE Ret(p)
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
SEnd2(p) ==
  /\ pc[p] = "s.end2"
  /\ IF pending # None /\ pending.ver = loc[p].ver THEN NewPending(0, 0, 0) /\ Ret(p)
     ELSE Go(p, "s.end1") /\ UNCHANGED <<cnt, pending, call, loc>>
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, ghost>>

\* ---- finishLogin: login.ts finish, then agents.ts:140
\* 189-193 (and "record": no sandbox yet: `pending`)
FGet(p) ==
  /\ pc[p] = "f.get"
  /\ CASE Empty(pending) -> Ret(p)
       [] clock - pending.at > Max -> Go(p, "f.rget") /\ UNCHANGED <<call, loc>>   \* ranOut: dropPending
       [] "record" \in Fix /\ pending.s = 0 -> Ret(p)
       [] OTHER -> GoL(p, "f.resume", [loc[p] EXCEPT !.pend = pending, !.s = pending.s, !.at = pending.at]) /\ UNCHANGED call
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
FRGet(p) == DropGet(p, "f.rget", "f.rdel", "f.rkill", "f.rdone")
FRDel(p) == DropDel(p, "f.rdel", "f.rkill")
FRKill(p) == DropKill(p, "f.rkill") /\ Ret(p) /\ UNCHANGED <<clock, store, nsbx, ghost>>
FRDone(p) == pc[p] = "f.rdone" /\ Ret(p) /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 196: resume (timeoutMs LOGIN_IDLE_MS + waitMs); a sandbox that is gone: ranOut
FResume(p) ==
  /\ pc[p] = "f.resume"
  /\ IF Running(loc[p].s)
     THEN sbx' = [sbx EXCEPT ![loc[p].s].end = clock + Idle + Wait] /\ Go(p, "f.keep")
     ELSE Go(p, "f.rget") /\ UNCHANGED sbx
  /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
\* 197
FKeep(p) ==
  /\ pc[p] = "f.keep"
  /\ sbx' = KeepAlive(loc[p].s, loc[p].at, Idle + Wait)
  /\ Go(p, "f.read")
  /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
\* 198-206: the status, and present (the file in the sign-in sandbox; for cliLogin, in the volume)
FRead(p) ==
  /\ pc[p] = "f.read"
  /\ IF Running(loc[p].s) /\ sbx[loc[p].s].done /\ (Stored \/ vol.has)
     THEN Go(p, CASE "fence" \notin Fix -> "f.del" [] Stored -> "f.files" [] OTHER -> "f.sget")
          /\ UNCHANGED <<call, loc>>
     ELSE Ret(p)   \* `pending`, or it throws (the sandbox is gone), or the CLI wrote no login
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 207 (d7c34b7): the entry goes before the save
FDel(p) ==
  /\ pc[p] = "f.del"
  /\ pending' = None
  /\ IF Stored THEN Go(p, "f.files") /\ UNCHANGED loc ELSE GoL(p, "f.kill", [loc[p] EXCEPT !.ok = TRUE])
  /\ committed' = committed \cup {sbx[loc[p].s].g}
  /\ UNCHANGED <<clock, cnt, login, vol, st, limit, sbx, nsbx, call, ghost0>>
\* login-stored.ts:157: readFiles from the sign-in sandbox; it throws when the sandbox is gone
FFiles(p) ==
  /\ pc[p] = "f.files"
  /\ IF Running(loc[p].s) THEN Go(p, IF "fence" \in Fix THEN "f.lget" ELSE "f.put") /\ UNCHANGED loc
     ELSE GoL(p, "f.kill", loc[p])
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
\* login-stored.ts:159 (d7c34b7): store.put
FPut(p) ==
  /\ pc[p] = "f.put"
  /\ PutLogin("in", sbx[loc[p].s].g)
  /\ GoL(p, "f.kill", [loc[p] EXCEPT !.ok = TRUE])
  /\ UNCHANGED <<clock, pending, vol, st, limit, sbx, nsbx, call, ghost>>
\* "fence": whileSigningIn(login): get(key), get(pending) is still this sign-in's, then cas (an empty value first if none)
FLGet(p) ==
  /\ pc[p] = "f.lget"
  /\ GoL(p, "f.lmine", [loc[p] EXCEPT !.ver = login.ver, !.pl = [k |-> login.k, g |-> login.g]])
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
FLMine(p) ==
  /\ pc[p] = "f.lmine"
  /\ Go(p, IF ~Mine(loc[p].pend) THEN "f.kill" ELSE IF loc[p].ver = 0 THEN "f.lnew" ELSE "f.lcas")
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
FLNew(p) ==
  /\ pc[p] = "f.lnew"
  /\ IF login.ver = 0 THEN PutLogin("empty", 0) ELSE UNCHANGED <<cnt, login>>
  /\ Go(p, "f.lget")
  /\ UNCHANGED <<clock, pending, vol, st, limit, sbx, nsbx, call, loc, ghost>>
FLCas(p) ==
  /\ pc[p] = "f.lcas"
  /\ IF login.ver = loc[p].ver
     THEN PutLogin("in", sbx[loc[p].s].g) /\ GoL(p, "f.sget", [loc[p] EXCEPT !.lw = cnt.l + 1, !.ls = TRUE])
     ELSE Go(p, "f.lget") /\ UNCHANGED <<cnt, login, loc>>
  /\ UNCHANGED <<clock, pending, vol, st, limit, sbx, nsbx, call, ghost>>
\* "undo": the state's save failed after the login's save worked (its check of the entry comes after the login's cas):
\* get the login; if it is still the one this wrote (the sealed value is new on each save, so the same value is the
\* same version), cas the value it had before back
FLU1(p) ==
  /\ pc[p] = "f.lu1"
  /\ IF login.ver = loc[p].lw THEN GoL(p, "f.lu2", [loc[p] EXCEPT !.uv = login.ver]) ELSE Go(p, "f.kill") /\ UNCHANGED loc
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
FLU2(p) ==
  /\ pc[p] = "f.lu2"
  /\ IF login.ver = loc[p].uv THEN PutLogin(loc[p].pl.k, loc[p].pl.g) ELSE UNCHANGED <<cnt, login>>
  /\ Go(p, "f.kill")
  /\ UNCHANGED <<clock, pending, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* "fence": whileSigningIn(state, 'signed-in')
FSGet(p) ==
  /\ pc[p] = "f.sget"
  /\ GoL(p, "f.smine", [loc[p] EXCEPT !.ver = st.ver])
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
FSMine(p) ==
  /\ pc[p] = "f.smine"
  /\ Go(p, IF ~Mine(loc[p].pend) THEN (IF "undo" \in Fix /\ loc[p].ls THEN "f.lu1" ELSE "f.kill") ELSE IF loc[p].ver = 0 THEN "f.snew" ELSE "f.scas")
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
FSNew(p) ==
  /\ pc[p] = "f.snew"
  /\ IF st.ver = 0 THEN PutState("out", "empty", 0) ELSE UNCHANGED <<cnt, st>>
  /\ Go(p, "f.sget")
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, call, loc, ghost>>
FSCas(p) ==
  /\ pc[p] = "f.scas"
  /\ IF st.ver = loc[p].ver
     THEN PutState("in", "finish", sbx[loc[p].s].g) /\ GoL(p, "f.kill", [loc[p] EXCEPT !.ok = TRUE])
          /\ committed' = committed \cup {sbx[loc[p].s].g}
     ELSE Go(p, "f.sget") /\ UNCHANGED <<cnt, st, loc, committed>>
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, call, ghost0>>
\* 208: destroy the sign-in sandbox
FKill(p) ==
  /\ pc[p] = "f.kill"
  /\ \E fail \in IF DestroyFails THEN BOOLEAN ELSE {FALSE} :
       /\ sbx' = IF fail THEN sbx ELSE Kill(loc[p].s)
       /\ GoL(p, CASE "fence" \in Fix -> "f.end1" [] loc[p].ok -> "f.state" [] OTHER -> "f.ret", [loc[p] EXCEPT !.ks = fail])
  /\ UNCHANGED <<clock, store, nsbx, call, ghost>>
FRet(p) == pc[p] = "f.ret" /\ Ret(p) /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 209 (d7c34b7): setState('signed-in')
FState(p) ==
  /\ pc[p] = "f.state"
  /\ PutState("in", "finish", sbx[loc[p].s].g)
  /\ Go(p, "f.clear")
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, call, loc, ghost>>
\* "fence": endPending: update the entry to empty if it is still this sign-in's (get, then cas)
FEnd1(p) ==
  /\ pc[p] = "f.end1"
  /\ IF Mine(loc[p].pend) THEN GoL(p, "f.end2", [loc[p] EXCEPT !.ver = pending.ver])
     ELSE Go(p, IF loc[p].ok THEN "f.clear" ELSE "f.ret") /\ UNCHANGED loc
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
FEnd2(p) ==
  /\ pc[p] = "f.end2"
  /\ IF pending # None /\ pending.ver = loc[p].ver
     \* "keep": a sandbox that the provider did not destroy stays in the ended entry
     THEN NewPending(IF "keep" \in Fix /\ loc[p].ks THEN loc[p].s ELSE 0, 0, 0) /\ Go(p, IF loc[p].ok THEN "f.clear" ELSE "f.ret")
     ELSE Go(p, "f.end1") /\ UNCHANGED <<cnt, pending>>
  /\ UNCHANGED <<clock, login, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* agents.ts:140: a new sign-in ends a used-up plan (R1.9)
FClear(p) ==
  /\ pc[p] = "f.clear"
  /\ limit' = [kept |-> FALSE, g |-> 0]
  /\ Ret(p)
  /\ UNCHANGED <<clock, cnt, pending, login, vol, st, sbx, nsbx, ghost>>

\* ---- cancelLogin: dropPending
CGet(p) == DropGet(p, "c.get", "c.del", "c.kill", "c.done")
CDel(p) == DropDel(p, "c.del", "c.kill")
RetCancel(p) ==
  /\ cancelled' = cancelled \cup loc[p].old
  /\ cancelledG' = cancelledG \cup (IF loc[p].pend # None /\ loc[p].pend.g # 0 THEN {loc[p].pend.g} ELSE {})
  /\ Ret(p)
CKill(p) == DropKill(p, "c.kill") /\ RetCancel(p) /\ UNCHANGED <<clock, store, nsbx, calls, nstart, outOld, committed>>
CDone(p) == pc[p] = "c.done" /\ RetCancel(p) /\ UNCHANGED <<clock, store, sbx, nsbx, calls, nstart, outOld, committed>>

\* ---- signOut: agents.ts:168
\* deleteSandbox(user, { harness })
ODels(p, from, next) ==
  /\ pc[p] = from
  /\ EndJobs
  /\ pc' = [pc EXCEPT ![p] = next]
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, ghost>>
ODels1(p) == ODels(p, "o.dels", "o.get")
\* login.signOut: cancel (dropPending)
OGet(p) == DropGet(p, "o.get", "o.del", "o.kill", IF Stored THEN "o.lget" ELSE "o.cli")
ODel(p) == DropDel(p, "o.del", "o.kill")
OKill(p) == DropKill(p, "o.kill") /\ Go(p, IF Stored THEN "o.lget" ELSE "o.cli") /\ UNCHANGED <<clock, store, nsbx, call, loc, ghost>>
\* storedLogin, login-stored.ts:237: a login: sign out with the CLI first
OLGet(p) ==
  /\ pc[p] = "o.lget"
  /\ Go(p, IF login.k = "in" THEN "o.take" ELSE "o.ldel")
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
\* 241: load(alone) takes the login alone: it waits until no live job holds it; no login: it throws, caught at 251
OTake(p) ==
  /\ pc[p] = "o.take"
  /\ \A q \in Procs : ~(call[q] = "job" /\ pc[q] \in Holds)
  /\ Go(p, IF login.k = "in" THEN "o.give" ELSE "o.ldel")
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
\* 243-249: the CLI's sign-out, then the login is given back
OGive(p) == pc[p] = "o.give" /\ Go(p, "o.ldel") /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
\* 253: delete the stored login
OLDel(p) ==
  /\ pc[p] = "o.ldel"
  /\ login' = [k |-> "none", g |-> 0, ver |-> 0]
  /\ Go(p, "o.state")
  /\ UNCHANGED <<clock, cnt, pending, vol, st, limit, sbx, nsbx, call, loc, ghost>>
\* cliLogin, login.ts:218-224: the CLI's sign-out in a sandbox with the volume; 225: deleteVolume
OCli(p) == pc[p] = "o.cli" /\ Go(p, "o.vdel") /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
OVDel(p) ==
  /\ pc[p] = "o.vdel"
  /\ vol' = [has |-> FALSE, g |-> 0]
  /\ Go(p, "o.state")
  /\ UNCHANGED <<clock, cnt, pending, login, st, limit, sbx, nsbx, call, loc, ghost>>
\* login-stored.ts:254, login.ts:226: setState('signed-out')
OState(p) ==
  /\ pc[p] = "o.state"
  /\ PutState("out", "signout", 0)
  /\ Go(p, "o.clear")
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, call, loc, ghost>>
RetOut(p) == outOld' = outOld \cup loc[p].old /\ Ret(p)
\* agents.ts:168: limits.clear
OClear(p) ==
  /\ pc[p] = "o.clear"
  /\ limit' = [kept |-> FALSE, g |-> 0]
  /\ IF "again" \in Fix THEN Go(p, "o.dels2") /\ UNCHANGED <<call, loc, outOld>> ELSE RetOut(p)
  /\ UNCHANGED <<clock, cnt, pending, login, vol, st, sbx, nsbx, calls, nstart, cancelled, cancelledG, committed>>
\* "again": deleteSandbox once more, after the login is gone
ODels2(p) ==
  /\ pc[p] = "o.dels2"
  /\ LET l == [q \in Procs |-> IF call[q] = "job" /\ pc[q] \in JobAt THEN [loc[q] EXCEPT !.kill = TRUE] ELSE loc[q]]
     IN loc' = [l EXCEPT ![p] = L0]
  /\ outOld' = outOld \cup loc[p].old
  /\ pc' = [pc EXCEPT ![p] = "idle"] /\ call' = [call EXCEPT ![p] = "none"]
  /\ UNCHANGED <<clock, store, sbx, nsbx, calls, nstart, cancelled, cancelledG, committed>>

\* ---- a job: job.ts run
\* 364-365: a kept usage limit: it ends at once, with no sandbox
JLim(p) ==
  /\ pc[p] = "j.lim"
  /\ IF limit.kept THEN Ret(p) ELSE Go(p, "j.slot") /\ UNCHANGED <<call, loc>>
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 247-265: the kept sandbox (slots.take, resume or create, slots.set): from now on deleteSandbox finds it
JSlot(p) == pc[p] = "j.slot" /\ Go(p, "j.check") /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>
\* 276 -> credential.ts:46: present (storedLogin: login-stored.ts:200; cliLogin: the file in the volume)
JCheck(p) ==
  /\ pc[p] = "j.check"
  /\ CASE loc[p].kill -> Ret(p)
       [] LoginStored -> GoL(p, IF Stored THEN "j.take" ELSE "j.run", [loc[p] EXCEPT !.g = vol.g]) /\ UNCHANGED call
       [] OTHER -> Go(p, "j.out") /\ UNCHANGED <<call, loc>>
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* credential.ts:47: setState('signed-out'), then LoginError
JOut(p) ==
  /\ pc[p] = "j.out"
  /\ PutState("out", "check", 0)
  /\ Ret(p)
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, ghost>>
\* 281 -> login-stored.ts:164-166 take: in line after signOut's take, which wants the login alone
JTake(p) ==
  /\ pc[p] = "j.take"
  /\ \A q \in Procs : ~(call[q] = "signout" /\ pc[q] \in {"o.take", "o.give"})
  /\ CASE loc[p].kill -> Ret(p)
       [] login.k = "in" -> GoL(p, "j.run", [loc[p] EXCEPT !.g = login.g]) /\ UNCHANGED call
       [] OTHER -> Ret(p)   \* "not signed in": a sandbox error
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 399-411: the harness ends: it worked, the lab refused the login (expired), the plan is used up, or another error;
\* a job whose sandbox deleteSandbox ended fails
JRun(p) ==
  /\ pc[p] = "j.run"
  /\ IF loc[p].kill THEN Ret(p)
     ELSE \E o \in {"ok", "expired", "limit", "error"} :
            IF o = "error" THEN Ret(p) ELSE GoL(p, "j.rep", [loc[p] EXCEPT !.out = o]) /\ UNCHANGED call
  /\ UNCHANGED <<clock, store, sbx, nsbx, ghost>>
\* 413 -> credential.ts:53: setState('expired'); 414: limits.set; 423 -> credential.ts:53: state(), then setState
JRep(p) ==
  /\ pc[p] = "j.rep"
  /\ CASE loc[p].out = "expired" -> PutState("expired", "job", loc[p].g) /\ Ret(p) /\ UNCHANGED <<limit>>
       [] loc[p].out = "limit" -> limit' = [kept |-> TRUE, g |-> loc[p].g] /\ Ret(p) /\ UNCHANGED <<cnt, st>>
       [] OTHER -> (IF StateV = "in" THEN Ret(p) ELSE Go(p, "j.rput") /\ UNCHANGED <<call, loc>>) /\ UNCHANGED <<cnt, st, limit>>
  /\ UNCHANGED <<clock, pending, login, vol, sbx, nsbx, ghost>>
JRPut(p) ==
  /\ pc[p] = "j.rput"
  /\ PutState("in", "job", loc[p].g)
  /\ Ret(p)
  /\ UNCHANGED <<clock, pending, login, vol, limit, sbx, nsbx, ghost>>

-----------------------------------------------------------------------------
\* the user finishes on the lab's page that connectLogin showed: the CLI writes its login (cliLogin: into the volume)
UserDone ==
  \E i \in Ids :
    /\ Running(i) /\ sbx[i].shown /\ ~sbx[i].done
    /\ sbx' = [sbx EXCEPT ![i].done = TRUE]
    /\ vol' = IF Stored THEN vol ELSE [has |-> TRUE, g |-> sbx[i].g]
    /\ UNCHANGED <<clock, cnt, pending, login, st, limit, nsbx, pc, call, loc, ghost>>

Die(p) ==
  /\ Crash /\ pc[p] \notin {"idle", "dead"}
  /\ pc' = [pc EXCEPT ![p] = "dead"]
  /\ UNCHANGED <<clock, store, sbx, nsbx, call, loc, ghost>>

\* the provider ends a sandbox at its time; a live backend's call ends within the minute it began
Tick ==
  /\ clock < MaxTime
  /\ \A p \in Procs : pc[p] \in {"idle", "dead"}
  /\ clock' = clock + 1
  /\ sbx' = [i \in Ids |-> IF sbx[i].run /\ sbx[i].end <= clock + 1 THEN [sbx[i] EXCEPT !.run = FALSE] ELSE sbx[i]]
  /\ UNCHANGED <<store, nsbx, pc, call, loc, ghost>>

Step(p) ==
  \/ SGet(p) \/ SDel(p) \/ SKill(p) \/ SRGet(p) \/ SRec(p) \/ SOKill(p) \/ SCreate(p) \/ SPut(p) \/ SFGet(p) \/ SFCas(p) \/ SKeep(p)
  \/ SCatch(p) \/ SEnd1(p) \/ SEnd2(p)
  \/ FGet(p) \/ FRGet(p) \/ FRDel(p) \/ FRKill(p) \/ FRDone(p) \/ FResume(p) \/ FKeep(p) \/ FRead(p) \/ FDel(p)
  \/ FFiles(p) \/ FPut(p) \/ FLGet(p) \/ FLMine(p) \/ FLNew(p) \/ FLCas(p) \/ FLU1(p) \/ FLU2(p) \/ FSGet(p) \/ FSMine(p) \/ FSNew(p)
  \/ FSCas(p) \/ FKill(p) \/ FRet(p) \/ FState(p) \/ FEnd1(p) \/ FEnd2(p) \/ FClear(p)
  \/ CGet(p) \/ CDel(p) \/ CKill(p) \/ CDone(p)
  \/ DropCas(p, "f.rget", "f.rkill") \/ DropCas(p, "c.get", "c.kill") \/ DropCas(p, "o.get", "o.kill")
  \/ ODels1(p) \/ OGet(p) \/ ODel(p) \/ OKill(p) \/ OLGet(p) \/ OTake(p) \/ OGive(p) \/ OLDel(p) \/ OCli(p)
  \/ OVDel(p) \/ OState(p) \/ OClear(p) \/ ODels2(p)
  \/ JLim(p) \/ JSlot(p) \/ JCheck(p) \/ JOut(p) \/ JTake(p) \/ JRun(p) \/ JRep(p) \/ JRPut(p)

Next ==
  \/ Tick \/ UserDone
  \/ \E p \in Procs : Begin(p) \/ Die(p) \/ Step(p)

Spec == Init /\ [][Next]_vars
\* Fairness: a live backend finishes its call (its steps are store and provider calls that return); the provider's
\* timer runs (Tick). The app (Begin), the user (UserDone) and a backend that died (Die, then no step) get none.
FairSpec == Spec /\ (\A p \in Procs : WF_vars(Step(p))) /\ WF_vars(Tick)

-----------------------------------------------------------------------------
\* R1.7: a sign-in lasts LOGIN_MAX_MS at most: no sign-in sandbox runs past its start + Max (while a finish is
\* between its resume and its keepAlive, the sandbox may for that moment)
Resuming(i) == \E p \in Procs : call[p] = "finish" /\ pc[p] = "f.keep" /\ loc[p].s = i
Cap == \A i \in Ids : (Running(i) /\ ~Resuming(i)) => sbx[i].end <= sbx[i].at + Max

\* R1.7: once a cancelLogin returned, no sign-in sandbox that was created before it began runs, except while a call
\* that ends it is still in that call (or died in it): the connectLogin that created it (it destroys it before it
\* returns), or a dropPending of another call that already took its entry and destroys it next
DropAt == {"s.okill", "s.del", "s.kill", "f.rdel", "f.rkill", "c.del", "c.kill", "o.del", "o.kill"}
StartOf(i) == \E p \in Procs : pc[p] # "idle" /\
                ((call[p] = "start" /\ loc[p].s = i) \/ (pc[p] \in DropAt /\ loc[p].pend # None /\ loc[p].pend.s = i))
CancelEnds == \A i \in cancelled : Running(i) => StartOf(i)

\* R1.7: when no call runs (and no backend died in one), the only sign-in sandbox that runs is the one of the sign-in in
\* progress: the app's next cancelLogin or signOut ends it
\* (an ended entry keeps its sandbox, which the next dropPending destroys)
NoStray == (\A p \in Procs : pc[p] = "idle") => \A i \in Ids : Running(i) => (pending # None /\ pending.s = i)

\* R1.7: a cancelLogin wins over a finishLogin that has not committed: once the cancel returned and that finishLogin
\* returned too, no login and no 'signed-in' of the sign-in it ended stays (a finishLogin whose backend died may
\* leave one: a store with no transactions cannot rule that out)
FinishOf(g) == \E p \in Procs : call[p] = "finish" /\ pc[p] # "idle" /\ loc[p].s \in Ids /\ sbx[loc[p].s].g = g
CancelWins == \A g \in cancelledG \ committed : ~FinishOf(g) =>
                /\ ~(login.k = "in" /\ login.g = g)
                /\ ~(st.v = "in" /\ st.by = "finish" /\ st.g = g)

\* R1.6: once a signOut returned, no sign-in whose sandbox was created before it began has its login stored (or in
\* the volume), or the state "signed-in" that its finishLogin wrote
SignOutWins ==
  /\ login.k = "in" => login.g \notin outOld
  /\ vol.has => vol.g \notin outOld
  /\ (st.v = "in" /\ st.by = "finish") => st.g \notin outOld

\* R1.6: "signed-in" only while the user has a login (or a signOut runs)
StateTrue == StateV = "in" => (LoginStored \/ Busy("signout"))
\* R1.6: "expired" only from a job of the login stored now
ExpiredTrue == (StateV = "expired" /\ LoginStored) => st.g = LoginGen
\* R1.6: a stored login, with no sign-in or sign-out running, is not "signed-out"
InTrue == (LoginStored /\ ~Busy("finish") /\ ~Busy("signout") /\ Empty(pending)) => StateV # "out"
\* R1.9: a kept usage limit is the stored login's (a new sign-in and a sign-out end it)
LimitTrue == limit.kept => ((LoginStored /\ limit.g = LoginGen) \/ Busy("finish") \/ Busy("signout"))
\* signOut deletes the user's sandboxes: once it returned, no job runs with a login of before it
NoJobAfterSignOut == \A p \in Procs : (call[p] = "job" /\ pc[p] = "j.run" /\ ~loc[p].kill) => loc[p].g \notin outOld

\* the user's sign-in sandboxes end, also when the app leaves them and backends die
SignInEnds == <>[](\A i \in Ids : ~sbx[i].run)
\* a call of a live backend returns
CallsEnd == \A p \in Procs : [](pc[p] \notin {"idle", "dead"} => <>(pc[p] \in {"idle", "dead"}))
=============================================================================
