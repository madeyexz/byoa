----------------------------- MODULE Grants -----------------------------
(***************************************************************************)
(* The refresh of one MCP grant of one user (R2.3, R2.4), by several      *)
(* backends that share one store, and the user who connects it again or  *)
(* removes it at the same time (src/mcp/grants.ts at d7c34b7):            *)
(*                                                                         *)
(*  - A request (a job's MCP call through the proxy, proxy.ts 92-104, or  *)
(*    fetchWithGrant, connect.ts 123-130) calls accessToken (75-93), and  *)
(*    sends the token; on a 401 it calls accessToken again with `stale`   *)
(*    and sends once more.                                                 *)
(*  - accessToken joins the refresh of its process (the `inflight` map,   *)
(*    85-90: one refresh per grant per process, whatever `stale` each     *)
(*    caller has), or starts one.                                          *)
(*  - refresh (96-124): the loop that gives up after 2 x LEASE_MS, the    *)
(*    lease read, the wait (sleep 150 ms, read the grant), the lease's     *)
(*    compare-and-set, the read of its version (`mine`), the read of the  *)
(*    grant under the lease, refreshNow, and the release (cas on `mine`). *)
(*  - refreshNow (126-145): auth() from the MCP SDK (client/auth.js 186-  *)
(*    390, SDK 1.32.2) posts the refresh token to the token endpoint; on  *)
(*    success the provider saves the new tokens and the grant is saved     *)
(*    with cas on its version; on failure the grant is marked needsSignIn *)
(*    with cas on its version, and the caller gets needs-sign-in.          *)
(*  - The authorization server rotates refresh tokens: a refresh revokes  *)
(*    the refresh token it used and gives a new one (OAuth 2.1 4.3.1),    *)
(*    as test/helpers/mcp-server.ts does.                                  *)
(*  - The user connects again (finishMcp/connectMcp/importMcp all call    *)
(*    Grants.save, 50-54: put, then the index) or removes the grant        *)
(*    (removeMcp -> Grants.remove, 56-60: delete grant, delete lease,     *)
(*    index), from the app's own process, which may die between calls.    *)
(*                                                                         *)
(* What auth() does on a refresh (client/auth.js): with a refresh token   *)
(* it calls refreshAuthorization (354). invalid_grant (the token was      *)
(* refused) is thrown out of authInternal; auth() then calls               *)
(* invalidateCredentials('tokens') and runs again with no tokens, which   *)
(* starts a new authorization flow and returns 'REDIRECT' (196-198,       *)
(* 378-389). A ServerError (any 5xx, or a body that is not an OAuth error *)
(* response, parseErrorResponse 126-141) or an error that is not an       *)
(* OAuthError (a network error, an abort) is swallowed at 366-369 and also *)
(* ends in 'REDIRECT'. Other OAuth errors (temporarily_unavailable,       *)
(* too_many_requests, ...) are thrown. refreshNow treats all three alike  *)
(* (131-135): needsSignIn. So in the model a call ends "ok", "refused"     *)
(* (the server refused this refresh token) or "err" (anything else).       *)
(*                                                                         *)
(* One step of time is 10 s; L is LEASE_MS (30 s: L = 3). A waiting        *)
(* refresh gives up when its clock passes its start + 2L (line 99). The   *)
(* call to the token endpoint takes up to MaxCall steps (the code has no  *)
(* time limit of its own; undici's default is 300 s). Each backend's clock *)
(* is the true one plus its skew (0 or Skew). An access token is fresh     *)
(* (fresh(), 149-156) until `due`, Life steps after its refresh by the     *)
(* refresher's clock.                                                      *)
(*                                                                         *)
(* The fixes (constants; all FALSE / 0 is the code at d7c34b7). The       *)
(* models are named for the code they check: main_ (and skew_) d7c34b7;  *)
(* norenew_ 4a8be4f, the code at 1a58e3c (FixSignIn, FixStale, FixIndex); *)
(* fixed_ with fix2.patch as well (Renew):                                 *)
(*  - FixSignIn (4a8be4f, rule changed in fix2): refreshNow marks          *)
(*    needsSignIn only when the token endpoint refused the refresh token  *)
(*    (fix2: a 4xx other than 408 and 429 and other than server_error,    *)
(*    temporarily_unavailable, too_many_requests; read from the answer by *)
(*    a fetchFn given to auth()); a 5xx, 408, 429 or no answer fails only  *)
(*    the request. When its cas fails it reads the grant again, and a     *)
(*    refresh that got new tokens while another backend marked the grant  *)
(*    with the refresh token it used puts its tokens over the mark        *)
(*    (Repair, cas on the version it read). The model's "refused" is the  *)
(*    server's refusal; that the code's rule maps a server's answers to it *)
(*    is checked by the test, not here.                                    *)
(*  - FixStale (4a8be4f, bounded in fix2): a request whose `stale` is the *)
(*    token that the refresh of its process gave joins a refresh once     *)
(*    more, and only once (rq.again).                                      *)
(*  - FixIndex (4a8be4f): save lists the grant before and after its put,  *)
(*    and remove, after its index update, reads the grant again and lists *)
(*    it if a save put it back meanwhile (as Index.tla's fix).             *)
(*  - Renew (fix2): from the lease's cas until the release, a timer every *)
(*    RENEW_MS (10 s, one step) reads the lease and, if it is still this  *)
(*    refresh's (its id), moves `until` on with cas; one renewal at a     *)
(*    time. The release clears the timer, waits for a renewal in flight   *)
(*    and releases by id. The read of the lease's version after the cas   *)
(*    (LMine) is gone.                                                     *)
(*  - TimeLimit > 0 (rejected): auth() gets one AbortSignal, TimeLimit     *)
(*    steps after it starts. An aborted request may still reach the       *)
(*    server later (Orphan): its new tokens are lost.                      *)
(*  - Family (the server, not byoa): a refresh token that comes again     *)
(*    after it was used revokes every token of its sign-in (RFC 9700      *)
(*    4.14.2); a sign-in again (ConnPut) starts a new family.             *)
(*                                                                         *)
(* Actions and the code they stand for (src/mcp/grants.ts at d7c34b7      *)
(* unless named):                                                          *)
(*   Arrive       proxy.ts 92 / connect.ts 123: accessToken is called      *)
(*   Read         75-90 (read, bearer/open/needsSignIn checks, fresh,      *)
(*                inflight get/set; no await in between but the read)      *)
(*   Send         proxy.ts 93-99, 104 (connect.ts 124-129): the request,   *)
(*                the 401 and its one retry with `stale`                   *)
(*   Deliver      90: `await p` for every caller of this process           *)
(*   LGet         99-101: the 2 x LEASE_MS loop, store.get(lease)          *)
(*   WRead        103-108: sleep 150, read, needsSignIn / fresh / again    *)
(*   LCas         110: store.cas(lease)                                    *)
(*   LMine        111: store.get(lease).version (not with Renew)           *)
(*   GRead        114-118: read under the lease, needsSignIn, fresh        *)
(*   SendAS, AS,  129: auth() -> refreshAuthorization (client/auth.js 351- *)
(*   Recv, Abort  370, 907-921); AS is the token endpoint                  *)
(*   Mark         131-135: cas(needsSignIn), throw needs-sign-in           *)
(*   Save         137-138: cas(new tokens)                                 *)
(*   Reread       139-142: read, its token or not-connected                *)
(*   Repair       FixSignIn only                                           *)
(*   Rel          119-120: finally, cas(lease, mine, until 0); then the    *)
(*                promise settles and inflight is deleted (87)             *)
(*   RenewLease   Renew only: the setInterval in refresh, setLease         *)
(*   Die          the backend's process dies: no step of it runs again     *)
(*   Early401     the MCP server refuses an access token before it runs out*)
(*   ConnStart..  save 50-54 (store.put 52, index 53, update() store.ts 25)*)
(*   ConnIdx2     from finishMcp connect.ts 86 (also connectMcp 57/61/65, *)
(*                importMcp 101)                                           *)
(*   RmGrant,     remove 56-60: delete grant 57, delete lease 58, index 59 *)
(*   RmLease,     (removeMcp, agents.ts 183)                               *)
(*   RmIdx, RmChk                                                          *)
(*   Tick         time; a live backend's steps and a due answer come first *)
(*                                                                         *)
(* Where the model differs from the code:                                  *)
(*  - One user and one grant (one name); one refresh token and one access *)
(*    token per refresh, so a token is a number `gen` (a new one at each   *)
(*    refresh and each sign-in).                                           *)
(*  - A live backend's step takes less than a step of time. A waiting      *)
(*    refresh reads the lease and the grant once per step (the code: every *)
(*    150 ms), at any point in the step. This allows a superset of the     *)
(*    code's orders for safety; with WF it still gets its turn.            *)
(*  - The read of the grant at line 75 and the decisions after it, up to   *)
(*    `await p` (inflight get and set), run with no await between, so they *)
(*    are one step. The sleep and the read in the wait (103-104) are one   *)
(*    step: nothing in between depends on the sleep but the time.         *)
(*  - update() (store.ts 25-32) retries its compare-and-set until no other *)
(*    writer came between, so each index update is one atomic step that    *)
(*    adds or takes out the grant.                                         *)
(*  - auth()'s discovery reads come from the grant's cached `discovery`    *)
(*    (no fetch), so the call is one request to the token endpoint: sent   *)
(*    (SendAS), handled by the server (AS), its answer received (Recv).    *)
(*  - The seal/open of the grant (crypto) and the JSON parse are local and *)
(*    are not steps. Provider.saveTokens stamps `at` with Date.now(): the  *)
(*    refresher's clock, as in the model.                                  *)
(*  - The MCP server takes an access token until the server revokes it    *)
(*    early (Early401, at most Early401s times); it does not run out at    *)
(*    the server in the model (byoa refreshes before then).                *)
(*  - A request ends: "ok" (the MCP server took its token), "notconn" and  *)
(*    "nsi" (GrantError, proxy 101: 403), "err" (another error, 502),      *)
(*    "refused" (401 twice: proxy 104, 403 "connect it again").            *)
(*  - A reconnect revokes nothing at the server (a new grant there).       *)
(*  - The store is linearizable and versions never repeat for a key.       *)
(*  - Requests and refreshes of a dead backend never run again; a request  *)
(*    of the dead backend is not answered (its caller is gone too). The   *)
(*    server may still handle a request that a dead backend sent.          *)
(*  - The access token's own end at the MCP server, the scope, discovery  *)
(*    and client registration, `bearer` grants and open servers are left *)
(*    out. One request per backend in most models (PerB).                 *)
(*  - Liveness (Answered, with FairSpec): WF on each live backend's steps *)
(*    and requests (an event loop that runs; the 150 ms poll), on time,  *)
(*    on the token endpoint's answer to a live backend (an assumption),  *)
(*    and on the user's calls. A dead backend has no fairness. No         *)
(*    SYMMETRY anywhere (TLC's liveness check is unsound with it).        *)
(*                                                                         *)
(* What TLC finds on the code at d7c34b7 (the models Grants_main_...):    *)
(*  1. A token endpoint call longer than the lease (30 s; refreshNow has  *)
(*     no time limit) lets a second backend take the lease, read the      *)
(*     same grant, and post the same refresh token (OneRefresh). With     *)
(*     rotation the second is refused, and Mark puts needsSignIn on the    *)
(*     grant before the first saves; the first's cas then fails, it       *)
(*     returns the old token, and its new tokens are lost: the user must  *)
(*     connect again (NoLostRefresh, NoFalseSignIn).                       *)
(*  2. A 5xx, no answer, or any token endpoint error that is not           *)
(*     invalid_grant makes auth() return 'REDIRECT', and refreshNow marks *)
(*     needsSignIn: the user must connect again though the refresh token  *)
(*     works (NoStuckSignIn).                                              *)
(*  3. A 401 for the new token while this process's refresh is still      *)
(*     settling joins that refresh (inflight ignores `stale`) and sends    *)
(*     the same token again: 403 "connect it again" (NoStaleRetry).        *)
(*  4. removeMcp during a save leaves a stored grant that the index does  *)
(*     not list (NoOrphan); listMcp and jobs do not see it.               *)
(*  5. Open, also with fix.patch: remove deletes the lease that a refresh  *)
(*     of the grant the user just connected again holds, so another       *)
(*     backend refreshes the same token (Grants_main_remove_lease).        *)
(*  6. Open, small: a save whose put ran before remove's delete lists the *)
(*     removed grant again (NoGhost); accessToken says not-connected.     *)
(* On 4a8be4f (the norenew_ models), 1 still makes two refresh requests, *)
(* and the second backend's mark puts needsSignIn on the grant while the  *)
(* first holds working tokens (NoFalseSignIn); that backend's request and *)
(* every request that reads the grant before the repair get 403 "connect *)
(* it again" (NoFalseSignInAnswer). With Family the second request revokes*)
(* the first's new tokens, the repair saves dead tokens, and the user must *)
(* connect again (NoLostRefresh). With fix2 (fixed_): one refresh request, *)
(* no false sign-in or answer, no lost refresh, also with Family, 5xx, a  *)
(* dead backend and a clock 10 s ahead; a clock 20 s ahead (more than     *)
(* LEASE_MS - RENEW_MS) still sees a renewed lease run out                *)
(* (fixed_skew_large). 5 and 6 stay open.                                  *)
(* Holds on every version: no refresh puts back a removed grant           *)
(* (NoResurrect: its cas on the deleted key fails); every request is       *)
(* answered while its backend lives, also when the lease holder died.     *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Backends,     \* processes of the app's backend that share the store
  PerB,         \* requests per backend
  L,            \* LEASE_MS, in steps
  MaxCall,      \* the longest call to the token endpoint, in steps
  Life,         \* an access token is fresh this long after its refresh
  InitDue,      \* the first access token is fresh until then
  ArriveBy,     \* requests start by this time
  MaxTime,
  Skew,         \* a backend's clock may be this far ahead
  MaxDeaths,    \* how many backends may die
  Transient,    \* the token endpoint may fail before it handles the request (a 5xx, a network error)
  Lost,         \* or after it handled it (the answer is lost)
  Early401s,    \* how many times the MCP server may refuse a token early
  Reconnects,   \* how many times the user connects again
  Removes,      \* how many times the user removes the grant
  UserCrash,    \* the app's process may die in save or remove
  Family,       \* the server revokes the whole token family when a used refresh token comes again (RFC 9700 4.14.2)
  FixSignIn, FixStale, FixIndex, Renew, TimeLimit,
  None

Reqs == Backends \X (1..PerB)
Home(r) == r[1]

VARIABLES
  clock, skew,
  grant,     \* the store's grant: None or [ver, gen, due, nsi]
  lease,     \* the store's lease: None or [ver, id, until] (until 0: released)
  idx,       \* the index `grants/` lists the grant
  nver,      \* the store's next version
  asValid,   \* the authorization server: the refresh tokens that work
  accValid,  \* the MCP server: the access tokens it takes
  ngen,      \* the next token
  fam,       \* the family (one sign-in) of each token: a function from tokens
  nfam,      \* the next family
  orph,      \* requests to the token endpoint that their sender aborted, which the server may still handle
  early,     \* early 401s so far
  rq,        \* each request: [pc, stale, tok, try, again, out, fa] (again: FixStale's one more join done;
             \* fa: it was told "connect it again" while the grant had a working refresh token)
  rf,        \* each backend's refresh of the grant (the inflight promise): [pc, stale, end, lver, mine, v, from, res, real]
  call,      \* each backend's call to the token endpoint: [st, from, new, t0]
  polled,    \* a waiting refresh read the lease in this step
  alive, deaths,
  conn,      \* the user's save: its step
  rm,        \* the user's remove: its step
  nconn, nrm,
  double,    \* a refresh request with a refresh token that another live backend's refresh is using
  falseNsi,  \* the grant was marked needsSignIn while a working refresh token for it existed
  staleRetry \* a request's retry after a 401 sent the same token again

timeV == <<clock, skew>>
storeV == <<grant, lease, idx, nver>>
asV == <<asValid, accValid, ngen, fam, nfam, orph, early>>
procV == <<rq, rf, call, polled, alive, deaths>>
userV == <<conn, rm, nconn, nrm>>
ghostV == <<double, falseNsi, staleRetry>>
vars == <<timeV, storeV, asV, procV, userV, ghostV>>

Now(b) == clock + skew[b]
NoRes == [k |-> "none", g |-> 0]
Tok(g) == [k |-> "tok", g |-> g]
Err(k) == [k |-> k, g |-> 0]
RfIdle == [pc |-> "none", stale |-> 0, end |-> 0, lver |-> 0, mine |-> 0, v |-> 0, from |-> 0, res |-> NoRes, real |-> FALSE]
\* the backends whose refresh still runs (a dead backend's never ends)
Busy == {b \in Backends : alive[b] /\ rf[b].pc # "none"}
NoCall == [st |-> "none", from |-> 0, new |-> 0, t0 |-> 0]

\* a live refresh holds new tokens that it got from refresh token x and has not saved yet (or saves them now)
Holds(c, x) ==
  /\ alive[c] /\ rf[c].pc \in {"await", "save", "reread", "repair"}
  /\ call[c].st = "ok" /\ call[c].from = x /\ call[c].new \in asValid

\* a refresh token of grant g works: the stored one, or the next one that a live refresh got from it
Works(g) == g.gen \in asValid \/ \E c \in Backends : Holds(c, g.gen)

\* a request told "connect it again" now is told wrongly
FalseAnswer == grant # None /\ Works(grant)

\* fresh(g, stale), grants.ts 149-156
Fresh(g, stale, b) == ~g.nsi /\ g.gen # stale /\ Now(b) < g.due

Init ==
  /\ clock = 0
  /\ skew \in [Backends -> {0, Skew}]
  /\ grant = [ver |-> 1, gen |-> 1, due |-> InitDue, nsi |-> FALSE]
  /\ lease = None
  /\ idx = TRUE
  /\ nver = 2
  /\ asValid = {1} /\ accValid = {1} /\ ngen = 2 /\ fam = (1 :> 1) /\ nfam = 2 /\ orph = {} /\ early = 0
  /\ rq = [r \in Reqs |-> [pc |-> "idle", stale |-> 0, tok |-> 0, try |-> 1, again |-> FALSE, out |-> "none", fa |-> FALSE]]
  /\ rf = [b \in Backends |-> RfIdle]
  /\ call = [b \in Backends |-> NoCall]
  /\ polled = [b \in Backends |-> FALSE]
  /\ alive = [b \in Backends |-> TRUE] /\ deaths = 0
  /\ conn = "idle" /\ rm = "idle" /\ nconn = 0 /\ nrm = 0
  /\ double = FALSE /\ falseNsi = FALSE /\ staleRetry = FALSE

-----------------------------------------------------------------------------
(* Requests *)

\* a job's MCP call reaches the proxy (proxy.ts 92), or the app calls fetchWithGrant (connect.ts 123)
Arrive(r) ==
  /\ alive[Home(r)] /\ rq[r].pc = "idle" /\ clock <= ArriveBy
  /\ rq' = [rq EXCEPT ![r].pc = "read"]
  /\ UNCHANGED <<timeV, storeV, asV, rf, call, polled, alive, deaths, userV, ghostV>>

\* accessToken, grants.ts 75-90: read the grant; its token, an error, or the refresh of this process
Read(r) ==
  LET b == Home(r) IN
  /\ alive[b] /\ rq[r].pc = "read"
  /\ IF grant = None THEN /\ rq' = [rq EXCEPT ![r].pc = "done", ![r].out = "notconn"] /\ UNCHANGED rf
     ELSE IF grant.nsi THEN /\ rq' = [rq EXCEPT ![r].pc = "done", ![r].out = "nsi", ![r].fa = FalseAnswer] /\ UNCHANGED rf
     ELSE IF Fresh(grant, rq[r].stale, b) THEN /\ rq' = [rq EXCEPT ![r].pc = "send", ![r].tok = grant.gen] /\ UNCHANGED rf
     ELSE /\ rq' = [rq EXCEPT ![r].pc = "join"]
          \* line 85-88: one refresh per process; it uses `stale ?? access`
          /\ rf' = IF rf[b].pc # "none" THEN rf
                   ELSE [rf EXCEPT ![b] = [RfIdle EXCEPT !.pc = "lget",
                           !.stale = IF rq[r].stale # 0 THEN rq[r].stale ELSE grant.gen,
                           !.end = Now(b) + 2 * L]]
  /\ UNCHANGED <<timeV, storeV, asV, call, polled, alive, deaths, userV, ghostV>>

\* proxy.ts 93-99, 104: send the token; on a 401, once accessToken(stale) and again; a second 401 is the end
Send(r) ==
  /\ alive[Home(r)] /\ rq[r].pc = "send"
  /\ IF rq[r].tok \in accValid
     THEN rq' = [rq EXCEPT ![r].pc = "done", ![r].out = "ok"] /\ UNCHANGED staleRetry
     ELSE IF rq[r].try = 1
     THEN rq' = [rq EXCEPT ![r].pc = "read", ![r].stale = rq[r].tok, ![r].try = 2] /\ UNCHANGED staleRetry
     ELSE /\ rq' = [rq EXCEPT ![r].pc = "done", ![r].out = "refused"]
          /\ staleRetry' = (staleRetry \/ rq[r].tok = rq[r].stale)
  /\ UNCHANGED <<timeV, storeV, asV, rf, call, polled, alive, deaths, userV, double, falseNsi>>

\* the refresh's promise settles: every request of this process that awaits it gets its result (line 90).
\* FixStale: a request whose `stale` is the token it got joins once more (it starts a new refresh), only once.
Deliver(b, res) ==
  rq' = [r \in Reqs |->
          IF Home(r) = b /\ rq[r].pc = "join"
          THEN IF res.k = "tok" /\ FixStale /\ rq[r].stale = res.g /\ ~rq[r].again THEN [rq[r] EXCEPT !.pc = "read", !.again = TRUE]
               ELSE IF res.k = "tok" THEN [rq[r] EXCEPT !.pc = "send", !.tok = res.g]
               ELSE [rq[r] EXCEPT !.pc = "done", !.out = res.k, !.fa = (res.k = "nsi" /\ FalseAnswer)]
          ELSE rq[r]]

Settle(b, res) == Deliver(b, res) /\ rf' = [rf EXCEPT ![b] = RfIdle]

-----------------------------------------------------------------------------
(* refresh(), grants.ts 96-124 *)

\* lines 99-101: give up after 2 x LEASE_MS; read the lease
LGet(b) ==
  /\ alive[b] /\ rf[b].pc = "lget" /\ ~polled[b]
  /\ IF Now(b) >= rf[b].end
     THEN Settle(b, Err("err"))                                       \* line 123
     ELSE /\ rf' = IF lease # None /\ lease.until > Now(b)
                   THEN [rf EXCEPT ![b].pc = "wread"]
                   ELSE [rf EXCEPT ![b].pc = "lcas", ![b].lver = IF lease = None THEN 0 ELSE lease.ver]
          /\ UNCHANGED rq
  /\ UNCHANGED <<timeV, storeV, asV, call, polled, alive, deaths, userV, ghostV>>

\* lines 103-108: held: sleep 150 ms, read the grant; another refresh's result, or wait on
WRead(b) ==
  /\ alive[b] /\ rf[b].pc = "wread"
  /\ IF grant = None THEN Settle(b, Err("notconn")) /\ UNCHANGED polled
     ELSE IF grant.nsi THEN Settle(b, Err("nsi")) /\ UNCHANGED polled
     ELSE IF Fresh(grant, rf[b].stale, b) THEN Settle(b, Tok(grant.gen)) /\ UNCHANGED polled
     ELSE /\ rf' = [rf EXCEPT ![b].pc = "lget"] /\ polled' = [polled EXCEPT ![b] = TRUE]
          /\ UNCHANGED rq
  /\ UNCHANGED <<timeV, storeV, asV, call, alive, deaths, userV, ghostV>>

\* line 110: take the lease with compare-and-set; else again at once
LCas(b) ==
  /\ alive[b] /\ rf[b].pc = "lcas"
  /\ IF (lease = None /\ rf[b].lver = 0) \/ (lease # None /\ lease.ver = rf[b].lver)
     THEN /\ lease' = [ver |-> nver, id |-> b, until |-> Now(b) + L] /\ nver' = nver + 1
          /\ rf' = [rf EXCEPT ![b].pc = IF Renew THEN "gread" ELSE "lmine"]   \* Renew: no second read
     ELSE /\ rf' = [rf EXCEPT ![b].pc = "lget"] /\ UNCHANGED <<lease, nver>>
  /\ UNCHANGED <<timeV, grant, idx, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* line 111: the lease's version, read again (none: a TypeError, out of refresh with no release)
LMine(b) ==
  /\ alive[b] /\ rf[b].pc = "lmine"
  /\ IF lease = None THEN Settle(b, Err("err"))
     ELSE rf' = [rf EXCEPT ![b].pc = "gread", ![b].mine = lease.ver] /\ UNCHANGED rq
  /\ UNCHANGED <<timeV, storeV, asV, call, polled, alive, deaths, userV, ghostV>>

\* lines 114-118: read the grant under the lease
GRead(b) ==
  /\ alive[b] /\ rf[b].pc = "gread"
  /\ rf' = IF grant = None THEN [rf EXCEPT ![b].pc = "rel", ![b].res = Err("notconn")]
           ELSE IF grant.nsi THEN [rf EXCEPT ![b].pc = "rel", ![b].res = Err("nsi")]
           ELSE IF Fresh(grant, rf[b].stale, b) THEN [rf EXCEPT ![b].pc = "rel", ![b].res = Tok(grant.gen)]
           ELSE [rf EXCEPT ![b].pc = "send", ![b].v = grant.ver, ![b].from = grant.gen]
  /\ UNCHANGED <<timeV, storeV, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* the refresh's call is outstanding: sent, or answered with new tokens it has not saved yet
Outstanding(c, x) ==
  /\ alive[c] /\ rf[c].pc \in {"await", "save"} /\ call[c].from = x /\ call[c].st \in {"sent", "ok"}

\* refreshNow, line 129: auth() posts the refresh token (client/auth.js 354, 907-921)
SendAS(b) ==
  /\ alive[b] /\ rf[b].pc = "send"
  /\ call' = [call EXCEPT ![b] = [st |-> "sent", from |-> rf[b].from, new |-> 0, t0 |-> clock]]
  /\ double' = (double \/ \E c \in Backends \ {b} : Outstanding(c, rf[b].from))
  /\ rf' = [rf EXCEPT ![b].pc = "await"]
  /\ UNCHANGED <<timeV, storeV, asV, rq, polled, alive, deaths, userV, falseNsi, staleRetry>>

\* the token endpoint handles the request (also one that a dead backend sent): it rotates the refresh token
Rotate(x) ==
  /\ asValid' = (asValid \ {x}) \cup {ngen}
  /\ accValid' = accValid \cup {ngen}
  /\ fam' = fam @@ (ngen :> fam[x])
  /\ ngen' = ngen + 1

\* a refresh token that is no longer valid comes: it is refused; with Family, every token of its sign-in is revoked
Reuse(x) ==
  /\ IF Family THEN /\ asValid' = {g \in asValid : fam[g] # fam[x]}
                    /\ accValid' = {g \in accValid : fam[g] # fam[x]}
     ELSE UNCHANGED <<asValid, accValid>>
  /\ UNCHANGED <<ngen, fam>>

AS(b) ==
  /\ call[b].st = "sent" /\ rf[b].pc = "await"
  /\ LET x == call[b].from IN
     \/ /\ x \in asValid /\ Rotate(x)
        /\ call' = [call EXCEPT ![b].st = "ok", ![b].new = ngen]
     \/ /\ x \notin asValid /\ Reuse(x)
        /\ call' = [call EXCEPT ![b].st = "refused"]
     \/ /\ Transient
        /\ call' = [call EXCEPT ![b].st = "err"] /\ UNCHANGED <<asValid, accValid, ngen, fam>>
     \/ /\ Lost /\ x \in asValid /\ Rotate(x)
        /\ call' = [call EXCEPT ![b].st = "err"]
  /\ UNCHANGED <<timeV, storeV, nfam, orph, early, rq, rf, polled, alive, deaths, userV, ghostV>>

\* TimeLimit: auth()'s signal aborts the call; the request may still reach the server (orph), and an answer
\* that is on its way is lost
Abort(b) ==
  /\ TimeLimit > 0 /\ alive[b] /\ rf[b].pc = "await" /\ clock - call[b].t0 >= TimeLimit
  /\ orph' = IF call[b].st = "sent" THEN orph \cup {call[b].from} ELSE orph
  /\ call' = [call EXCEPT ![b].st = "err"]
  /\ rf' = [rf EXCEPT ![b].pc = "mark", ![b].real = FALSE]
  /\ UNCHANGED <<timeV, storeV, asValid, accValid, ngen, fam, nfam, early, rq, polled, alive, deaths, userV, ghostV>>

Orphan ==
  \E x \in orph :
    /\ orph' = orph \ {x}
    /\ IF x \in asValid THEN Rotate(x) ELSE Reuse(x)
    /\ UNCHANGED <<timeV, storeV, nfam, early, procV, userV, ghostV>>

\* refreshNow, lines 129-131: auth() returns
Recv(b) ==
  /\ alive[b] /\ rf[b].pc = "await" /\ call[b].st \in {"ok", "refused", "err"}
  /\ rf' = IF call[b].st = "ok" THEN [rf EXCEPT ![b].pc = "save"]
           ELSE [rf EXCEPT ![b].pc = "mark", ![b].real = (call[b].st = "refused")]
  /\ UNCHANGED <<timeV, storeV, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* lines 131-135: mark needsSignIn with cas on the version read under the lease; throw needs-sign-in
\* (FixSignIn: only when the server refused the token; when the cas fails, read again as the save does)
Mark(b) ==
  /\ alive[b] /\ rf[b].pc = "mark"
  /\ IF FixSignIn /\ ~rf[b].real
     THEN rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Err("err")] /\ UNCHANGED <<grant, nver, falseNsi>>
     ELSE IF grant # None /\ grant.ver = rf[b].v
     THEN /\ grant' = [grant EXCEPT !.ver = nver, !.nsi = TRUE] /\ nver' = nver + 1
          /\ falseNsi' = (falseNsi \/ Works(grant))
          /\ rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Err("nsi")]
     ELSE /\ IF FixSignIn THEN rf' = [rf EXCEPT ![b].pc = "reread"]
             ELSE rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Err("nsi")]
          /\ UNCHANGED <<grant, nver, falseNsi>>
  /\ UNCHANGED <<timeV, lease, idx, asV, rq, call, polled, alive, deaths, userV, double, staleRetry>>

\* line 138: save the new tokens with cas on the version read under the lease
Save(b) ==
  /\ alive[b] /\ rf[b].pc = "save"
  /\ IF grant # None /\ grant.ver = rf[b].v
     THEN /\ grant' = [ver |-> nver, gen |-> call[b].new, due |-> Now(b) + Life, nsi |-> FALSE]
          /\ nver' = nver + 1
          /\ rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Tok(call[b].new)]
     ELSE /\ rf' = [rf EXCEPT ![b].pc = "reread"] /\ UNCHANGED <<grant, nver>>
  /\ UNCHANGED <<timeV, lease, idx, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* lines 140-142: the grant changed meanwhile: its token (also a needsSignIn grant's old one), or not connected.
\* FixSignIn: a needsSignIn grant is an error; but when this refresh got new tokens and the grant was marked with
\* the refresh token that this refresh used (another backend's refresh was refused because of it), repair it.
Reread(b) ==
  /\ alive[b] /\ rf[b].pc = "reread"
  /\ rf' = IF FixSignIn /\ grant # None /\ grant.nsi /\ call[b].st = "ok" /\ grant.gen = rf[b].from
           THEN [rf EXCEPT ![b].pc = "repair", ![b].v = grant.ver]
           ELSE [rf EXCEPT ![b].pc = "rel",
                   ![b].res = IF grant = None THEN Err("notconn")
                              ELSE IF FixSignIn /\ grant.nsi THEN Err("nsi")
                              ELSE Tok(grant.gen)]
  /\ UNCHANGED <<timeV, storeV, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* FixSignIn: the repair, cas on the version that Reread read; when it fails, the grant that Reread read (needsSignIn)
Repair(b) ==
  /\ alive[b] /\ rf[b].pc = "repair"
  /\ IF grant # None /\ grant.ver = rf[b].v
     THEN /\ grant' = [ver |-> nver, gen |-> call[b].new, due |-> Now(b) + Life, nsi |-> FALSE]
          /\ nver' = nver + 1
          /\ rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Tok(call[b].new)]
     ELSE /\ rf' = [rf EXCEPT ![b].pc = "rel", ![b].res = Err("nsi")] /\ UNCHANGED <<grant, nver>>
  /\ UNCHANGED <<timeV, lease, idx, asV, rq, call, polled, alive, deaths, userV, ghostV>>

\* Renew (fix2.patch, grants.ts setInterval in refresh, and setLease): every RENEW_MS (10 s, one step) while
\* auth() runs, the holder reads the lease and, if it is still its own (its id), moves `until` on with cas on the
\* version it read; one renewal at a time. The get and the cas are one step: between them only a writer that does
\* not hold the lease could come (a backend whose clock is ahead, or remove), and then the cas fails, as here the
\* lease is not its own.
RenewLease(b) ==
  /\ Renew /\ alive[b] /\ rf[b].pc = "await"
  /\ lease # None /\ lease.id = b /\ lease.until - Now(b) <= L - 1
  /\ lease' = [ver |-> nver, id |-> b, until |-> Now(b) + L] /\ nver' = nver + 1
  /\ UNCHANGED <<timeV, grant, idx, asV, rq, rf, call, polled, alive, deaths, userV, ghostV>>

\* line 120 (finally): release the lease with cas on `mine`; then the promise settles.
\* Renew: the timer is cleared and the release waits for a renewal in flight, then releases by id (get, cas).
Rel(b) ==
  /\ alive[b] /\ rf[b].pc = "rel"
  /\ IF lease # None /\ IF Renew THEN lease.id = b ELSE lease.ver = rf[b].mine
     THEN lease' = [ver |-> nver, id |-> b, until |-> 0] /\ nver' = nver + 1
     ELSE UNCHANGED <<lease, nver>>
  /\ Settle(b, rf[b].res)
  /\ UNCHANGED <<timeV, grant, idx, asV, call, polled, alive, deaths, userV, ghostV>>

Die(b) ==
  /\ alive[b] /\ deaths < MaxDeaths
  /\ alive' = [alive EXCEPT ![b] = FALSE] /\ deaths' = deaths + 1
  /\ UNCHANGED <<timeV, storeV, asV, rq, rf, call, polled, userV, ghostV>>

-----------------------------------------------------------------------------
(* The MCP server, and the user *)

\* the MCP server refuses the current access token before it runs out (a 401)
Early401 ==
  /\ early < Early401s /\ grant # None /\ grant.gen \in accValid
  /\ accValid' = accValid \ {grant.gen} /\ early' = early + 1
  /\ UNCHANGED <<timeV, storeV, asValid, ngen, fam, nfam, orph, procV, userV, ghostV>>

\* save, grants.ts 50-54 (finishMcp, connect.ts 86): put, then add to the index.
\* FixIndex: add to the index first too.
ConnStart ==
  /\ conn \in {"idle", "done"} /\ nconn < Reconnects
  /\ conn' = (IF FixIndex THEN "idx1" ELSE "put")
  /\ nconn' = nconn + 1
  /\ UNCHANGED <<timeV, storeV, asV, procV, rm, nrm, ghostV>>

ConnIdx1 ==
  /\ conn = "idx1" /\ idx' = TRUE /\ conn' = "put"
  /\ UNCHANGED <<timeV, grant, lease, nver, asV, procV, rm, nconn, nrm, ghostV>>

\* the new sign-in's tokens (the server gave them in finishMcp's auth())
ConnPut ==
  /\ conn = "put"
  /\ grant' = [ver |-> nver, gen |-> ngen, due |-> clock + Life, nsi |-> FALSE] /\ nver' = nver + 1
  /\ asValid' = asValid \cup {ngen} /\ accValid' = accValid \cup {ngen} /\ ngen' = ngen + 1
  /\ fam' = fam @@ (ngen :> nfam) /\ nfam' = nfam + 1   \* a new sign-in: a new family
  /\ conn' = "idx2"
  /\ UNCHANGED <<timeV, lease, idx, orph, early, procV, rm, nconn, nrm, ghostV>>

ConnIdx2 ==
  /\ conn = "idx2" /\ idx' = TRUE /\ conn' = "done"
  /\ UNCHANGED <<timeV, grant, lease, nver, asV, procV, rm, nconn, nrm, ghostV>>

\* remove, grants.ts 56-60: delete the grant, delete the lease, take it out of the index.
\* FixIndex: then read the grant again, and list it if a save put it back.
RmStart ==
  /\ rm \in {"idle", "done"} /\ nrm < Removes
  /\ rm' = "delg" /\ nrm' = nrm + 1
  /\ UNCHANGED <<timeV, storeV, asV, procV, conn, nconn, ghostV>>

RmGrant ==
  /\ rm = "delg" /\ grant' = None /\ rm' = "dell"
  /\ UNCHANGED <<timeV, lease, idx, nver, asV, procV, conn, nconn, nrm, ghostV>>

RmLease ==
  /\ rm = "dell" /\ lease' = None /\ rm' = "idx"
  /\ UNCHANGED <<timeV, grant, idx, nver, asV, procV, conn, nconn, nrm, ghostV>>

RmIdx ==
  /\ rm = "idx" /\ idx' = FALSE /\ rm' = IF FixIndex THEN "chk" ELSE "done"
  /\ UNCHANGED <<timeV, grant, lease, nver, asV, procV, conn, nconn, nrm, ghostV>>

RmChk ==
  /\ rm = "chk" /\ rm' = "done"
  /\ IF grant # None THEN idx' = TRUE ELSE UNCHANGED idx
  /\ UNCHANGED <<timeV, grant, lease, nver, asV, procV, conn, nconn, nrm, ghostV>>

UserDie ==
  /\ UserCrash
  /\ \/ conn \notin {"idle", "done", "dead"} /\ conn' = "dead" /\ UNCHANGED rm
     \/ rm \notin {"idle", "done", "dead"} /\ rm' = "dead" /\ UNCHANGED conn
  /\ UNCHANGED <<timeV, storeV, asV, procV, nconn, nrm, ghostV>>

-----------------------------------------------------------------------------
(* Time *)

\* a live backend acts within the step; a call answers within MaxCall steps; the user's calls run at once
Urgent ==
  \/ \E r \in Reqs : alive[Home(r)] /\ rq[r].pc \in {"read", "send"}
  \/ \E b \in Backends : alive[b] /\
       \/ rf[b].pc \in {"wread", "lcas", "lmine", "gread", "send", "mark", "save", "reread", "repair", "rel"}
       \/ Renew /\ rf[b].pc = "await" /\ lease # None /\ lease.id = b /\ lease.until - Now(b) <= L - 1
       \/ rf[b].pc = "lget" /\ ~polled[b]
       \/ rf[b].pc = "await" /\ clock - call[b].t0 >= MaxCall
       \/ rf[b].pc = "await" /\ TimeLimit > 0 /\ clock - call[b].t0 >= TimeLimit
  \/ conn \in {"idx1", "put", "idx2"}
  \/ rm \in {"delg", "dell", "idx", "chk"}

Tick ==
  /\ clock < MaxTime /\ ~Urgent
  /\ clock' = clock + 1
  /\ polled' = [b \in Backends |-> FALSE]
  /\ UNCHANGED <<skew, storeV, asV, rq, rf, call, alive, deaths, userV, ghostV>>

BackendStep(b) ==
  LGet(b) \/ WRead(b) \/ LCas(b) \/ LMine(b) \/ GRead(b) \/ SendAS(b) \/ Recv(b) \/ Abort(b)
  \/ Mark(b) \/ Save(b) \/ Reread(b) \/ Repair(b) \/ Rel(b) \/ RenewLease(b)

ReqStep(r) == Read(r) \/ Send(r)

UserStep == ConnIdx1 \/ ConnPut \/ ConnIdx2 \/ RmGrant \/ RmLease \/ RmIdx \/ RmChk

Next ==
  \/ Tick \/ Early401 \/ Orphan \/ ConnStart \/ RmStart \/ UserStep \/ UserDie
  \/ \E r \in Reqs : Arrive(r) \/ ReqStep(r)
  \/ \E b \in Backends : BackendStep(b) \/ AS(b) \/ Die(b)

\* Fairness: a live backend's steps run (its event loop, the 150 ms poll, line 103); time passes; the token
\* endpoint answers a live backend's call (an assumption about the server); the user's calls run on. Nothing is
\* fair for a dead backend: BackendStep and ReqStep need alive[b], and a dead backend's AS step only matters
\* to others.
Fairness ==
  /\ WF_vars(Tick)
  /\ \A b \in Backends : WF_vars(BackendStep(b)) /\ WF_vars(alive[b] /\ AS(b))
  /\ \A r \in Reqs : WF_vars(ReqStep(r))
  /\ WF_vars(UserStep)

Spec == Init /\ [][Next]_vars
FairSpec == Spec /\ Fairness

-----------------------------------------------------------------------------
(* Properties *)

\* R2.3: never two refresh requests with one refresh token while the first one's refresh is still going on
\* in a live backend (sent, or answered and not saved yet). With rotation, one of them is refused.
OneRefresh == ~double

\* the grant is marked needsSignIn only when no refresh token of it works: neither the stored one, nor the new one
\* that a live refresh got from the stored one and has not saved yet
NoFalseSignIn == ~falseNsi

\* once no refresh runs in a live backend, a grant marked needsSignIn has no refresh token that works: the user
\* is never left to connect again because of a race of two refreshes
NoStuckSignIn == (Busy = {} /\ grant # None /\ grant.nsi) => grant.gen \notin asValid

\* once no refresh runs and no backend died, the stored grant's refresh token works: no refresh lost the server's
\* new tokens (only with Lost = FALSE: a lost answer loses them, whatever byoa does; the model has no user who
\* revokes the grant at the server)
NoLostRefresh == (Busy = {} /\ deaths = 0 /\ grant # None) => grant.gen \in asValid

\* a request is never told "connect it again" (needs-sign-in) while the stored grant works
NoFalseSignInAnswer == \A r \in Reqs : ~rq[r].fa

\* a retry after a 401 never sends the same token again (that 401 ends as "connect it again", proxy.ts 104)
NoStaleRetry == ~staleRetry

\* after the user's saves and removes ended (or their process died), the index lists the grant if and only if it is
\* stored: listMcp and the servers a job may get (agents.ts 104) show it, and an app that deletes a user with
\* listMcp and removeMcp finds it
UserQuiet == conn \in {"idle", "done", "dead"} /\ rm \in {"idle", "done", "dead"}
NoOrphan == UserQuiet => (grant # None => idx)
NoGhost == UserQuiet => (idx => grant # None)

\* a removed grant stays removed until the user connects again: no refresh puts it back
\* (cas on a deleted key fails: versions never repeat)
NoResurrect == (rm = "done" /\ conn \in {"idle", "done"} /\ nconn = 0) => grant = None

\* liveness: a request that started is answered while its backend lives
Answered == \A r \in Reqs : (rq[r].pc \in {"read", "join", "send"}) ~> (rq[r].pc = "done" \/ ~alive[Home(r)])

TypeOK ==
  /\ rq \in [Reqs -> [pc : {"idle", "read", "join", "send", "done"}, stale : Nat, tok : Nat, try : {1, 2},
                      again : BOOLEAN, out : {"none", "ok", "notconn", "nsi", "err", "refused"}, fa : BOOLEAN]]
  /\ grant = None \/ grant.ver < nver
=============================================================================
