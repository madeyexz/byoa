// The default AI login (R1.4): the app's database holds it, encrypted, through the store adapter (R6).
// The sign-in is cliLogin's: the lab's own, unmodified CLI, on the lab's own page (R1.1, R1.2). When it ends, byoa
// reads the CLI's own login files from that sandbox and keeps them encrypted in the store, one entry per user and
// harness in the app's own store. A job's sandbox has no login volume: byoa writes the files in, and after the job it
// saves them back when the CLI changed them (it refreshes its own tokens) and removes them from the sandbox, also from
// the user's sandbox that byoa keeps between jobs (R5.4). So the store is the only copy between jobs. byoa never uses
// the tokens inside the files or calls the lab's token endpoints itself, so the CLI stays the only client that uses them.
// Both CLIs rotate their refresh tokens, so two sandboxes must not refresh one login. By default, only one sandbox
// holds a user's login at a time: a job takes a lease with compare-and-set and waits for another job of the same user
// and harness to give it back.
// With `parallel: true`, Codex jobs of one user share the login, each with a copy in its own sandbox, while Codex will
// not refresh it by itself before the job's time runs out: Codex 0.171.0 refreshes 5 minutes before its access token
// ends (login/src/auth/manager.rs, proactive_refresh_reason), and that token lasts 10 days. When the login is due, one
// job holds it alone: it waits for the others to end, the CLI refreshes, byoa saves the new login, and the jobs after
// it share again. For this byoa reads the time the access token ends, and nothing else in it. What stays: Codex also
// refreshes when OpenAI answers 401 to a token that has not run out; two sandboxes that get that answer at the same
// time both refresh, and one refresh fails. So sharing is the app's choice. Claude Code jobs never share: when it
// refreshes is not checked yet.
// The labs' published terms restrict where these tokens may be stored (SPEC.md, Lab rules); each app checks them.
// cliLogin (login.ts) keeps the login in a volume of the user instead.
import { importKey, open, randomToken, seal } from './crypto.ts'
import type { HarnessName } from './harness/pins.ts'
import { ensureHarness } from './harness/install.ts'
import { cliLogin, loginEnv, type LoginDeps, type LoginDriver } from './login.ts'
import type { Sandbox } from './sandbox/types.ts'
import { q } from './sh.ts'
import type { Store } from './store.ts'

export interface StoredLoginOptions {
  /** 32 random bytes as base64. Default: the app's encryptionKey (each login is sealed under its own entry's name). */
  encryptionKey?: string
  /** Default: the app's store. A table of its own lets you give it its own access rules and backups (README: "AI login"). */
  store?: Store
  /** How long a job waits for the login, when another job of the same user and harness must hold it alone. Default
   *  10 minutes. */
  waitMs?: number
  /** Default false: one job of a user and harness holds the login at a time, and another waits for it. True: Codex
   *  jobs of one user share the login while it is not due for a refresh, so they run at the same time (in different
   *  sandboxes: a `sandboxKey` for each, or `sandboxPer: 'job'`). Claude Code jobs still run one at a time. */
  parallel?: boolean
}

/** The CLI's own login files, relative to the home folder. */
export const LOGIN_FILES: Record<HarnessName, string[]> = { claude: ['.claude/.credentials.json', '.claude/.claude.json'], codex: ['.codex/auth.json'] }

/** Copies of the login files that the CLI makes by itself, as shell globs relative to the home folder: byoa removes them
 *  with the login files and does not store them. Claude Code 2.1.330 writes a backup of `.claude.json` (the account:
 *  email, organization, plan; no token) at each start. */
const LOGIN_COPIES: Partial<Record<HarnessName, string[]>> = { claude: ['.claude/backups/.claude.json.backup.*'] }

const enc = encodeURIComponent
const loginKey = (user: string, h: HarnessName) => `ailogin/${enc(user)}/${h}`
const leaseKey = (user: string, h: HarnessName) => `ailoginlease/${enc(user)}/${h}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

/** Codex refreshes its login this long before its access token ends. */
const REFRESH_WINDOW_MS = 5 * 60_000

/** When the CLI will refresh this login by itself, in ms since 1970, from the times in its own login files; 0 when
 *  byoa does not know (then one job holds the login at a time). byoa reads the time only, and uses no token. */
export function refreshDue(h: HarnessName, files: Record<string, string>): number {
  // Claude Code: when it refreshes is not checked yet
  if (h !== 'codex') return 0
  try {
    const doc = JSON.parse(files[LOGIN_FILES[h][0]!] ?? '')
    // the `exp` of the access token (a JWT); a token with no `exp` is refreshed 8 days after the last refresh
    const payload = String(doc?.tokens?.access_token ?? '').split('.')[1]
    let exp = 0
    try { exp = Number(JSON.parse(fromB64((payload ?? '').replace(/-/g, '+').replace(/_/g, '/'))).exp) * 1000 } catch {}
    if (exp > 0) return exp - REFRESH_WINDOW_MS
    const last = Date.parse(doc?.last_refresh ?? '')
    return last > 0 ? last + 8 * 24 * 3600_000 : 0
  } catch { return 0 }
}

/** Who holds a user's login: one job alone, or the jobs that share it, each until its time. `want`: a job waits to
 *  hold it alone, so no new job shares it until then. */
interface Lease { alone?: { id: string; until: number }; shared?: Record<string, number>; want?: number }
function readLease(value: string | undefined): Lease {
  if (!value) return {}
  const v = JSON.parse(value), now = Date.now()
  // the lease of an earlier version of byoa: { id, until }
  if (typeof v.id === 'string') return v.until > now ? { alone: { id: v.id, until: v.until } } : {}
  return {
    ...(v.alone?.until > now ? { alone: v.alone } : {}),
    shared: Object.fromEntries(Object.entries<number>(v.shared ?? {}).filter(([, until]) => until > now)),
    ...(v.want > now ? { want: v.want } : {}),
  }
}

export function storedLogin(o: StoredLoginOptions = {}): (d: LoginDeps) => LoginDriver {
  return (d) => {
    const store = o.store ?? d.store
    const key = importKey(o.encryptionKey ?? d.encryptionKey)
    key.catch(() => {})
    const leaseMs = (d.jobTimeoutMs ?? 30 * 60_000) + 5 * 60_000
    const waitMs = o.waitMs ?? 10 * 60_000
    const parallel = o.parallel ?? false
    /** What each job's sandbox got: by sandbox id. */
    const held = new Map<string, { version: string; lease: string; text: string }>()
    const readFiles = async (sbx: Sandbox, h: HarnessName): Promise<Record<string, string>> => {
      const list = LOGIN_FILES[h].map(q).join(' ')
      const r = await sbx.run(`cd ${q(sbx.home)} && for f in ${list}; do [ -s "$f" ] && printf '%s\\t%s\\n' "$f" "$(base64 < "$f" | tr -d '\\n')"; done; true`)
      const files: Record<string, string> = {}
      for (const l of r.stdout.split('\n')) { const [p, b] = l.split('\t'); if (p && b) files[p] = fromB64(b) }
      return files
    }
    const sealFiles = async (user: string, h: HarnessName, files: Record<string, string>) => seal(await key, JSON.stringify(files), loginKey(user, h))

    /** Takes the login for one sandbox: shared with other jobs while the CLI will not refresh it before this job's
     *  time runs out, else alone, after the jobs that hold it. Returns the login it read under the lease. */
    async function take(user: string, h: HarnessName, alone = false): Promise<{ lease: string; version: string; text: string }> {
      const id = randomToken(12), k = leaseKey(user, h)
      for (const end = Date.now() + waitMs; ;) {
        const login = await store.get(loginKey(user, h))
        if (!login) throw new Error(`byoa: ${h} is not signed in for this user`)
        const text = await open(await key, login.value, loginKey(user, h))
        const share = parallel && !alone && refreshDue(h, JSON.parse(text)) - Date.now() > leaseMs
        const e = await store.get(k), l = readLease(e?.value)
        const free = !l.alone && (share ? !l.want : !Object.keys(l.shared ?? {}).length)
        if (free) {
          const until = Date.now() + leaseMs
          const next: Lease = share ? { shared: { ...l.shared, [id]: until } } : { alone: { id, until } }
          if (await store.cas(k, e?.version ?? null, JSON.stringify(next))) {
            // a job that held the login alone saved a refresh between the two reads: decide again with the new login
            if ((await store.get(loginKey(user, h)))?.version === login.version) return { lease: id, version: login.version, text }
            await give(user, h, id)
          }
          continue
        }
        // this job must hold the login alone: new jobs wait, so the jobs that share it now run out
        if (!share && !l.alone && !l.want) await store.cas(k, e?.version ?? null, JSON.stringify({ ...l, want: Date.now() + 5_000 }))
        if (Date.now() > end) throw new Error(`byoa: another job of this user still holds the ${h} login; try again when it ends`)
        await sleep(500)
      }
    }
    async function give(user: string, h: HarnessName, id: string) {
      const k = leaseKey(user, h)
      for (;;) {
        const e = await store.get(k)
        if (!e) return
        const l = readLease(e.value)
        if (l.alone?.id === id) delete l.alone
        else if (l.shared?.[id]) delete l.shared[id]
        else return
        if (await store.cas(k, e.version, JSON.stringify(l))) return
      }
    }

    const cli = cliLogin(d, {
      volumes: async () => [],
      async signedIn(sbx, user, h) {
        const files = await readFiles(sbx, h)
        if (!files[LOGIN_FILES[h][0]!]) throw new Error(`byoa: the ${h} sign-in ended, but its login file is not there`)
        await store.put(loginKey(user, h), await sealFiles(user, h, files))
      },
    })

    /** Writes the stored login into the sandbox, under the lease. `alone`: no other sandbox has it meanwhile. */
    async function load(sbx: Sandbox, user: string, h: HarnessName, alone = false) {
      const { lease, version, text } = await take(user, h, alone)
      try {
        for (const [p, body] of Object.entries(JSON.parse(text) as Record<string, string>)) await sbx.writeFile(`${sbx.home}/${p}`, body)
        await sbx.run(`chmod 600 ${LOGIN_FILES[h].map((p) => q(`${sbx.home}/${p}`)).join(' ')} 2>/dev/null; true`)
        held.set(sbx.id, { version, lease, text })
      } catch (e) {
        await give(user, h, lease)
        throw e
      }
    }

    return {
      ...cli,
      volumes: async () => [],
      present: async (_sbx, user, h) => !!(await store.get(loginKey(user, h))),
      async env(sbx, user, h) {
        await load(sbx, user, h)
        return loginEnv(sbx, h)
      },
      async release(sbx, user, h) {
        const x = held.get(sbx.id)
        held.delete(sbx.id)
        // the files leave the sandbox, which may be kept for the user's next job; the store keeps the login
        const remove = () => sbx.run(`rm -f ${[...LOGIN_FILES[h].map((p) => q(`${sbx.home}/${p}`)), ...(LOGIN_COPIES[h] ?? []).map((p) => `${q(sbx.home)}/${p}`)].join(' ')}`)
        if (!x) { await remove(); return }
        try {
          const now = await readFiles(sbx, h)
          // the CLI refreshed its login: keep the new files. Under the lease the version is still ours, unless the user
          // signed in again meanwhile (or, for a shared login, another job saved a refresh first); then that one wins.
          if (now[LOGIN_FILES[h][0]!] && JSON.stringify(now) !== JSON.stringify(JSON.parse(x.text))) await store.cas(loginKey(user, h), x.version, await sealFiles(user, h, now))
          const r = await remove()
          if (r.exitCode !== 0) throw new Error(`byoa: could not remove the ${h} login from the sandbox: ${r.stderr.trim()}`)
        } finally {
          await give(user, h, x.lease)
        }
      },
      async signOut(user, h) {
        // sign out with the CLI first, in a sandbox with the login written in, so the lab can revoke it
        if (await store.get(loginKey(user, h))) {
          try {
            const sbx = await d.sandbox.create({ labels: { 'byoa-app': d.app, 'byoa-logout': h }, timeoutMs: 5 * 60_000 })
            try {
              await load(sbx, user, h, true)
              const { bin } = await ensureHarness(sbx, h, d.pins)
              await sbx.run(`${q(bin)} ${h === 'claude' ? 'auth logout' : 'logout'} >/dev/null 2>&1; true`, { env: loginEnv(sbx, h), timeoutMs: 60_000 })
            } finally {
              const x = held.get(sbx.id)
              held.delete(sbx.id)
              if (x) await give(user, h, x.lease)
              await sbx.destroy().catch(() => {})
            }
          } catch {}
        }
        await store.delete(loginKey(user, h))
        await cli.setState(user, h, 'signed-out')
      },
    }
  }
}
