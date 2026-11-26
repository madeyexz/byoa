----------------------------- MODULE StoreLin -----------------------------
(***************************************************************************)
(* The store that byoa's protocols assume (src/store.ts, Store): a         *)
(* linearizable key-value store with compare-and-set. Each call of a       *)
(* caller takes effect at one instant between the call and its answer, and *)
(* answers what the store had at that instant:                             *)
(*   get(k)          the entry (value and version), or none;               *)
(*   put(k, v)       writes v;                                             *)
(*   delete(k)       removes the entry;                                    *)
(*   cas(k, ver, v)  writes v only if the entry has version ver (0 here    *)
(*                   stands for the code's null: only if there is none),   *)
(*                   and answers whether it wrote.                         *)
(* Every write gives a version that this key never had (no ABA), also     *)
(* after a delete: `used` holds the versions each key ever had.            *)
(*                                                                         *)
(* Store.tla checks that each adapter's operational model refines this     *)
(* (PROPERTY Refines), with the same variable names, so the refinement     *)
(* mapping is the identity on db, call, res and used. A call that answers  *)
(* an error is not in this spec: a store that may answer an error after a  *)
(* write took effect (a lost answer) does not refine it.                   *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS Procs, Keys, NoVal

VARIABLES db, call, res, used

None == [ex |-> FALSE, val |-> NoVal, ver |-> 0]
NoCall == [op |-> "none", key |-> "none", ver |-> 0, val |-> NoVal]
NoRes == [none |-> TRUE, err |-> FALSE, b |-> FALSE, e |-> None]
Ans(b, e) == [none |-> FALSE, err |-> FALSE, b |-> b, e |-> e]

\* cas(k, ver, v) writes when the entry has version ver, or there is none and ver is null (0)
Matches(e, c) == IF e.ex THEN c.ver = e.ver ELSE c.ver = 0
Changes(e, c) == \/ c.op = "put"
                 \/ c.op = "del" /\ e.ex
                 \/ c.op = "cas" /\ Matches(e, c)
Answer(e, c) == CASE c.op = "get" -> Ans(TRUE, e)
                  [] c.op = "cas" -> Ans(Matches(e, c), None)
                  [] OTHER        -> Ans(TRUE, None)
After(e, c, v) == IF c.op = "del" THEN None ELSE [ex |-> TRUE, val |-> c.val, ver |-> v]

Init == /\ call = [p \in Procs |-> NoCall]
        /\ res = [p \in Procs |-> NoRes]
        /\ \A k \in Keys : db[k].ex => db[k].ver \in used[k]

Others(p) == \A q \in Procs \ {p} : call'[q] = call[q]

\* a caller calls
Invoke(p) == /\ call[p] = NoCall /\ res[p] = NoRes
             /\ call'[p] # NoCall /\ Others(p)
             /\ UNCHANGED <<db, res, used>>

\* the call takes effect, at once, and its answer is ready
Exec(p) == LET c == call[p] IN
  /\ c # NoCall /\ res[p] = NoRes
  /\ LET e == db[c.key] IN
     /\ res' = [res EXCEPT ![p] = Answer(e, c)]
     /\ IF c.op # "get" /\ Changes(e, c)
        THEN /\ db' = [db EXCEPT ![c.key] = After(e, c, db'[c.key].ver)]
             /\ c.op # "del" => db'[c.key].ver \notin used[c.key]
             /\ used' = [used EXCEPT ![c.key] = used[c.key] \cup (IF c.op = "del" THEN {} ELSE {db'[c.key].ver})]
        ELSE UNCHANGED <<db, used>>
  /\ UNCHANGED call

\* the caller takes the answer, and may make its next call at once
Return(p) == /\ res[p] # NoRes
             /\ res' = [res EXCEPT ![p] = NoRes]
             /\ Others(p)
             /\ UNCHANGED <<db, used>>

Next == \E p \in Procs : Invoke(p) \/ Exec(p) \/ Return(p)

Spec == Init /\ [][Next]_<<db, call, res, used>>
=============================================================================
