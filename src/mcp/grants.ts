// MCP grants: one per user and MCP server, stored encrypted through the store adapter (R2.4), in the app's database.
// The app's backend is the only refresh owner of each grant (R2.3): a job never gets the refresh token, and two
// refreshes of one grant never run at once, in this process (one shared promise) or across processes (a lease taken
// with compare-and-set, R6.2). A second job that needs the token waits for the first refresh and uses its result.
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { open, randomToken, seal } from '../crypto.ts'
import type { Store } from '../store.ts'
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

const enc = encodeURIComponent
export const grantKey = (user: string, name: string) => `grant/${enc(user)}/${name}`
const leaseKey = (user: string, name: string) => `lease/${enc(user)}/${name}`
const indexKey = (user: string) => `grants/${enc(user)}`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

  async save(user: string, g: Grant) {
    const k = grantKey(user, g.name)
    await this.store.put(k, await seal(await this.key, JSON.stringify(g), k))
    await this.index(user, (l) => [...l.filter((x) => x.name !== g.name), { name: g.name, url: g.url }])
  }

  async remove(user: string, name: string) {
    await this.store.delete(grantKey(user, name))
    await this.store.delete(leaseKey(user, name))
    await this.index(user, (l) => l.filter((x) => x.name !== name))
  }

  async list(user: string): Promise<{ name: string; url: string }[]> {
    const e = await this.store.get(indexKey(user))
    return e ? JSON.parse(e.value) : []
  }

  /** The names and addresses (no tokens) of a user's grants, kept with compare-and-set so two changes keep both. */
  private async index(user: string, f: (l: { name: string; url: string }[]) => { name: string; url: string }[]) {
    for (;;) {
      const e = await this.store.get(indexKey(user))
      const next = JSON.stringify(f(e ? JSON.parse(e.value) : []).sort((a, b) => a.name.localeCompare(b.name)))
      if (await this.store.cas(indexKey(user), e?.version ?? null, next)) return
    }
  }

  /** The token to send to the MCP server now, refreshed if it runs out soon. `stale`: a token the server refused
   *  (401); a refresh then runs unless another one already replaced that token. */
  async accessToken(user: string, name: string, stale?: string): Promise<{ token: string; url: string; oauth: boolean }> {
    const r = await this.read(user, name)
    if (!r) throw new GrantError('not-connected', `${name} is not connected`)
    const g = r.grant
    if (g.bearer) return { token: g.bearer, url: g.url, oauth: false }
    if (g.needsSignIn || !g.oauth?.tokens) throw new GrantError('needs-sign-in', `${name}: the sign-in ran out; connect it again`)
    const access = g.oauth.tokens.access_token
    if (!fresh(g, stale)) {
      const k = grantKey(user, name)
      let p = this.inflight.get(k)
      if (!p) {
        p = this.refresh(user, name, stale ?? access).finally(() => this.inflight.delete(k))
        this.inflight.set(k, p)
      }
      return { token: await p, url: g.url, oauth: true }
    }
    return { token: access, url: g.url, oauth: true }
  }

  /** Takes the grant's lease, then refreshes, unless the grant no longer has `stale` (another refresh ran). */
  private async refresh(user: string, name: string, stale: string): Promise<string> {
    const lk = leaseKey(user, name)
    const id = randomToken(12)
    for (const end = Date.now() + 2 * LEASE_MS; Date.now() < end;) {
      const lease = await this.store.get(lk)
      const held = lease && JSON.parse(lease.value).until > Date.now()
      if (held) {
        await sleep(150)
        const r = await this.read(user, name)
        if (!r) throw new GrantError('not-connected', `${name} is not connected`)
        if (r.grant.needsSignIn) throw new GrantError('needs-sign-in', `${name}: the sign-in ran out; connect it again`)
        if (fresh(r.grant, stale)) return r.grant.oauth!.tokens!.access_token
        continue
      }
      if (!(await this.store.cas(lk, lease?.version ?? null, JSON.stringify({ id, until: Date.now() + LEASE_MS })))) continue
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
    if (result !== 'AUTHORIZED' || !p.s.tokens) {
      // the refresh token was refused: the user must connect again; never keep a sign-in page nobody opens
      p.s.verifier = undefined
      await this.store.cas(k, version, await seal(await this.key, JSON.stringify({ ...g, needsSignIn: true }), k))
      throw new GrantError('needs-sign-in', `${g.name}: the sign-in ran out; connect it again`)
    }
    const next: Grant = { ...g, oauth: p.s }
    if (!(await this.store.cas(k, version, await seal(await this.key, JSON.stringify(next), k)))) {
      // the user connected again while this refresh ran: theirs wins
      const r = await this.read(user, g.name)
      if (r?.grant.oauth?.tokens) return r.grant.oauth.tokens.access_token
      throw new GrantError('not-connected', `${g.name} is not connected`)
    }
    return p.s.tokens.access_token
  }
}

/** The access token works for a while yet, and is not the one the server refused. */
function fresh(g: Grant, stale?: string): boolean {
  const t = g.oauth?.tokens
  if (!t || g.needsSignIn) return false
  if (stale && t.access_token === stale) return false
  if (!t.expires_in || !g.oauth!.at) return true
  // a token that lives less than two minutes is refreshed in the second half of its life
  return g.oauth!.at + t.expires_in * 1000 - Date.now() > Math.min(EARLY_MS, t.expires_in * 500)
}
