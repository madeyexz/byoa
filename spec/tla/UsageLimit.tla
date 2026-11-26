----------------------------- MODULE UsageLimit -----------------------------
(***************************************************************************)
(* The hold of a used-up plan (R1.9, V23) of one user and one harness (a   *)
(* lab login) or one plan (OpenCode Go), in the store, while that user's   *)
(* jobs run and the app signs the user in again, connects a new key, or    *)
(* signs out (src/limits.ts usageLimits get/set/clear; src/job.ts run;     *)
(* src/credential.ts planKey.event; src/plan.ts relay; src/agents.ts       *)
(* finishLogin, connectKey, signOut).                                      *)
(*                                                                         *)
(* A job: limits.get (job.ts:364), refused at once when the hold has not   *)
(* ended (job.ts:365); else it opens (a lab login: cred.load puts the      *)
(* login stored now in the sandbox, job.ts:281; a plan: planKey's `since`, *)
(* credential.ts:209), and makes one request to the lab or to OpenCode     *)
(* with that credential. A lab job that finds the plan used up keeps that  *)
(* (job.ts:414). A plan job's request goes through the relay, which reads  *)
(* the key now (plan.ts:128), gets OpenCode's 429 (plan.ts:138), asks the  *)
(* usage meter (plan.ts:151) and keeps the limit (plan.ts:154); the job    *)
(* then reads the limit (credential.ts:230, `l.at < since`) and, when it   *)
(* calls the error usage-limit, keeps it again (job.ts:414). A job that    *)
(* worked, and had read a hold that ended, clears it (job.ts:425).         *)
(* A credential change: finishLogin (login.finish saves the new login,     *)
(* then limits.clear: agents.ts:301-303) and connectKey (plans.connect     *)
(* puts the new key, then limits.clear: agents.ts:313-314, plan.ts:94) are *)
(* `save` then `clear`; signOut is, for a plan, limits.clear then          *)
(* plans.remove (agents.ts:329), and for a lab login, login.signOut then   *)
(* limits.clear (agents.ts:331).                                           *)
(*                                                                         *)
(* One step of time is a few minutes; Hold is the 15 minutes.              *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - Each job makes one request. A lab CLI's answer and its event to      *)
(*    job.ts are one step (`req`); the event's set is a step of its own,   *)
(*    so a credential change can come between them.                        *)
(*  - The plan of each credential is used up until a time (`used`), and    *)
(*    the tool says that time (resetsAt), so a hold's `until` is the plan's *)
(*    reset. A tool that says no time (Grok) gets Hold from the set; that  *)
(*    only changes how long a hold lasts, not who writes it.               *)
(*  - The relay's error answer and the harness's own error text are left   *)
(*    out: a 429 whose meter says used up is `usage-limit`, else           *)
(*    `rate-limited`, which keeps nothing (as the code, unless another job *)
(*    kept a limit since this job began).                                  *)
(*  - cred.ready (credential.ts:211) is left out: the relay's read of the  *)
(*    key decides; with no key the job fails and keeps nothing.            *)
(*  - All backends have one clock, so `l.at < since` never drops this      *)
(*    job's own limit. With skew (a proxy backend behind the job's) it     *)
(*    can: the job then says rate-limited, and the relay's hold stays.    *)
(*  - signOut of a lab login also deletes the user's kept sandboxes of the *)
(*    harness first (agents.ts:331), which ends their jobs; the model has  *)
(*    sandboxPer 'job' (or another sandbox key), where it does not.        *)
(*  - The login state, the lease and the sandbox are left out (SignIn,     *)
(*    LoginLease, JobTiming model them).                                   *)
(*  - CasClear (the fix): a job's clear is cas(version it read, ''), and   *)
(*    get reads '' as no limit (the store has no compare-and-delete).     *)
(*  - MaxSet (the fix): set keeps a stored `until` that is later than its *)
(*    own (a cas loop, store.ts update; one step here). Without it a job   *)
(*    that read the limit (credential.ts:230) writes that older reset at   *)
(*    job.ts:414 over a later one that another job's relay kept (main_    *)
(*    stale).                                                              *)
(*  - Open with CasClear too: a change's clear is a delete after its save, *)
(*    so a set by a job of the old credential after it (signin, newkey),   *)
(*    or by a job of the new one between them (signin_lost), is wrong; a  *)
(*    backend that dies between save and clear leaves the old hold.        *)
(*                                                                         *)
(* Fairness: time passes (WF Tick: a clock); each step of a live backend   *)
(* is WF (one store or HTTP call, which returns). A dead backend gets none.*)
(* No fairness for the app (a job may never start) or for the plan.        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Jobs, Changes, Plan, CasClear, MaxSet, Kinds, MaxTime, Hold, MaxUsedUp, OldHold, Crash, None

Creds == 0..Cardinality(Changes)
Procs == Jobs \cup Changes

VARIABLES
  clock,
  lim,      \* the store's usagelimit entry: None, or [kind ("limit" | "cleared"), until, at, cred, ver]
  nver,     \* the store's version counter (versions never repeat)
  cred,     \* the credential stored now (a sign-in, a key): it changes at each sign-in, new key, sign-out
  signedIn,
  used,     \* each credential's plan is used up until this time (the lab's or OpenCode's own state)
  nused,
  pc, kind, held, jc, since, rs,
  learned,  \* ghost: the latest `until` that a set kept for each credential
  wasted,   \* ghost: a job ran while byoa had learned that its plan is used up
  wrong     \* ghost: a job was refused for the hold of another credential

vars == <<clock, lim, nver, cred, signedIn, used, nused, pc, kind, held, jc, since, rs, learned, wasted, wrong>>

Max(a, b) == IF a > b THEN a ELSE b
IsLimit(e) == e # None /\ e.kind = "limit"
Active == IsLimit(lim) /\ lim.until > clock
\* a change has its new credential stored but has not cleared the hold yet (or, for a plan's signOut, has cleared it
\* but still has the key)
Midway == \E c \in Changes : pc[c] \in {"s.clear", "o.clear", "o.remove"}

Init ==
  /\ clock = 0 /\ nver = 1
  /\ lim \in IF OldHold THEN {None, [kind |-> "limit", until |-> 0, at |-> 0, cred |-> 0, ver |-> 1]} ELSE {None}
  /\ cred = 0 /\ signedIn = TRUE
  /\ used = [c \in Creds |-> 0] /\ nused = 0
  /\ pc = [p \in Procs |-> "idle"] /\ kind = [p \in Procs |-> "none"]
  /\ held = [j \in Jobs |-> None] /\ jc = [j \in Jobs |-> 0] /\ since = [j \in Jobs |-> 0] /\ rs = [j \in Jobs |-> 0]
  /\ learned = [c \in Creds |-> 0] /\ wasted = FALSE /\ wrong = FALSE

Go(p, s) == pc' = [pc EXCEPT ![p] = s]
Write(e) == /\ lim' = [e EXCEPT !.ver = nver + 1] /\ nver' = nver + 1
\* limits.set (limits.ts:137-143): a reset that has passed says nothing; else Hold from now. MaxSet (the fix): a hold
\* with a later `until` stays (store.ts update, a cas loop: one atomic step), with `at` now
SetLimit(j) ==
  LET mine == IF rs[j] > clock THEN rs[j] ELSE clock + Hold
      until == IF MaxSet /\ IsLimit(lim) /\ lim.until > mine THEN lim.until ELSE mine
  IN /\ Write([kind |-> "limit", until |-> until, at |-> clock, cred |-> jc[j], ver |-> 0])
     /\ learned' = [learned EXCEPT ![jc[j]] = Max(@, until)]

\* the app runs a job
Start(j) ==
  /\ pc[j] = "idle"
  /\ Go(j, "get")
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>

\* job.ts:364-365: held = limits.get (limits.ts:132-136: '' and bad JSON are none); refused while it holds
Get(j) ==
  /\ pc[j] = "get"
  /\ LET h == IF IsLimit(lim) THEN lim ELSE None IN
     /\ held' = [held EXCEPT ![j] = h]
     /\ IF h # None /\ h.until > clock
        THEN /\ Go(j, "done")
             /\ wrong' = (wrong \/ (signedIn /\ h.cred # cred /\ ~Midway))
             /\ UNCHANGED wasted
        ELSE /\ Go(j, "load")
             /\ wasted' = (wasted \/ (signedIn /\ learned[cred] > clock /\ used[cred] > clock /\ ~Midway))
             /\ UNCHANGED wrong
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, jc, since, rs, learned>>

\* open: a lab login's cred.load (job.ts:281) puts the stored login in the sandbox; a plan's credential takes `since`
\* (credential.ts:209), and its relay reads the key at each request (Relay below)
Load(j) ==
  /\ pc[j] = "load"
  /\ IF Plan
     THEN /\ since' = [since EXCEPT ![j] = clock] /\ Go(j, "rkey") /\ UNCHANGED jc
     ELSE IF signedIn
          THEN /\ jc' = [jc EXCEPT ![j] = cred] /\ Go(j, "req") /\ UNCHANGED since
          ELSE /\ Go(j, "done") /\ UNCHANGED <<jc, since>>   \* cred.check: LoginError
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, rs, learned, wasted, wrong>>

\* plan.ts:128: the relay reads the user's key now
RelayKey(j) ==
  /\ pc[j] = "rkey"
  /\ IF signedIn THEN jc' = [jc EXCEPT ![j] = cred] /\ Go(j, "req")
     ELSE Go(j, "done") /\ UNCHANGED jc   \* plan.ts:129: no key, 401; nothing kept
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, since, rs, learned, wasted, wrong>>

\* the request with credential jc[j] (lab: the CLI's, with the job's event; plan: plan.ts:138)
Req(j) ==
  /\ pc[j] = "req"
  /\ IF used[jc[j]] > clock
     THEN /\ rs' = [rs EXCEPT ![j] = used[jc[j]]]
          /\ Go(j, IF Plan THEN "meter" ELSE "jset")
     ELSE /\ Go(j, "jclear") /\ UNCHANGED rs   \* it worked (job.ts:422)
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, jc, since, learned, wasted, wrong>>

\* plan.ts:151-153: the usage meter, with the key the relay read
Meter(j) ==
  /\ pc[j] = "meter"
  /\ IF used[jc[j]] > clock
     THEN rs' = [rs EXCEPT ![j] = used[jc[j]]] /\ Go(j, "rset")
     ELSE Go(j, "evget") /\ UNCHANGED rs   \* no meter used up: rate-limited, kept nowhere
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, jc, since, learned, wasted, wrong>>

\* plan.ts:154: limits.set
RelaySet(j) ==
  /\ pc[j] = "rset"
  /\ SetLimit(j)
  /\ Go(j, "evget")
  /\ UNCHANGED <<clock, cred, signedIn, used, nused, kind, held, jc, since, rs, wasted, wrong>>

\* credential.ts:229-233: limits.get; usage-limit only when a limit was kept since this job began
EventGet(j) ==
  /\ pc[j] = "evget"
  /\ IF IsLimit(lim) /\ lim.at >= since[j]
     THEN rs' = [rs EXCEPT ![j] = lim.until] /\ Go(j, "jset")
     ELSE Go(j, "done") /\ UNCHANGED rs
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, jc, since, learned, wasted, wrong>>

\* job.ts:414: the job's usage-limit event: limits.set (for a plan, jc is the key its relay used)
JobSet(j) ==
  /\ pc[j] = "jset"
  /\ SetLimit(j)
  /\ Go(j, "done")
  /\ UNCHANGED <<clock, cred, signedIn, used, nused, kind, held, jc, since, rs, wasted, wrong>>

\* job.ts:425: `if (held) limits.clear`: delete (limits.ts:144); with CasClear, cas(held's version, '')
JobClear(j) ==
  /\ pc[j] = "jclear"
  /\ IF held[j] = None THEN UNCHANGED <<lim, nver>>
     ELSE IF ~CasClear THEN lim' = None /\ UNCHANGED nver
     ELSE IF lim # None /\ lim.ver = held[j].ver
          THEN Write([kind |-> "cleared", until |-> 0, at |-> 0, cred |-> 0, ver |-> 0])
          ELSE UNCHANGED <<lim, nver>>
  /\ Go(j, "done")
  /\ UNCHANGED <<clock, cred, signedIn, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>

\* the app signs the user in again, connects a new key, or signs out
Begin(c) ==
  /\ pc[c] = "idle"
  /\ \E k \in Kinds :
       /\ kind' = [kind EXCEPT ![c] = k]
       /\ Go(c, IF k = "signin" THEN "s.save" ELSE IF Plan THEN "o.clear" ELSE "o.remove")
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, held, jc, since, rs, learned, wasted, wrong>>
NewCred == cred' = cred + 1
\* agents.ts:301 login.finish saves the new login; agents.ts:313 plans.connect puts the new key (plan.ts:94)
Save(c) ==
  /\ pc[c] = "s.save"
  /\ NewCred /\ signedIn' = TRUE
  /\ Go(c, "s.clear")
  /\ UNCHANGED <<clock, lim, nver, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>
\* agents.ts:303, 314, 329, 331: limits.clear, a delete
Clear(c, from, next) ==
  /\ pc[c] = from
  /\ lim' = None
  /\ Go(c, next)
  /\ UNCHANGED <<clock, nver, cred, signedIn, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>
\* plans.remove (plan.ts:103-105) or login.signOut
Remove(c, next) ==
  /\ pc[c] = "o.remove"
  /\ NewCred /\ signedIn' = FALSE
  /\ Go(c, next)
  /\ UNCHANGED <<clock, lim, nver, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>
ChangeStep(c) ==
  \/ Begin(c) \/ Save(c) \/ Clear(c, "s.clear", "done")
  \/ (Plan /\ Clear(c, "o.clear", "o.remove")) \/ (Plan /\ Remove(c, "done"))
  \/ (~Plan /\ Remove(c, "o.clear")) \/ (~Plan /\ Clear(c, "o.clear", "done"))

\* the plan of a credential is used up until Hold from now (the lab's or OpenCode's own state)
UsedUp ==
  /\ nused < MaxUsedUp /\ clock + Hold <= MaxTime
  /\ \E c \in Creds : used[c] <= clock /\ used' = [used EXCEPT ![c] = clock + Hold]
  /\ nused' = nused + 1
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, pc, kind, held, jc, since, rs, learned, wasted, wrong>>

\* time passes to MaxTime, and after it while a hold has not ended
Tick ==
  /\ clock < MaxTime \/ Active
  /\ clock' = clock + 1
  /\ UNCHANGED <<lim, nver, cred, signedIn, used, nused, pc, kind, held, jc, since, rs, learned, wasted, wrong>>

Die(p) ==
  /\ Crash /\ pc[p] \notin {"idle", "done", "dead"}
  /\ Go(p, "dead")
  /\ UNCHANGED <<clock, lim, nver, cred, signedIn, used, nused, kind, held, jc, since, rs, learned, wasted, wrong>>

JobStep(j) ==
  Get(j) \/ Load(j) \/ RelayKey(j) \/ Req(j) \/ Meter(j) \/ RelaySet(j) \/ EventGet(j) \/ JobSet(j) \/ JobClear(j)

Next ==
  \/ Tick \/ UsedUp
  \/ \E j \in Jobs : Start(j) \/ JobStep(j)
  \/ \E c \in Changes : ChangeStep(c)
  \/ \E p \in Procs : Die(p)

LiveStep(p) == IF p \in Jobs THEN JobStep(p) ELSE ChangeStep(p) /\ pc[p] # "idle"
Fairness == WF_vars(Tick) /\ \A p \in Procs : WF_vars(LiveStep(p))
Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* R1.9: a job is refused only for a used-up plan of the credential the user has now: a hold that a job of an old
\* sign-in or an old key kept after the new sign-in (or key) ended the holds would refuse the new one's jobs until
\* the old plan resets (the user sees "usage-limit" for a plan that works)
NoWrongRefusal == ~wrong
\* the stored hold is about the credential stored now, except while a change is between its save and its clear
HoldIsCurrent == (Active /\ signedIn) => (lim.cred = cred \/ Midway)
\* R1.9: once a job kept a used-up plan, no job of that credential starts a sandbox while the plan is still used up
\* (the user sees a job that runs and fails on a used-up plan, and pays for its sandbox). A later set with an earlier
\* `until` (a job whose reset passed got the 15 minutes, the next one the real reset) is not a waste: the plan reset.
NoWastedRun == ~wasted

\* a hold always ends: time passes
HoldEnds == [](Active => <>~Active)
\* every job of a live backend ends
JobsEnd == \A j \in Jobs : (pc[j] \notin {"idle", "done", "dead"}) ~> (pc[j] \in {"done", "dead"})
\* after a hold, a job runs: a job that reads the store when no hold is active is not refused
AfterHoldJobRuns == [][\A j \in Jobs : (pc[j] = "get" /\ ~Active) => (pc'[j] \in {"get", "load", "dead"})]_vars
=============================================================================
