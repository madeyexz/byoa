// MCP grants: one per user and MCP server, stored encrypted through the store adapter (R2.4), in the app's database.
// The app's backend is the only refresh owner of each grant (R2.3): a job never gets the refresh token, and two
// refreshes of one grant never run at once, in this process (one shared promise) or across processes (a lease taken
// with compare-and-set, R6.2). A second job that needs the token waits for the first refresh and uses its result.
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { open, randomToken, seal } from '../crypto.ts'
import { keys } from '../keys.ts'
import { update, type Store } from '../store.ts'
import { now, sleep } from '../time.ts'
import { Provider, type OAuthConfig, type OAuthState } from './oauth.ts'

export interface Grant {
  name: string
  url: string
  /** A token the user pasted (R2.2), sent as `Authorization: Bearer`. */
  bearer?: string
  /** A sign-in with MCP authorization (R2.1). */
  oauth?: OAuthState
  /** The refresh token no longer works: the user must connect again. */
  needsSignIn?: boolean
}

/** A refresh starts this long before the access token runs out. */
const EARLY_MS = 60_000
/** A lease older than this is a crashed refresh; another process may take it. */
const LEASE_MS = 30_000

export const grantKey = keys.grant
const leaseKey = keys.grantLease
const indexKey = keys.grants

export class GrantError extends Error {
  readonly code: 'not-connected' | 'needs-sign-in'
  constructor(code: GrantError['code'], message: string) { super(message); this.code = code }
}

export class Grants {
  private inflight = new Map<string, Promise<string>>()
  private readonly store: Store
  private readonly key: Promise<CryptoKey>
  private readonly oauth: OAuthConfig
  constructor(store: Store, key: Promise<CryptoKey>, oauth: OAuthConfig) { this.store = store; this.key = key; this.oauth = oauth }

  async read(user: string, name: string): Promise<{ grant: Grant; version: string } | null> {
    const k = grantKey(user, name)
    const e = await this.store.get(k)
    return e ? { grant: JSON.parse(await open(await this.key, e.value, k)), version: e.version } : null
  }

  /** Lists the grant in the index before and after its put, so that a remove that runs meanwhile (or a backend that
   *  dies) never leaves a grant that the index does not list. */
  async save(user: string, g: Grant) {
    const k = grantKey(user, g.name)
    await this.list1(user, g)
    await this.store.put(k, await seal(await this.key, JSON.stringify(g), k))
    await this.list1(user, g)
  }

  async remove(user: string, name: string) {
    await this.store.delete(grantKey(user, name))
    await this.store.delete(leaseKey(user, name))
    await this.index(user, (l) => l.filter((x) => x.name !== name))
    // a save that ran meanwhile put the grant back: list it again
    const r = await this.read(user, name)
    if (r) await this.list1(user, r.grant)
  }

  private list1(user: string, g: Grant) {
    return this.index(user, (l) => [...l.filter((x) => x.name !== g.name), { name: g.name, url: g.url }])
  }

  async list(user: string): Promise<{ name: string; url: string }[]> {
    const e = await this.store.get(indexKey(user))
    return e ? JSON.parse(e.value) : []
  }

  /** The names and addresses (no tokens) of a user's grants, kept with compare-and-set so two changes keep both. */
  private async index(user: string, f: (l: { name: string; url: string }[]) => { name: string; url: string }[]) {
    await update(this.store, indexKey(user), (v) => JSON.stringify(f(v ? JSON.parse(v) : []).sort((a, b) => a.name.localeCompare(b.name))))
  }

  /** The token to send to the MCP server now, refreshed if it runs out soon; `''` for a server with no sign-in.
   *  `stale`: a token the server refused (401); a refresh then runs unless another one already replaced that token. */
  async accessToken(user: string, name: string, stale?: string): Promise<{ token: string; url: string; oauth: boolean }> {
    const r = await this.read(user, name)
    if (!r) throw new GrantError('not-connected', `${name} is not connected`)
    const g = r.grant
    if (g.bearer) return { token: g.bearer, url: g.url, oauth: false }
    // a server with no sign-in (connectMcp found it open): there is no token to add
    if (!g.oauth && !g.needsSignIn) return { token: '', url: g.url, oauth: false }
    if (g.needsSignIn || !g.oauth?.tokens) throw new GrantError('needs-sign-in', `${name}: the sign-in ran out; connect it again`)
    const access = g.oauth.tokens.access_token
    if (!fresh(g, stale)) {
      const k = grantKey(user, name)
      let p = this.inflight.get(k)
      if (!p) {
        p = this.refresh(user, name, stale ?? access).finally(() => this.inflight.delete(k))
        this.inflight.set(k, p)
      }
      const token = await p
      // this process's refresh started before the server refused `stale`, and gave that token: refresh again
      if (stale && token === stale) return this.accessToken(user, name, stale)
      return { token, url: g.url, oauth: true }
    }
    return { token: access, url: g.url, oauth: true }
  }

  /** Takes the grant's lease, then refreshes, unless the grant no longer has `stale` (another refresh ran). */
  private async refresh(user: string, name: string, stale: string): Promise<string> {
    const lk = leaseKey(user, name)
    const id = randomToken(12)
    for (const end = now() + 2 * LEASE_MS; now() < end;) {
      const lease = await this.store.get(lk)
      const held = lease && JSON.parse(lease.value).until > now()
      if (held) {
        await sleep(150)
        const r = await this.read(user, name)
        if (!r) throw new GrantError('not-connected', `${name} is not connected`)
        if (r.grant.needsSignIn) throw new GrantError('needs-sign-in', `${name}: the sign-in ran out; connect it again`)
        if (fresh(r.grant, stale)) return r.grant.oauth!.tokens!.access_token
        continue
      }
      if (!(await this.store.cas(lk, lease?.version ?? null, JSON.stringify({ id, until: now() + LEASE_MS })))) continue
      const mine = (await this.store.get(lk))!.version
      try {
        // read again under the lease: a refresh that ended just before has a new token already
        const r = await this.read(user, name)
        if (!r) throw new GrantError('not-connected', `${name} is not connected`)
        if (r.grant.needsSignIn) throw new GrantError('needs-sign-in', `${name}: the sign-in ran out; connect it again`)
        if (fresh(r.grant, stale)) return r.grant.oauth!.tokens!.access_token
        return await this.refreshNow(user, r.grant, r.version)
      } finally {
        await this.store.cas(lk, mine, JSON.stringify({ id, until: 0 }))
      }
    }
    throw new Error(`byoa: ${name}: another refresh of this grant did not finish`)
  }

  private async refreshNow(user: string, g: Grant, version: string): Promise<string> {
    const p = new Provider(this.oauth, structuredClone(g.oauth!))
    let result: Awaited<ReturnType<typeof auth>> | undefined
    try { result = await auth(p, { serverUrl: g.url }) } catch { result = undefined }
    const k = grantKey(user, g.name)
    const ok = result === 'AUTHORIZED' && !!p.s.tokens
    // auth() ends in 'REDIRECT' also after a 5xx or no answer from the token endpoint: only a refused refresh token
    // means the user must connect again; any other failure fails this request, and the grant stays as it is
    if (!ok && !p.refused) throw new Error(`byoa: ${g.name}: the authorization server did not refresh the sign-in`)
    const next: Grant = ok ? { ...g, oauth: p.s } : { ...g, needsSignIn: true }
    if (await this.store.cas(k, version, await seal(await this.key, JSON.stringify(next), k))) {
      if (!ok) throw new GrantError('needs-sign-in', `${g.name}: the sign-in ran out; connect it again`)
      return p.s.tokens!.access_token
    }
    // the grant changed while this refresh ran (the user connected again, or another refresh saved): it wins
    const r = await this.read(user, g.name)
    if (!r) throw new GrantError('not-connected', `${g.name} is not connected`)
    // unless another backend's refresh, which took the lease after ours ran out, was refused only because this one had
    // used the refresh token, and marked the grant: then this refresh's tokens are the grant's
    if (ok && r.grant.needsSignIn && r.grant.oauth?.tokens?.refresh_token === g.oauth?.tokens?.refresh_token
      && await this.store.cas(k, r.version, await seal(await this.key, JSON.stringify(next), k))) return p.s.tokens!.access_token
    if (r.grant.needsSignIn || !r.grant.oauth?.tokens) throw new GrantError('needs-sign-in', `${g.name}: the sign-in ran out; connect it again`)
    return r.grant.oauth.tokens.access_token
  }
}

/** The access token works for a while yet, and is not the one the server refused. */
function fresh(g: Grant, stale?: string): boolean {
  const t = g.oauth?.tokens
  if (!t || g.needsSignIn) return false
  if (stale && t.access_token === stale) return false
  if (!t.expires_in || !g.oauth!.at) return true
  // a token that lives less than two minutes is refreshed in the second half of its life
  return g.oauth!.at + t.expires_in * 1000 - now() > Math.min(EARLY_MS, t.expires_in * 500)
}
