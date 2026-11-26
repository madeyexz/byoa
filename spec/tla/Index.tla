------------------------------ MODULE Index ------------------------------
(***************************************************************************)
(* A store cannot list its keys, so byoa keeps an index of each user's    *)
(* entries (src/keys.ts), and deletes the entries it lists. This model    *)
(* checks one entry and its index while a job writes it and the app       *)
(* deletes it at the same time (signOut, deleteSandbox, deleteConversation*)
(* when the app deletes a user):                                          *)
(*                                                                         *)
(* Kind = "slot" (src/slots.ts): take() reads the slot; when there is      *)
(*   none, it adds [harness, key] to `usersandboxes/` (update), then       *)
(*   creates the slot with compare-and-set; remove() reads the index,      *)
(*   destroys each sandbox and deletes each slot, then takes them out of   *)
(*   the index (update).                                                   *)
(* Kind = "conversation" (src/conversation.ts): finish() puts the record  *)
(*   (store.put), then adds it to `conversations/` (update); remove()      *)
(*   reads the index, deletes each record, then takes them out of the      *)
(*   index (update).                                                       *)
(*                                                                         *)
(* The fix (in slots.ts and conversation.ts): the writer adds the entry to *)
(* index before and after it writes it (PreAdd, PostAdd), and remove(),   *)
(* after its index update, reads each entry again and puts one that a job *)
(* wrote meanwhile back in the index (Recheck). remove() keeps its order, *)
(* so a remove that fails part way (a provider error) can run again.      *)
(*                                                                         *)
(* Where the model differs from the code: one entry (one key of one user); *)
(* update() retries its compare-and-set until no writer came between, so  *)
(* the model runs each update as one step; a delete or a put has no       *)
(* version check, a compare-and-set has one.                               *)
(***************************************************************************)
EXTENDS Naturals

CONSTANTS
  Kind,        \* "slot" or "conversation"
  PreAdd,      \* the writer adds the entry to the index before it writes it (slots.ts)
  PostAdd,     \* and after (conversation.ts)
  Recheck,     \* remove(), after its index update, reads the entries again and lists each one that is back
  Crash,       \* a writer's backend may die
  Writers, Removes

VARIABLES
  entry,   \* the entry: 0 for none, else its version
  idx,     \* the index lists it
  nver,
  wpc,     \* each writer's step
  wread,   \* the version (0: none) its take read
  rpc,     \* the remover's step
  rlist,   \* the remover read the entry in the index
  removes

vars == <<entry, idx, nver, wpc, wread, rpc, rlist, removes>>

Init ==
  \* none yet, or one that an earlier job wrote and indexed
  /\ \/ entry = 0 /\ idx = FALSE
     \/ entry = 1 /\ idx = TRUE
  /\ nver = 2
  /\ wpc = [w \in Writers |-> "start"] /\ wread = [w \in Writers |-> 0]
  /\ rpc = "idle" /\ rlist = FALSE /\ removes = 0

\* slots.ts take, in its line: read the slot. conversation.ts finish: nothing to read.
WRead(w) ==
  /\ wpc[w] = "start"
  /\ wread' = [wread EXCEPT ![w] = entry]
  /\ wpc' = [wpc EXCEPT ![w] = IF PreAdd /\ (Kind = "conversation" \/ entry = 0) THEN "pre" ELSE "write"]
  /\ UNCHANGED <<entry, idx, nver, rpc, rlist, removes>>

\* add it to the index before the write (slots.ts: when there is no slot yet)
WPre(w) ==
  /\ wpc[w] = "pre"
  /\ idx' = TRUE
  /\ wpc' = [wpc EXCEPT ![w] = "write"]
  /\ UNCHANGED <<entry, nver, wread, rpc, rlist, removes>>

\* slots.ts: compare-and-set the slot (a lease that ran out, or none), else try again; conversation.ts: store.put
WWrite(w) ==
  /\ wpc[w] = "write"
  /\ IF Kind = "conversation" \/ entry = wread[w]
     THEN /\ entry' = nver /\ nver' = nver + 1
          /\ wpc' = [wpc EXCEPT ![w] = IF PostAdd /\ (Kind = "conversation" \/ wread[w] = 0) THEN "post" ELSE "done"]
     ELSE /\ wpc' = [wpc EXCEPT ![w] = "start"]
          /\ UNCHANGED <<entry, nver>>
  /\ UNCHANGED <<idx, wread, rpc, rlist, removes>>

\* add it to the index after the write (conversation.ts; slots.ts with the fix, when it created the slot)
WPost(w) ==
  /\ wpc[w] = "post"
  /\ idx' = TRUE
  /\ wpc' = [wpc EXCEPT ![w] = "done"]
  /\ UNCHANGED <<entry, nver, wread, rpc, rlist, removes>>

\* the writer's backend dies
WDie(w) ==
  /\ Crash /\ wpc[w] \notin {"done", "dead"}
  /\ wpc' = [wpc EXCEPT ![w] = "dead"]
  /\ UNCHANGED <<entry, idx, nver, wread, rpc, rlist, removes>>

\* remove: read the index
RRead ==
  /\ rpc = "idle" /\ removes < Removes
  /\ rlist' = idx
  /\ rpc' = "delete"
  /\ removes' = removes + 1
  /\ UNCHANGED <<entry, idx, nver, wpc, wread>>

\* remove: delete the entry it listed (for a slot: destroy its sandbox, then delete it)
RDelete ==
  /\ rpc = "delete"
  /\ entry' = IF rlist THEN 0 ELSE entry
  /\ rpc' = "filter"
  /\ UNCHANGED <<idx, nver, wpc, wread, rlist, removes>>

\* remove: take what it listed out of the index
RFilter ==
  /\ rpc = "filter"
  /\ idx' = IF rlist THEN FALSE ELSE idx
  /\ rpc' = IF Recheck THEN "check" ELSE "idle"
  /\ UNCHANGED <<entry, nver, wpc, wread, rlist, removes>>

\* the fix: an entry that a job wrote during the remove goes back in the index
RCheck ==
  /\ rpc = "check"
  /\ idx' = (idx \/ (rlist /\ entry # 0))
  /\ rpc' = "idle"
  /\ UNCHANGED <<entry, nver, wpc, wread, rlist, removes>>

\* the remover's backend dies
RDie ==
  /\ Crash /\ rpc \notin {"idle", "dead"}
  /\ rpc' = "dead"
  /\ UNCHANGED <<entry, idx, nver, wpc, wread, rlist, removes>>

Next ==
  \/ RRead \/ RDelete \/ RFilter \/ RCheck \/ RDie
  \/ \E w \in Writers : WRead(w) \/ WPre(w) \/ WWrite(w) \/ WPost(w) \/ WDie(w)

Spec == Init /\ [][Next]_vars

Quiet == rpc \in {"idle", "dead"} /\ \A w \in Writers : wpc[w] \in {"done", "dead"}

\* every entry in the store is in its index, so a later remove (deleteSandbox, deleteConversation) finds it: no
\* sandbox of the user, and no transcript, stays after the app deleted the user
NoOrphan == Quiet => (entry # 0 => idx)
=============================================================================
