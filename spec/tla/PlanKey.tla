----------------------------- MODULE PlanKey -----------------------------
(***************************************************************************)
(* The key of one user's OpenCode Go plan (R1.8) and its state (R1.6), in  *)
(* the store, while that user's jobs send requests through the relay and   *)
(* the app connects a new key or signs out (src/plan.ts planKeys: get,     *)
(* state, setState, connect, remove, relay; src/credential.ts planKey      *)
(* report; src/agents.ts connectKey, signOut).                             *)
(*                                                                         *)
(* Store entries: aikey (the key: None, or a key id; the store version of  *)
(* the entry is the key id, since each put is a new key and versions never *)
(* repeat) and aikeystate (None, or [s, key]). planKeys.state reads aikey, *)
(* then aikeystate (plan.ts:73-76); the model reads both at once, which is *)
(* sound for the properties below because they look at the store, not at  *)
(* what a reader returned.                                                 *)
(*                                                                         *)
(* OpenCode holds each key's truth: "good", "noplan" (its workspace has  *)
(* no Go plan) or "revoked". A revoked key stays revoked (a key cannot be *)
(* renewed, plan.ts:11); a workspace may subscribe or end its plan.        *)
(*                                                                         *)
(* A job: its relay requests (proxy.ts has checked the token: Tokens.tla),  *)
(* each: get the key (plan.ts:128; none: 401, nothing set, plan.ts:129),   *)
(* OpenCode's answer for that key (plan.ts:138), then setState for 401 or  *)
(* 403 (plan.ts:147-148, a step of its own: plan.ts:146 awaits the body    *)
(* first). After its last request, when it worked (its last answer 200),   *)
(* report('signed-in') (job.ts:423, credential.ts:223: state, then         *)
(* setState when it is not signed-in, two steps).                          *)
(* connectKey: OpenCode's answer for the new key (plan.ts:90), then put the *)
(* key (plan.ts:94), then setState (plan.ts:96 or 99). A key OpenCode      *)
(* refuses is not kept (plan.ts:92). signOut of a plan: delete the key,    *)
(* then the state (plan.ts:104-105; limits.clear is in UsageLimit.tla).    *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - No time: nothing here waits on a clock. A 429 is UsageLimit.tla's.   *)
(*  - The relay's job record check (job.plan, plan.ts:124) and the path    *)
(*    check are left out: they read only the token's record.               *)
(*  - A 403 whose body is not "subscription required" sets nothing; the  *)
(*    model's 403 is always no-plan.                                       *)
(*  - Tagged (the fix this spec proposes): setState writes the key id it   *)
(*    is about (the aikey version the relay read), only while that key is  *)
(*    stored, and never over the expired of the same key (a revoked key    *)
(*    stays revoked); state() ignores a state of another key. See Put.     *)
(*                                                                         *)
(* Fairness: each step of a live backend is WF (one store or HTTP call).   *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS Jobs, Changes, Kinds, Reqs, MaxKeys, MaxTruth, Tagged, Crash, None

Procs == Jobs \cup Changes
KeyIds == 1..MaxKeys

VARIABLES
  key,      \* the stored key id, or None
  st,       \* the stored state: None, or [s, key]
  nkeys,
  truth,    \* OpenCode's truth of each key
  ntruth,
  pc, kind, k, ans, sent, last,
  seen401   \* ghost: a relay set expired for key i (after OpenCode's 401 to it)

vars == <<key, st, nkeys, truth, ntruth, pc, kind, k, ans, sent, last, seen401>>

Answer(i) == CASE truth[i] = "good" -> 200 [] truth[i] = "noplan" -> 403 [] OTHER -> 401
StateOf(a) == IF a = 401 THEN "expired" ELSE IF a = 403 THEN "no-plan" ELSE "signed-in"

\* planKeys.state (plan.ts:73-76): no key, signed-out; else the stored state, else signed-in. Tagged: only a state
\* of the stored key
State ==
  IF key = None THEN "signed-out"
  ELSE IF st = None \/ (Tagged /\ st.key # key) THEN "signed-in"
  ELSE st.s

Init ==
  /\ key = 1 /\ st = None /\ nkeys = 1
  /\ truth = [i \in KeyIds |-> "good"] /\ ntruth = 0
  /\ pc = [p \in Procs |-> "idle"] /\ kind = [p \in Procs |-> "none"]
  /\ k = [p \in Procs |-> None] /\ ans = [p \in Procs |-> 0] /\ sent = [j \in Jobs |-> 0] /\ last = [j \in Jobs |-> 0]
  /\ seen401 = [i \in KeyIds |-> FALSE]

Go(p, s) == pc' = [pc EXCEPT ![p] = s]
\* setState (plan.ts:72), a put. Tagged: with the key id i, only while i is the stored key, and never over the expired
\* of the same key (a revoked key stays revoked). In the code: read aikey's version, then update (store.ts) aikeystate
\* with a cas; one atomic step here, which is sound: a key change between the two reads is followed by connectKey's
\* own setState (or by no key at all), and the cas fails when it came first
Put(x, i) == IF Tagged /\ (i # key \/ (st # None /\ st.key = i /\ st.s = "expired")) THEN st ELSE [s |-> x, key |-> i]
Keep == UNCHANGED <<key, st, nkeys, truth, ntruth, kind, seen401>>

\* --- a job's relay requests ---
JStart(j) == pc[j] = "idle" /\ Go(j, "rget") /\ Keep /\ UNCHANGED <<k, ans, sent, last>>
\* plan.ts:128-129
RGet(j) ==
  /\ pc[j] = "rget"
  /\ k' = [k EXCEPT ![j] = key]
  /\ IF key = None
     THEN /\ last' = [last EXCEPT ![j] = 401] /\ sent' = [sent EXCEPT ![j] = @ + 1]
          /\ Go(j, IF sent[j] + 1 < Reqs THEN "rget" ELSE "end")
     ELSE Go(j, "rsend") /\ UNCHANGED <<last, sent>>
  /\ Keep /\ UNCHANGED ans
\* plan.ts:138: OpenCode answers for the key the relay read
RSend(j) ==
  /\ pc[j] = "rsend"
  /\ ans' = [ans EXCEPT ![j] = Answer(k[j])]
  /\ Go(j, IF Answer(k[j]) = 200 THEN "rnext" ELSE "rset")
  /\ UNCHANGED <<key, st, nkeys, truth, ntruth, kind, k, sent, last, seen401>>
\* plan.ts:147-148: setState(expired | no-plan)
RSet(j) ==
  /\ pc[j] = "rset"
  /\ st' = Put(StateOf(ans[j]), k[j])
  /\ seen401' = IF ans[j] = 401 THEN [seen401 EXCEPT ![k[j]] = TRUE] ELSE seen401
  /\ Go(j, "rnext")
  /\ UNCHANGED <<key, nkeys, truth, ntruth, kind, k, ans, sent, last>>
RNext(j) ==
  /\ pc[j] = "rnext"
  /\ last' = [last EXCEPT ![j] = ans[j]] /\ sent' = [sent EXCEPT ![j] = @ + 1]
  /\ Go(j, IF sent[j] + 1 < Reqs THEN "rget" ELSE "end")
  /\ Keep /\ UNCHANGED <<k, ans>>
\* job.ts:422-423: a job that worked reports signed-in (credential.ts:223: state, then setState)
JEnd(j) ==
  /\ pc[j] = "end"
  /\ IF last[j] = 200 /\ State # "signed-in"
     THEN Go(j, "report") ELSE Go(j, "done")
  /\ Keep /\ UNCHANGED <<k, ans, sent, last>>
\* setState(signed-in); Tagged: of the key stored now (report knows no key of its own)
Report(j) ==
  /\ pc[j] = "report"
  /\ st' = Put("signed-in", key)
  /\ Go(j, "done")
  /\ UNCHANGED <<key, nkeys, truth, ntruth, kind, k, ans, sent, last, seen401>>

\* --- connectKey and signOut ---
CBegin(c) ==
  /\ pc[c] = "idle"
  /\ \E x \in Kinds :
       /\ kind' = [kind EXCEPT ![c] = x]
       /\ IF x = "connect"
          THEN /\ nkeys < MaxKeys /\ nkeys' = nkeys + 1 /\ k' = [k EXCEPT ![c] = nkeys + 1] /\ Go(c, "c.check")
          ELSE /\ Go(c, "o.key") /\ UNCHANGED <<nkeys, k>>
  /\ UNCHANGED <<key, st, truth, ntruth, ans, sent, last, seen401>>
\* plan.ts:90-93: OpenCode's answer for the new key; a key it refuses is not kept
CCheck(c) ==
  /\ pc[c] = "c.check"
  /\ ans' = [ans EXCEPT ![c] = Answer(k[c])]
  /\ Go(c, IF Answer(k[c]) = 401 THEN "done" ELSE "c.put")
  /\ UNCHANGED <<key, st, nkeys, truth, ntruth, kind, k, sent, last, seen401>>
\* plan.ts:94
CPut(c) ==
  /\ pc[c] = "c.put"
  /\ key' = k[c]
  /\ Go(c, "c.state")
  /\ UNCHANGED <<st, nkeys, truth, ntruth, kind, k, ans, sent, last, seen401>>
\* plan.ts:96, 99
CState(c) ==
  /\ pc[c] = "c.state"
  /\ st' = Put(StateOf(ans[c]), k[c])
  /\ Go(c, "done")
  /\ UNCHANGED <<key, nkeys, truth, ntruth, kind, k, ans, sent, last, seen401>>
\* plan.ts:104-105
OKey(c) == pc[c] = "o.key" /\ key' = None /\ Go(c, "o.state") /\ UNCHANGED <<st, nkeys, truth, ntruth, kind, k, ans, sent, last, seen401>>
\* Tagged: not the state of a key that a connectKey stored after this signOut's delete (an app that signs out and
\* connects at the same time); state() ignores a state of another key, so this delete only tidies
OState(c) == pc[c] = "o.state" /\ st' = (IF Tagged /\ key # None /\ st # None /\ st.key = key THEN st ELSE None)
               /\ Go(c, "done") /\ UNCHANGED <<key, nkeys, truth, ntruth, kind, k, ans, sent, last, seen401>>

\* OpenCode: the user revokes a key, or its workspace subscribes or ends its plan
Truth ==
  /\ ntruth < MaxTruth /\ ntruth' = ntruth + 1
  /\ \E i \in 1..nkeys, t \in {"good", "noplan", "revoked"} :
       /\ truth[i] # "revoked" /\ t # truth[i]
       /\ truth' = [truth EXCEPT ![i] = t]
  /\ UNCHANGED <<key, st, nkeys, pc, kind, k, ans, sent, last, seen401>>

Die(p) == Crash /\ pc[p] \notin {"idle", "done", "dead"} /\ Go(p, "dead") /\ Keep /\ UNCHANGED <<k, ans, sent, last>>

JobStep(j) == RGet(j) \/ RSend(j) \/ RSet(j) \/ RNext(j) \/ JEnd(j) \/ Report(j)
ChangeStep(c) == CCheck(c) \/ CPut(c) \/ CState(c) \/ OKey(c) \/ OState(c)
Next ==
  \/ Truth
  \/ \E j \in Jobs : JStart(j) \/ JobStep(j)
  \/ \E c \in Changes : CBegin(c) \/ ChangeStep(c)
  \/ \E p \in Procs : Die(p)

Fairness == \A j \in Jobs : WF_vars(JobStep(j)) /\ \A c \in Changes : WF_vars(ChangeStep(c))
Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
\* no step is between OpenCode's answer and the write of what it says (a relay's setState, connectKey's)
Quiet == \A p \in Procs : pc[p] \notin {"rset", "c.put", "c.state", "o.state", "report"}

\* R1.6: `expired` only for a key that OpenCode refused: a new key is not expired for the old key's 401
ExpiredIsTrue == State = "expired" => truth[key] = "revoked"
\* R1.6: once a relay set expired for the stored key (OpenCode refused it), its state stays expired (no report of a
\* job that worked before puts signed-in over it). A backend that dies between OpenCode's 401 and the relay's
\* setState sets nothing: the next request finds the key refused again.
RefusedIsExpired == (Quiet /\ key # None /\ seen401[key]) => State = "expired"
\* R1.8: the relay sends a request to OpenCode only with the key stored now. A request whose relay read the key
\* before a signOut or a new key is still sent with the old key: one in flight, as R3.4 allows for a token
SentWithStoredKey == \A j \in Jobs : pc[j] = "rsend" => k[j] = key
\* every job of a live backend ends
JobsEnd == \A j \in Jobs : (pc[j] \notin {"idle", "done", "dead"}) ~> (pc[j] \in {"done", "dead"})
=============================================================================
