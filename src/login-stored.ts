// The default AI login (R1.4): the app's database holds it, encrypted, through the store adapter (R6).
// The sign-in is cliLogin's: the lab's own, unmodified CLI, on the lab's own page (R1.1, R1.2). When it ends, byoa
// reads the CLI's own login files from that sandbox and keeps them encrypted in the store, one entry per user and
// harness in the app's own store. A job's sandbox has no login volume: byoa writes the files in, and after the job it
// saves them back when the CLI changed them (it refreshes its own tokens) and removes them from the sandbox, also from
// the user's sandbox that byoa keeps between jobs (R5.4). So the store is the only copy between jobs. byoa never reads the
// tokens inside the files or calls the lab's token endpoints itself, so the CLI stays the only client that uses them.
// Both CLIs rotate their refresh tokens, so only one sandbox holds a user's login at a time: a job takes a lease with
// compare-and-set and waits for another job of the same user and harness to give it back.
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
  /** How long a job waits for another job of the same user and harness to give the login back. Default 10 minutes. */
  waitMs?: number
}

/** The CLI's own login files, relative to the home folder. */
export const LOGIN_FILES: Record<HarnessName, string[]> = { claude: ['.claude/.credentials.json', '.claude/.claude.json'], codex: ['.codex/auth.json'] }

const enc = encodeURIComponent
const loginKey = (user: string, h: HarnessName) => `ailogin/${enc(user)}/${h}`
const leaseKey = (user: string, h: HarnessName) => `ailoginlease/${enc(user)}/${h}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const fromB64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))

export function storedLogin(o: StoredLoginOptions = {}): (d: LoginDeps) => LoginDriver {
  return (d) => {
    const store = o.store ?? d.store
    const key = importKey(o.encryptionKey ?? d.encryptionKey)
    key.catch(() => {})
    const leaseMs = (d.jobTimeoutMs ?? 30 * 60_000) + 5 * 60_000
    const waitMs = o.waitMs ?? 10 * 60_000
    /** What each job's sandbox got: by sandbox id. */
    const held = new Map<string, { version: string; lease: string; text: string }>()
    const readFiles = async (sbx: Sandbox, h: HarnessName): Promise<Record<string, string>> => {
      const list = LOGIN_FILES[h].map(q).join(' ')
      const r = await sbx.run(`cd ${q(sbx.home)} && for f in ${list}; do [ -s "$f" ] && printf '%s\\t%s\\n' "$f" "$(base64 -w0 "$f")"; done; true`)
      const files: Record<string, string> = {}
      for (const l of r.stdout.split('\n')) { const [p, b] = l.split('\t'); if (p && b) files[p] = fromB64(b) }
      return files
    }
    const sealFiles = async (user: string, h: HarnessName, files: Record<string, string>) => seal(await key, JSON.stringify(files), loginKey(user, h))

    async function take(user: string, h: HarnessName): Promise<string> {
      const id = randomToken(12)
      for (const end = Date.now() + waitMs; ;) {
        const e = await store.get(leaseKey(user, h))
        const free = !e || (JSON.parse(e.value) as { until: number }).until < Date.now()
        if (free && (await store.cas(leaseKey(user, h), e?.version ?? null, JSON.stringify({ id, until: Date.now() + leaseMs })))) return id
        if (Date.now() > end) throw new Error(`byoa: another job of this user still holds the ${h} login; try again when it ends`)
        await sleep(500)
      }
    }
    async function give(user: string, h: HarnessName, id: string) {
      const e = await store.get(leaseKey(user, h))
      if (e && (JSON.parse(e.value) as { id: string }).id === id) await store.cas(leaseKey(user, h), e.version, JSON.stringify({ id, until: 0 }))
    }

    const cli = cliLogin(d, {
      volumes: async () => [],
      async signedIn(sbx, user, h) {
        const files = await readFiles(sbx, h)
        if (!files[LOGIN_FILES[h][0]!]) throw new Error(`byoa: the ${h} sign-in ended, but its login file is not there`)
        await store.put(loginKey(user, h), await sealFiles(user, h, files))
      },
    })

    /** Writes the stored login into the sandbox, under the lease. */
    async function load(sbx: Sandbox, user: string, h: HarnessName) {
      const lease = await take(user, h)
      try {
        const e = await store.get(loginKey(user, h))
        if (!e) throw new Error(`byoa: ${h} is not signed in for this user`)
        const text = await open(await key, e.value, loginKey(user, h))
        for (const [p, body] of Object.entries(JSON.parse(text) as Record<string, string>)) await sbx.writeFile(`${sbx.home}/${p}`, body)
        await sbx.run(`chmod 600 ${LOGIN_FILES[h].map((p) => q(`${sbx.home}/${p}`)).join(' ')} 2>/dev/null; true`)
        held.set(sbx.id, { version: e.version, lease, text })
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
        const remove = () => sbx.run(`rm -f ${LOGIN_FILES[h].map((p) => q(`${sbx.home}/${p}`)).join(' ')}`)
        if (!x) { await remove(); return }
        try {
          const now = await readFiles(sbx, h)
          // the CLI refreshed its login: keep the new files. Under the lease the version is still ours, unless the user
          // signed in again meanwhile; then that new login wins.
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
              await load(sbx, user, h)
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
