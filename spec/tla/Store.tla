------------------------------ MODULE Store ------------------------------
(***************************************************************************)
(* byoa keeps every lease, line and index in the app's store, through four *)
(* calls (src/store.ts, Store: get, put, delete, cas). The other models    *)
(* (LoginLease, JobTiming, Index, ...) assume a linearizable store whose   *)
(* versions never repeat for a key. This model checks that assumption for  *)
(* each adapter, and what byoa's store-based algorithms do when an         *)
(* adapter's guarantees are weaker.                                        *)
(*                                                                         *)
(* THE STORE. Each call goes through call[p] (the caller's request) and    *)
(* res[p] (its answer), with the store's own steps in between. Adapter:    *)
(*  "atomic"   each call is one step: memoryStore (src/store.ts 35-51:     *)
(*             each method runs to its end with no await, in one JS        *)
(*             thread) and sqliteStore (examples/mail/store.ts 8-26,       *)
(*             examples/todo/todos.ts 27-45: one node:sqlite statement,    *)
(*             synchronous, autocommit; SQLite's file lock serializes      *)
(*             statements of several processes on one file).               *)
(*  "postgres" src/store/postgres.ts, READ COMMITTED, each call one        *)
(*             autocommit statement on any connection of a pool: get       *)
(*             (29-32) reads the committed rows at the statement's start;  *)
(*             delete and cas(v) (37, 42) first find the rows their WHERE  *)
(*             matches in that snapshot (PgScan), then lock the row        *)
(*             (PgLock, waiting for a writer that holds it), then          *)
(*             re-evaluate the WHERE on the latest committed version and   *)
(*             write and commit (PgCommit), as the PostgreSQL docs say     *)
(*             (13.2.1); put (34) and cas(null) (41) are INSERT ... ON     *)
(*             CONFLICT, which in READ COMMITTED inserts, or updates /     *)
(*             does nothing, against the latest committed row, also one    *)
(*             that its snapshot did not see. Versions: one sequence.      *)
(*  "convex"   src/store/convex.ts: each call one Convex function. get is  *)
(*             a query (25-31, read at the latest snapshot: convexStore    *)
(*             does not pass useStaleSnapshot); put, remove and cas are    *)
(*             mutations (32-58), serializable with optimistic concurrency *)
(*             control: CxRead reads the row by key at a snapshot,         *)
(*             CxCommit commits if no other commit changed it since, else  *)
(*             Convex runs the mutation again. Versions `${_id}.${n}`.     *)
(*                                                                         *)
(* THE WEAKER BEHAVIORS, each a constant:                                  *)
(*  StaleRead = s  a get answers one of the s committed states of the key  *)
(*                 before the latest (a read replica, a cache): GetStale.  *)
(*  LostAck        a write commits, and its caller gets an error (the      *)
(*                 network failed after the commit). At most Faults times. *)
(*                 Only a write that changed the store: one that changed   *)
(*                 nothing and errs is an error before the commit.         *)
(*  Retry          the app's query function sends a write again, once,     *)
(*                 after an error, and answers what the second one did.    *)
(*  ABA            versions are a per-row counter: a row that is deleted   *)
(*                 and written again starts at 1 again.                    *)
(*                                                                         *)
(* THE CALLERS (Client), each byoa's code as it is at d7c34b7 (lease:      *)
(* also 1a58e3c and the fix):             *)
(*  "ops"   any calls (put, delete, cas with the version last read, get):  *)
(*          to check that each adapter refines StoreLin.tla (Refines).     *)
(*  "index" update() (src/store.ts 25-32) of one index by Jobs that each   *)
(*          add their own item, and Rm, which removes RmItem: the slot     *)
(*          index (src/slots.ts 19-20, take 26/31/34, remove 71), the      *)
(*          grant index (src/mcp/grants.ts 68-70, save 53, remove 59) and  *)
(*          the conversation index (src/conversation.ts 47-51, 98). Their  *)
(*          f leave the value as it is when the item is already there /    *)
(*          not there, so update() returns at line 29 with no write.       *)
(*          Fix (an alternative, not proposed as a patch): update() cas'es *)
(*          the unchanged value instead of returning at line 29.           *)
(*  "lease" the slot's lease (src/slots.ts at 1a58e3c, and fix2.patch) and *)
(*          the job that holds it (src/job.ts open 245-310, close 225-243): *)
(*          take (slots.ts 27-45: read, then cas when the lease ran out),   *)
(*          then set with the new sandbox (slots.ts 50-54, job.ts 266-272), *)
(*          the renew once the job has the login (slots.ts 58-63, job.ts    *)
(*          291), and close's set with until 0 (job.ts 240-242). Rm deletes *)
(*          the slot (slots.remove 75). Beat: the first job's heartbeat     *)
(*          (job.ts 251: renew every minute from before take until the      *)
(*          harness starts) runs one renew while that job sets its new      *)
(*          sandbox. TakeV is take's version:                               *)
(*            "d7c34b7" an error of the cas throws; false: poll again;      *)
(*            "ad8b78d" (= 1a58e3c) after an error or false, mine(): one    *)
(*                      read; the slot names this holder: held; else the   *)
(*                      cas's error, or an error of that read, throws;     *)
(*            "poll"    a cas error or false is a poll that found nothing; *)
(*                      a slot that names this holder and runs is held     *)
(*                      (the reviewer's suggestion alone);                 *)
(*            "fix"     "poll", and mine() after the cas (its error is      *)
(*                      false), and a take that throws (waitMs, a store    *)
(*                      error) first gives back a lease that its cas may   *)
(*                      have written (fix2.patch).                         *)
(*          SetLoop: set and renew try again while the holder holds the     *)
(*          slot, as update() does (fix2.patch); else one get and one cas.  *)
(*          GetFail: a get may answer an error (counts in Faults); close's  *)
(*          read is spared, since a close that fails leaves the lease in   *)
(*          every version, as a backend that dies does. Wait: inLine may    *)
(*          throw its timeout after a call that found nothing (waitMs).     *)
(*  "line"  the line of waiting jobs (src/queue.ts inLine 30-57, leave     *)
(*          59-68) in front of a resource that another job "x" holds at    *)
(*          first; take() is one step on that resource (busy).             *)
(*                                                                         *)
(* PROPERTIES                                                              *)
(*  Refines        the adapter refines StoreLin!Spec (identity mapping).  *)
(*  NoLostUpdate   index: an item whose update() returned, and that no     *)
(*                 remove of it began after that update began, is in the   *)
(*                 index.                                                  *)
(*  NoSteal        lease: a write never gives the slot to another holder   *)
(*                 while the lease of its holder runs (only deleteSandbox  *)
(*                 may take a slot from a job, by deleting it).            *)
(*  NoStrayLease   lease: a lease that runs names a job that knows it      *)
(*                 holds it, or (poll, fix) is still in take, whose next   *)
(*                 read or give-back finds it (Knows).                     *)
(*  FIFO           line: a job never takes the resource before a job that  *)
(*                 had a ticket in the line when it came.                  *)
(*  NoStrayTicket  line: a job that left the line has no ticket in it      *)
(*                 (unless its ticket ran out).                            *)
(*  Termination    index, line: every caller ends.                         *)
(*                                                                         *)
(* FAIRNESS. Client steps and store steps are weakly fair (a live backend, *)
(* a live database). PgLock is strongly fair (Postgres's lock queue).      *)
(* GetFresh is strongly fair: a replica catches up, so of infinitely many  *)
(* reads infinitely many are fresh. Expire is weakly fair: 30 s pass       *)
(* (queue.ts TICKET_MS). XRelease is weakly fair. Tick (lease) has no      *)
(* fairness: the lease models check safety only.                           *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - One key per model. Values are what the code's JSON stands for: a set *)
(*    of items for an index (the code compares JSON strings, and its f     *)
(*    returns the same list when nothing changes, so set equality is the   *)
(*    same test), a record (holder, until) for a slot, a sequence of job   *)
(*    ids for a line.                                                      *)
(*  - An error that comes before a write commits (the database is down) is *)
(*    not modeled: it is a plain failure of the call, and every caller     *)
(*    already handles it as it handles a throw. Only the error after a     *)
(*    commit (LostAck) is.                                                 *)
(*  - "postgres": one lock per key stands for the row lock and the unique  *)
(*    index's wait for an insert or delete in progress; an INSERT ... ON   *)
(*    CONFLICT DO NOTHING that meets a row being updated waits in the      *)
(*    model, where Postgres does nothing at once: the answer is the same   *)
(*    (a row is there). The tentative write and the commit are one step    *)
(*    (PgCommit): under the lock no other write of the key can come        *)
(*    between, and a get does not see an uncommitted row.                  *)
(*  - "convex": the read set of a mutation is its one row by key; Convex   *)
(*    also tracks the index range, which the entry's existence stands for. *)
(*  - The lease model has no line: jobs call take at the same time, which  *)
(*    inLine allows (two jobs that both see an empty line both call take) *)
(*    and which covers every order the line allows. It has no sandbox: the *)
(*    slot holds the holder and the lease's end, and every job creates a   *)
(*    new sandbox (set). take's index() calls are not modeled (Index.tla). *)
(*    The job's own renew runs once; the heartbeat (Beat) runs once, for   *)
(*    the first job, and only while it sets its sandbox: the window where *)
(*    a renew breaks set. At most Faults faults (lost answers and failed   *)
(*    gets) in a behavior: a store that keeps failing can still leave a    *)
(*    lease until it runs out (take's give-back fails too).                *)
(*  - The line model: take() is one atomic step on `busy`, the resource    *)
(*    (its own store calls are the lease model's). A waiting job's ticket  *)
(*    does not run out (its backend lives and renews it); a ticket of a    *)
(*    job that stopped waiting runs out (Expire). The ticket's renewal     *)
(*    (queue.ts 45-47 with at >= 0) is not modeled.                        *)
(*  - Time (lease): a step of 1 is the lease's unit; a step of a live      *)
(*    backend takes no time.                                               *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  Adapter,      \* "atomic", "postgres" or "convex"
  StaleRead,    \* a get may answer one of this many committed states before the latest
  LostAck,      \* a write may commit and answer an error
  Retry,        \* the app's query function sends a write again once after an error
  ABA,          \* versions are a per-row counter that starts again at 1
  Faults,       \* lost answers in one behavior, at most
  Client,       \* "ops", "index", "lease" or "line"
  Jobs,         \* the callers
  Rm,           \* index: the remover; lease: the one that deletes the slot
  RmItem,       \* index: the item that Rm removes (one of Jobs; its job adds it again)
  Fix,          \* index: update() writes an unchanged value with cas instead of returning (an alternative)
  TakeV,        \* lease: slots.take as at "d7c34b7", "ad8b78d" (= 1a58e3c), "poll" (a reviewer's suggestion
                \* alone: a cas error is a poll that found nothing, no read after it, no give-back) or "fix" (fix2.patch)
  SetLoop,      \* lease: set and renew try again while the holder still holds the slot (fix2.patch)
  Beat,         \* lease: the first job's heartbeat (job.ts) renews the slot while the job sets its new sandbox
  GetFail,      \* lease: a get may answer an error (lease models only) (a network failure; counts in Faults), except close's
  Wait,         \* lease: take may give up after a call that found nothing (waitMs): inLine throws
  LeaseLen,     \* lease: slots.take's leaseMs
  MaxTime,      \* lease: the clock stops here
  Removes,      \* lease: how many deletes Rm makes
  OpsPerProc    \* ops: calls of each caller

NoProc == "none"
Bt == "bt"   \* the heartbeat of the first job (BJ)
BJ == CHOOSE j \in Jobs : TRUE
Procs == Jobs \cup (IF Client = "index" \/ (Client = "lease" /\ Removes > 0) THEN {Rm} ELSE {})
              \cup (IF Client = "lease" /\ Beat THEN {Bt} ELSE {})
Key == CASE Client = "index" -> "idx" [] Client = "lease" -> "slot" [] Client = "line" -> "line" [] OTHER -> "k"
Keys == {Key}
Lv(h, u) == [h |-> h, u |-> u]
NoVal == CASE Client = "index" -> {} [] Client = "lease" -> Lv(NoProc, 0) [] Client = "line" -> <<>> [] OTHER -> "none"

VARIABLES
  \* the store
  db,       \* the committed entry of each key: [ex, val, ver]
  hist,     \* its last StaleRead + 1 committed states, for stale reads
  seq,      \* the last version given (one counter: memoryStore, Postgres's sequence)
  used,     \* every version each key ever had (ghost, for Refines)
  st,       \* each caller's call inside the store: "start", "lock", "commit"
  lock,     \* postgres: who holds the row lock of each key
  snap,     \* convex: what a mutation read
  retried,  \* the app's query function sent this call again already
  faults,
  call, res,  \* each caller's call and its answer
  \* the callers
  pc,
  mine,     \* line: this job is in the line (queue.ts `mine`)
  lastv,    \* ops: the version this caller read last
  tried,    \* lease: a cas of this job's take wrote the slot, or may have (slots.ts `tried`)
  now,      \* lease: the clock
  removes,  \* lease: deletes Rm made
  must,     \* index (ghost): this item must be in the index
  clean,    \* index (ghost): no remove of this item began since its update began
  before,   \* line (ghost): the jobs in the line when this job came
  taken,    \* line: this job took the resource
  fail,     \* line: inLine threw
  expired,  \* line: jobs whose ticket ran out
  busy      \* line: who holds the resource

L == INSTANCE StoreLin

storeVars == <<db, hist, seq, used, st, lock, snap, retried, faults>>
storeLocal == <<db, hist, seq, used, st, lock, snap, faults>>
clientVars == <<pc, mine, lastv, tried, now, removes, must, clean, before, taken, fail, expired, busy>>
vars == <<storeVars, call, res, clientVars>>

ErrRes == [none |-> FALSE, err |-> TRUE, b |-> FALSE, e |-> L!None]

Init0 == CASE Client = "index" -> [ex |-> TRUE, val |-> {RmItem}, ver |-> 1]
           \* an earlier job's slot, given back (until 0); with ABA its counter is at 2
           [] Client = "lease" -> [ex |-> TRUE, val |-> Lv(NoProc, 0), ver |-> 2]
           [] OTHER -> L!None

Init ==
  /\ db = [k \in Keys |-> Init0]
  /\ hist = [k \in Keys |-> <<Init0>>]
  /\ seq = Init0.ver
  /\ used = [k \in Keys |-> IF Init0.ex THEN 1..Init0.ver ELSE {}]
  /\ st = [p \in Procs |-> "start"]
  /\ lock = [k \in Keys |-> NoProc]
  /\ snap = [p \in Procs |-> L!None]
  /\ retried = [p \in Procs |-> FALSE]
  /\ faults = 0
  /\ call = [p \in Procs |-> L!NoCall]
  /\ res = [p \in Procs |-> L!NoRes]
  /\ pc = [p \in Procs |-> CASE Client = "ops" -> 0
                             [] Client = "lease" /\ p = Rm -> "idle"
                             [] Client = "lease" /\ p = Bt -> "bidle"
                             [] OTHER -> "start"]
  /\ mine = [p \in Procs |-> FALSE]
  /\ lastv = [p \in Procs |-> 0]
  /\ tried = [p \in Procs |-> FALSE]
  /\ now = 1
  /\ removes = 0
  /\ must = [p \in Jobs |-> FALSE]
  /\ clean = [p \in Jobs |-> TRUE]
  /\ before = [p \in Jobs |-> {}]
  /\ taken = [p \in Jobs |-> FALSE]
  /\ fail = [p \in Jobs |-> FALSE]
  /\ expired = {}
  /\ busy = IF Client = "line" THEN "x" ELSE NoProc

-----------------------------------------------------------------------------
(* The store *)

Pending(p) == call[p] # L!NoCall /\ res[p] = L!NoRes /\ st[p] = "start"
IsWrite(c) == c.op \in {"put", "del", "cas"}
Keep(h) == IF Len(h) > StaleRead + 1 THEN Tail(h) ELSE h
NewVer(e) == IF ABA THEN (IF e.ex THEN e.ver + 1 ELSE 1) ELSE seq + 1

\* the call c commits over the committed entry e of key k (nothing when a cas does not match, or a delete finds none)
Commit(k, e, c) ==
  IF L!Changes(e, c)
  THEN LET n == L!After(e, c, NewVer(e)) IN
       /\ db' = [db EXCEPT ![k] = n]
       /\ hist' = [hist EXCEPT ![k] = Keep(Append(hist[k], n))]
       /\ seq' = IF ABA \/ c.op = "del" THEN seq ELSE seq + 1
       /\ used' = [used EXCEPT ![k] = used[k] \cup (IF c.op = "del" THEN {} ELSE {n.ver})]
  ELSE UNCHANGED <<db, hist, seq, used>>

\* the answer a reaches the caller; or (LostAck), when the write took effect (w), an error does; or (Retry) the
\* app's query function sends the call again
Reply(p, a, w) ==
  /\ st' = [st EXCEPT ![p] = "start"]
  /\ \/ /\ res' = [res EXCEPT ![p] = a]
        /\ UNCHANGED <<faults, retried>>
     \/ /\ LostAck /\ w /\ faults < Faults
        /\ faults' = faults + 1
        /\ IF Retry /\ ~retried[p]
           THEN retried' = [retried EXCEPT ![p] = TRUE] /\ UNCHANGED res
           ELSE res' = [res EXCEPT ![p] = ErrRes] /\ UNCHANGED retried

\* get: the latest committed entry (memoryStore 41, sqlite get, postgres 29-32 on the primary, convex query 25-31)
GetFresh(p) ==
  /\ Pending(p) /\ call[p].op = "get"
  /\ res' = [res EXCEPT ![p] = L!Ans(TRUE, db[call[p].key])]
  /\ UNCHANGED <<storeVars, call, clientVars>>

\* get from a replica or a cache that is behind: an earlier committed entry, with its version
GetStale(p) ==
  /\ StaleRead > 0 /\ Pending(p) /\ call[p].op = "get"
  /\ \E i \in 1..(Len(hist[call[p].key]) - 1) :
       res' = [res EXCEPT ![p] = L!Ans(TRUE, hist[call[p].key][i])]
  /\ UNCHANGED <<storeVars, call, clientVars>>

\* a get that answers an error (GetFail): the network failed; nothing changed. Not close's give-back: a close that
\* fails leaves the lease in every version, until it runs out, as a backend that dies does
GetErr(p) ==
  /\ GetFail /\ Client = "lease" /\ Pending(p) /\ call[p].op = "get" /\ call[p].val # Lv("close", 0) /\ faults < Faults
  /\ res' = [res EXCEPT ![p] = ErrRes] /\ faults' = faults + 1
  /\ UNCHANGED <<db, hist, seq, used, st, lock, snap, retried, call, clientVars>>

\* memoryStore put/delete/cas (src/store.ts 42-49), sqliteStore put/delete/cas: one step
AtomWrite(p) ==
  /\ Adapter = "atomic" /\ Pending(p) /\ IsWrite(call[p])
  /\ LET c == call[p] IN Commit(c.key, db[c.key], c) /\ Reply(p, L!Answer(db[c.key], c), L!Changes(db[c.key], c))
  /\ UNCHANGED <<call, lock, snap, clientVars>>

\* postgres.ts 37 (delete) and 42 (update ... where version = $3): the rows the WHERE matches in the statement's
\* snapshot; none: the statement ends (0 rows). put (34) and cas(null) (41) go to the unique index under the lock.
PgScan(p) ==
  /\ Adapter = "postgres" /\ Pending(p) /\ IsWrite(call[p])
  /\ LET c == call[p] IN LET e == db[c.key] IN
     IF (c.op = "del" /\ ~e.ex) \/ (c.op = "cas" /\ c.ver # 0 /\ ~(e.ex /\ e.ver = c.ver))
     THEN Reply(p, L!Answer(e, c), FALSE) /\ UNCHANGED <<db, hist, seq, used, lock>>
     ELSE st' = [st EXCEPT ![p] = "lock"] /\ UNCHANGED <<db, hist, seq, used, lock, res, retried, faults>>
  /\ UNCHANGED <<call, snap, clientVars>>

\* the row lock (or the unique index's wait for an insert/delete in progress)
PgLock(p) ==
  /\ Adapter = "postgres" /\ st[p] = "lock" /\ lock[call[p].key] = NoProc
  /\ lock' = [lock EXCEPT ![call[p].key] = p]
  /\ st' = [st EXCEPT ![p] = "commit"]
  /\ UNCHANGED <<db, hist, seq, used, snap, retried, faults, call, res, clientVars>>

\* READ COMMITTED: the WHERE again on the latest committed version (EvalPlanQual), or ON CONFLICT against the latest
\* committed row; write, nextval, commit, unlock
PgCommit(p) ==
  /\ Adapter = "postgres" /\ st[p] = "commit"
  /\ LET c == call[p] IN LET e == db[c.key] IN
     /\ Commit(c.key, e, c) /\ Reply(p, L!Answer(e, c), L!Changes(e, c))
     /\ lock' = [lock EXCEPT ![c.key] = NoProc]
  /\ UNCHANGED <<call, snap, clientVars>>

\* convex.ts 32-58: the mutation reads the row by key
CxRead(p) ==
  /\ Adapter = "convex" /\ Pending(p) /\ IsWrite(call[p])
  /\ snap' = [snap EXCEPT ![p] = db[call[p].key]]
  /\ st' = [st EXCEPT ![p] = "commit"]
  /\ UNCHANGED <<db, hist, seq, used, lock, retried, faults, call, res, clientVars>>

\* it commits if nothing it read changed since, else Convex runs it again (OCC)
CxCommit(p) ==
  /\ Adapter = "convex" /\ st[p] = "commit"
  /\ LET c == call[p] IN
     IF db[c.key] = snap[p]
     THEN Commit(c.key, snap[p], c) /\ Reply(p, L!Answer(snap[p], c), L!Changes(snap[p], c))
     ELSE st' = [st EXCEPT ![p] = "start"] /\ UNCHANGED <<db, hist, seq, used, res, retried, faults>>
  /\ UNCHANGED <<call, lock, snap, clientVars>>

StoreWrite(p) == AtomWrite(p) \/ PgScan(p) \/ PgCommit(p) \/ CxRead(p) \/ CxCommit(p)
StoreStep(p) == GetFresh(p) \/ GetStale(p) \/ GetErr(p) \/ StoreWrite(p) \/ PgLock(p)

-----------------------------------------------------------------------------
(* The callers. A caller's step takes the answer of its last call and makes its next call (Issue) or none (Finish). *)

Answered(p) == res[p] # L!NoRes
A(p) == res[p]
Issue(p, c) == /\ call' = [call EXCEPT ![p] = c]
               /\ res' = [res EXCEPT ![p] = L!NoRes]
               /\ retried' = [retried EXCEPT ![p] = FALSE]
Finish(p) == Issue(p, L!NoCall)
Go(p, s) == pc' = [pc EXCEPT ![p] = s]
Get(k) == [op |-> "get", key |-> k, ver |-> 0, val |-> NoVal]
Cas(k, e, v) == [op |-> "cas", key |-> k, ver |-> IF e.ex THEN e.ver ELSE 0, val |-> v]
Ended == {"done", "failed"}

(* "ops": any calls *)
OStep(p) ==
  /\ pc[p] < OpsPerProc /\ (call[p] = L!NoCall \/ Answered(p))
  /\ lastv' = [lastv EXCEPT ![p] = IF Answered(p) /\ call[p].op = "get"
                                   THEN (IF res[p].e.ex THEN res[p].e.ver ELSE 0) ELSE lastv[p]]
  /\ \E c \in {Get(Key), [op |-> "put", key |-> Key, ver |-> 0, val |-> p],
               [op |-> "del", key |-> Key, ver |-> 0, val |-> NoVal],
               [op |-> "cas", key |-> Key, ver |-> lastv'[p], val |-> p]} : Issue(p, c)
  /\ pc' = [pc EXCEPT ![p] = pc[p] + 1]
OEnd(p) == pc[p] = OpsPerProc /\ Answered(p) /\ Finish(p) /\ pc' = [pc EXCEPT ![p] = OpsPerProc + 1] /\ UNCHANGED lastv
OpsStep(p) == (OStep(p) \/ OEnd(p)) /\ UNCHANGED <<mine, tried, now, removes, must, clean, before, taken, fail, expired, busy>>

(* "index": update(store, key, f) of src/store.ts 25-32 *)
F(p, v) == IF p = Rm THEN v \ {RmItem} ELSE v \cup {p}
\* update() returned: the item must be there now, unless a remove of it began meanwhile
Ok(p) == IF p = Rm THEN UNCHANGED <<must, clean>>
         ELSE must' = [must EXCEPT ![p] = must[p] \/ clean[p]] /\ UNCHANGED clean

\* store.ts 27: get
IStart(p) ==
  /\ pc[p] = "start" /\ Issue(p, Get(Key)) /\ Go(p, "got")
  /\ IF p = Rm
     THEN must' = [must EXCEPT ![RmItem] = FALSE] /\ clean' = [clean EXCEPT ![RmItem] = FALSE]
     ELSE clean' = [clean EXCEPT ![p] = p # RmItem \/ pc[Rm] \in {"start"} \cup Ended] /\ UNCHANGED must

\* store.ts 28-30: next = f(value); next === value: return (29); else cas with the version it read (30)
IGot(p) ==
  /\ pc[p] = "got" /\ Answered(p)
  /\ LET e == A(p).e IN LET v == IF e.ex THEN e.val ELSE {} IN
     IF F(p, v) = v /\ ~(Fix /\ e.ex)
     THEN Finish(p) /\ Go(p, "done") /\ Ok(p)
     \* Fix (index): an alternative to line 29, a cas of the same value, which fails when the read was stale
     ELSE IF F(p, v) = v
     THEN Issue(p, Cas(Key, e, v)) /\ Go(p, "cased") /\ UNCHANGED <<must, clean>>
     ELSE Issue(p, Cas(Key, e, F(p, v))) /\ Go(p, "cased") /\ UNCHANGED <<must, clean>>

\* store.ts 30: true: return; false: again from 27; an error: update() throws
ICased(p) ==
  /\ pc[p] = "cased" /\ Answered(p)
  /\ IF A(p).err THEN Finish(p) /\ Go(p, "failed") /\ UNCHANGED <<must, clean>>
     ELSE IF A(p).b THEN Finish(p) /\ Go(p, "done") /\ Ok(p)
     ELSE Issue(p, Get(Key)) /\ Go(p, "got") /\ UNCHANGED <<must, clean>>

IndexStep(p) == (IStart(p) \/ IGot(p) \/ ICased(p))
                /\ UNCHANGED <<mine, lastv, tried, now, removes, before, taken, fail, expired, busy>>

(* "lease": slots.ts take, set, renew (1a58e3c, and the versions of TakeV) and job.ts open / close *)
S == "slot"
CloseGet == [op |-> "get", key |-> S, ver |-> 0, val |-> Lv("close", 0)]  \* close's read (GetErr spares it)
Holding == {"cas", "check", "checkerr", "sget", "scas", "rget", "rcas", "gget", "gcas"}
\* the job holds the slot and knows it, or its next read of the slot will show it (poll, fix: a slot that names
\* this holder is the job's)
Knows(p) == \/ pc[p] \in Holding
            \/ TakeV \in {"poll", "fix"} /\ tried[p] /\ pc[p] \in {"got", "rel", "relcas"}
Mine(e, p) == e.ex /\ e.val.h = p
Ok2(p) == ~A(p).err /\ A(p).b        \* a cas that answered true
No2(p) == ~A(p).err /\ ~A(p).b       \* a cas that answered false

\* take throws (an error, or waitMs passed): open's catch, the job fails (job.ts 247-254, 307-309); there is no slot
\* to give back (slot is undefined). fix: take's .catch first gives back a lease that its cas may have written
Throw(p) == IF TakeV = "fix" /\ tried[p] THEN Issue(p, Get(S)) /\ Go(p, "rel") ELSE Finish(p) /\ Go(p, "failed")
\* take's function returned undefined: inLine calls it again (queue.ts 35-52), or (Wait) throws its timeout (43)
Poll(p) == \/ Issue(p, Get(S)) /\ Go(p, "got")
           \/ Wait /\ Throw(p)

\* take, slots.ts 28 (inLine's read of the line, queue.ts 35, is not modeled: no line): get the slot
LStart(p) == pc[p] = "start" /\ Issue(p, Get(S)) /\ Go(p, "got")

\* slots.ts 28-37 (1a58e3c), fix2: an error throws (fix: after the give-back); poll, fix: a slot that names this
\* holder and runs is the job's; a lease that ran out (or none): cas; else undefined
LGot(p) ==
  /\ pc[p] = "got" /\ Answered(p)
  /\ IF A(p).err THEN Throw(p) /\ UNCHANGED tried
     ELSE LET e == A(p).e IN
       IF TakeV \in {"poll", "fix"} /\ Mine(e, p) /\ e.val.u >= now
       THEN Issue(p, Get(S)) /\ Go(p, "sget") /\ UNCHANGED tried
       ELSE IF ~e.ex \/ e.val.u < now
       THEN Issue(p, Cas(S, e, Lv(p, now + LeaseLen))) /\ Go(p, "cas") /\ tried' = [tried EXCEPT ![p] = TRUE]
       ELSE Poll(p) /\ UNCHANGED tried

\* the cas's answer. true: take returns the slot. d7c34b7: an error throws, false is undefined. ad8b78d (slots.ts
\* 36-39): read the slot again (checkerr after an error, check after false). poll: an error or false is undefined.
\* fix: read the slot again; an error of that read is false
LCas(p) ==
  /\ pc[p] = "cas" /\ Answered(p)
  /\ IF Ok2(p) THEN Issue(p, Get(S)) /\ Go(p, "sget")
     ELSE CASE TakeV = "d7c34b7" -> IF A(p).err THEN Finish(p) /\ Go(p, "failed") ELSE Poll(p)
            [] TakeV = "ad8b78d" -> Issue(p, Get(S)) /\ Go(p, IF A(p).err THEN "checkerr" ELSE "check")
            [] TakeV = "poll"    -> Poll(p)
            [] OTHER             -> Issue(p, Get(S)) /\ Go(p, "check")

\* mine(): the slot names this holder: take returns it. ad8b78d: an error of this read throws (checkerr: the cas's
\* error, as .catch(() => false) then throw err; check: await mine() throws); not its holder after the cas's error:
\* throws. fix: an error or another holder: undefined
LCheck(p) ==
  /\ pc[p] \in {"check", "checkerr"} /\ Answered(p)
  /\ IF ~A(p).err /\ Mine(A(p).e, p) THEN Issue(p, Get(S)) /\ Go(p, "sget")
     ELSE IF TakeV = "ad8b78d" /\ (A(p).err \/ pc[p] = "checkerr") THEN Finish(p) /\ Go(p, "failed")
     ELSE Poll(p)

\* fix: take's .catch: set({k, holder}, tried.sandbox, 0), with set's loop; then take throws
LRel(p) ==
  /\ pc[p] = "rel" /\ Answered(p)
  /\ IF ~A(p).err /\ Mine(A(p).e, p) THEN Issue(p, Cas(S, A(p).e, Lv(NoProc, 0))) /\ Go(p, "relcas")
     ELSE Finish(p) /\ Go(p, "failed")
LRelCas(p) ==
  /\ pc[p] = "relcas" /\ Answered(p)
  /\ IF SetLoop /\ No2(p) THEN Issue(p, Get(S)) /\ Go(p, "rel") ELSE Finish(p) /\ Go(p, "failed")

\* set(slot, sbx.id, until) after a new sandbox (slots.ts 50-54, job.ts 266-272): an error throws, and open's catch
\* runs close, which gives the slot back; another holder: false (deleteSandbox took it)
LSet(p) ==
  /\ pc[p] = "sget" /\ Answered(p)
  /\ IF A(p).err THEN Issue(p, CloseGet) /\ Go(p, "gget")
     ELSE IF Mine(A(p).e, p) THEN Issue(p, Cas(S, A(p).e, Lv(p, now + LeaseLen))) /\ Go(p, "scas")
     ELSE Finish(p) /\ Go(p, "failed")
\* set's cas. false (1a58e3c): open sets slot = undefined and throws "the user's sandbox was deleted while this job
\* started"; close destroys the new sandbox and, with no slot, never gives it back. SetLoop: read again
LSetCas(p) ==
  /\ pc[p] = "scas" /\ Answered(p)
  /\ IF A(p).err THEN Issue(p, CloseGet) /\ Go(p, "gget")
     ELSE IF A(p).b THEN Issue(p, Get(S)) /\ Go(p, "rget")
     ELSE IF SetLoop THEN Issue(p, Get(S)) /\ Go(p, "sget")
     ELSE Finish(p) /\ Go(p, "failed")

\* the job's own renew once it has the login (job.ts 289-291, awaited; renew's error and false are ignored)
\* (slots.ts 58-63)
LRenew(p) ==
  /\ pc[p] = "rget" /\ Answered(p)
  /\ IF ~A(p).err /\ Mine(A(p).e, p) THEN Issue(p, Cas(S, A(p).e, Lv(p, now + LeaseLen))) /\ Go(p, "rcas")
     ELSE Issue(p, CloseGet) /\ Go(p, "gget")
LRenewed(p) ==
  /\ pc[p] = "rcas" /\ Answered(p)
  /\ IF SetLoop /\ No2(p) THEN Issue(p, Get(S)) /\ Go(p, "rget") ELSE Issue(p, CloseGet) /\ Go(p, "gget")

\* close: set(slot, slot.sandbox, 0) (job.ts 240-242). false (1a58e3c) leaves the lease; SetLoop: read again
LGive(p) ==
  /\ pc[p] = "gget" /\ Answered(p)
  /\ IF ~A(p).err /\ Mine(A(p).e, p) THEN Issue(p, Cas(S, A(p).e, Lv(NoProc, 0))) /\ Go(p, "gcas")
     ELSE Finish(p) /\ Go(p, "done")
LGiven(p) ==
  /\ pc[p] = "gcas" /\ Answered(p)
  /\ IF SetLoop /\ No2(p) THEN Issue(p, CloseGet) /\ Go(p, "gget") ELSE Finish(p) /\ Go(p, "done")

\* BJ's heartbeat (job.ts 251: every minute, from before take until the harness starts; not awaited, errors caught):
\* one renew that starts while BJ sets its new sandbox, and runs on after (close and clearInterval do not stop it)
BStart == pc[Bt] = "bidle" /\ pc[BJ] \in {"sget", "scas"} /\ Issue(Bt, Get(S)) /\ Go(Bt, "bget")
BGot == /\ pc[Bt] = "bget" /\ Answered(Bt)
        /\ IF ~A(Bt).err /\ Mine(A(Bt).e, BJ) THEN Issue(Bt, Cas(S, A(Bt).e, Lv(BJ, now + LeaseLen))) /\ Go(Bt, "bcas")
           ELSE Finish(Bt) /\ Go(Bt, "bdone")
BCas == /\ pc[Bt] = "bcas" /\ Answered(Bt)
        /\ IF SetLoop /\ No2(Bt) THEN Issue(Bt, Get(S)) /\ Go(Bt, "bget") ELSE Finish(Bt) /\ Go(Bt, "bdone")

\* slots.remove 75: delete the slot (deleteSandbox, signOut)
RmDel == pc[Rm] = "idle" /\ removes < Removes /\ Issue(Rm, [op |-> "del", key |-> S, ver |-> 0, val |-> NoVal])
         /\ Go(Rm, "rdel") /\ removes' = removes + 1
RmEnd == pc[Rm] = "rdel" /\ Answered(Rm) /\ Finish(Rm) /\ Go(Rm, "idle") /\ UNCHANGED removes

LeaseStep(p) ==
  /\ \/ p \in Jobs /\ UNCHANGED removes
                   /\ \/ LGot(p)
                      \/ /\ \/ LStart(p) \/ LCas(p) \/ LCheck(p) \/ LRel(p) \/ LRelCas(p) \/ LSet(p) \/ LSetCas(p)
                            \/ LRenew(p) \/ LRenewed(p) \/ LGive(p) \/ LGiven(p)
                         /\ UNCHANGED tried
     \/ p = Rm /\ (RmDel \/ RmEnd) /\ UNCHANGED tried
     \/ p = Bt /\ (BStart \/ BGot \/ BCas) /\ UNCHANGED <<removes, tried>>
  /\ UNCHANGED <<mine, lastv, now, must, clean, before, taken, fail, expired, busy>>

Tick == now < MaxTime /\ now' = now + 1 /\ UNCHANGED <<storeVars, call, res, pc, mine, lastv, tried, removes, must, clean, before, taken, fail, expired, busy>>

(* "line": queue.ts inLine and leave *)
LK == "line"
InSeq(p, l) == \E i \in 1..Len(l) : l[i] = p
\* queue.ts 16-19: the tickets that did not run out
Live(l) == SelectSeq(l, LAMBDA t : t \notin expired)
Pos(l, p) == IF InSeq(p, l) THEN (CHOOSE i \in 1..Len(l) : l[i] = p) - 1 ELSE -1
Stored == IF db[LK].ex THEN db[LK].val ELSE <<>>
Waiting == {"start", "got", "join"}
AfterLeave(p) == IF fail[p] THEN "failed" ELSE "use"

\* a job comes: inLine's first get (queue.ts 35)
QStart(p) ==
  /\ pc[p] = "start" /\ Issue(p, Get(LK)) /\ Go(p, "got")
  /\ before' = [before EXCEPT ![p] = {q \in Jobs : InSeq(q, Live(Stored))}]
  /\ UNCHANGED <<mine, taken, fail, expired, busy>>

\* queue.ts 36-51: first in line (or no line and not in it): take; else join the line (cas), or wait and read again
QGot(p) ==
  /\ pc[p] = "got" /\ Answered(p)
  /\ LET e == A(p).e IN
     LET line == Live(IF e.ex THEN e.val ELSE <<>>) IN
     LET at == IF mine[p] THEN Pos(line, p) ELSE -1 IN
     LET ahead == IF at < 0 THEN Len(line) ELSE at IN
     IF ahead = 0 /\ busy = NoProc
     THEN \* take() returned it (40-41): inLine returns, and its finally leaves the line (55)
          /\ busy' = p /\ taken' = [taken EXCEPT ![p] = TRUE]
          /\ IF mine[p] THEN Issue(p, Get(LK)) /\ Go(p, "lgot") ELSE Finish(p) /\ Go(p, "use")
          /\ UNCHANGED <<mine, fail>>
     ELSE IF at < 0
     THEN /\ mine' = [mine EXCEPT ![p] = TRUE]
          /\ Issue(p, Cas(LK, e, Append(line, p))) /\ Go(p, "join")
          /\ UNCHANGED <<busy, taken, fail>>
     ELSE Issue(p, Get(LK)) /\ Go(p, "got") /\ UNCHANGED <<mine, busy, taken, fail>>
  /\ UNCHANGED <<before, expired>>

\* queue.ts 48: false: read again (continue); true: sleep, read again; an error: inLine throws, its finally leaves
QJoin(p) ==
  /\ pc[p] = "join" /\ Answered(p)
  /\ IF A(p).err THEN fail' = [fail EXCEPT ![p] = TRUE] /\ Issue(p, Get(LK)) /\ Go(p, "lgot")
     ELSE Issue(p, Get(LK)) /\ Go(p, "got") /\ UNCHANGED fail
  /\ UNCHANGED <<mine, before, taken, expired, busy>>

\* leave, queue.ts 61-65: no line, or nothing to take out: return; else cas the line without this ticket
QLeaveGot(p) ==
  /\ pc[p] = "lgot" /\ Answered(p)
  /\ LET e == A(p).e IN
     IF ~e.ex THEN Finish(p) /\ Go(p, AfterLeave(p))
     ELSE LET line == Live(e.val) IN
          LET next == SelectSeq(line, LAMBDA t : t # p) IN
          IF Len(next) = Len(e.val) /\ Len(next) = Len(line)
          THEN Finish(p) /\ Go(p, AfterLeave(p))
          ELSE Issue(p, Cas(LK, e, next)) /\ Go(p, "lcas")
  /\ UNCHANGED <<mine, before, taken, fail, expired, busy>>

\* queue.ts 66: true: return; false: again; an error: inLine's .catch(() => {}) (55)
QLeaveCas(p) ==
  /\ pc[p] = "lcas" /\ Answered(p)
  /\ IF ~A(p).err /\ ~A(p).b THEN Issue(p, Get(LK)) /\ Go(p, "lgot") ELSE Finish(p) /\ Go(p, AfterLeave(p))
  /\ UNCHANGED <<mine, before, taken, fail, expired, busy>>

\* the job uses the resource, and gives it back
QUse(p) == pc[p] = "use" /\ busy' = NoProc /\ Go(p, "done")
           /\ UNCHANGED <<call, res, retried, mine, before, taken, fail, expired>>

LineStep(p) == (QStart(p) \/ QGot(p) \/ QJoin(p) \/ QLeaveGot(p) \/ QLeaveCas(p) \/ QUse(p))
               /\ UNCHANGED <<lastv, tried, now, removes, must, clean>>

\* the earlier job "x" gives the resource back
XRelease == busy = "x" /\ busy' = NoProc /\ UNCHANGED <<storeVars, call, res, pc, mine, lastv, tried, now, removes, must, clean, before, taken, fail, expired>>
\* the ticket of a job that no longer waits runs out (TICKET_MS)
Expire(q) == /\ mine[q] /\ pc[q] \notin Waiting /\ q \notin expired
             /\ expired' = expired \cup {q}
             /\ UNCHANGED <<storeVars, call, res, pc, mine, lastv, tried, now, removes, must, clean, before, taken, fail, busy>>

-----------------------------------------------------------------------------

ClientStep(p) ==
  /\ CASE Client = "ops"   -> OpsStep(p)
       [] Client = "index" -> IndexStep(p)
       [] Client = "lease" -> LeaseStep(p)
       [] Client = "line"  -> LineStep(p)
  /\ UNCHANGED storeLocal

Next ==
  \/ \E p \in Procs : ClientStep(p) \/ StoreStep(p)
  \/ Client = "lease" /\ Tick
  \/ Client = "line" /\ (XRelease \/ \E q \in Jobs : Expire(q))

Fairness ==
  /\ \A p \in Procs :
       /\ WF_vars(ClientStep(p))
       /\ WF_vars(StoreWrite(p))
       /\ SF_vars(PgLock(p))
       /\ SF_vars(GetFresh(p))
  /\ WF_vars(XRelease)
  /\ \A q \in Jobs : WF_vars(Expire(q))

Spec == Init /\ [][Next]_vars /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* the adapter is the linearizable store of StoreLin.tla
Refines == L!Spec
\* the same, step by step: an action property that TLC names when it fails (check.sh reads the name)
Linearizable == [][L!Next]_<<db, call, res, used>>

\* index: an item that update() added is there, unless a remove of it began after that update began
NoLostUpdate == \A x \in Jobs : must[x] => (db[Key].ex /\ x \in db[Key].val)

\* lease: a write gives the slot to another holder only after the lease of its holder ran out
Steal == /\ db'[S].ex /\ db'[S].val.h # NoProc
         /\ db[S].ex /\ db[S].val.h # NoProc /\ db[S].val.u >= now
         /\ db'[S].val.h # db[S].val.h
NoSteal == [][~Steal]_<<db, now>>

\* lease: a lease that runs names a job that holds the slot, or is about to learn that it does
NoStrayLease == \A p \in Jobs : (db[S].ex /\ db[S].val.h = p /\ db[S].val.u >= now) => Knows(p)

\* line: a job never takes the resource before one that was in the line when it came
FIFO == \A p \in Jobs : taken[p] => \A q \in before[p] : taken[q] \/ fail[q]

\* line: a job that left the line has no ticket in it, unless its ticket ran out
NoStrayTicket == \A p \in Jobs : (pc[p] \in {"use", "done", "failed"} /\ p \notin expired) => ~InSeq(p, Stored)

Termination == <>(\A p \in Procs : pc[p] \in Ended)
=============================================================================
