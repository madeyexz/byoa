// AI login (R1), in a volume (R1.5): an option; the default is storedLogin (login-stored.ts, R1.4). This driver runs
// the labs' own, unmodified CLI sign-in in a sandbox that has the user's login volume mounted: `claude auth login`
// (R1.1) or `codex login --device-auth` (R1.2). The user signs in on the lab's own page; byoa gives the app only that
// page's address and, for Codex, the code to enter there (R1.3). The login files stay in the volume, which belongs to
// one user of one app; byoa never reads them or copies them anywhere.
// Each step uses only the sandbox interface (run, write a file), so it works on every provider and from short-lived
// backends such as Convex actions: the CLI runs in the background, and later calls resume the sandbox to read its
// output and to type the code into it. storedLogin uses the same steps with no volume, through CliHooks.
// Adapted from Bookish site/agent/login.ts.
import { sha256hex } from './crypto.ts'
import { ensureHarness } from './harness/install.ts'
import type { HarnessName, Pins } from './harness/pins.ts'
import type { Sandbox, SandboxProvider, Volume } from './sandbox/types.ts'
import { q } from './sh.ts'
import type { Store } from './store.ts'

export type LoginState = 'signed-in' | 'signed-out' | 'expired'

export interface LoginStart {
  harness: HarnessName
  /** The lab's own sign-in page. Show it to the user (as a link or a QR code). */
  url: string
  /** Codex only: the one-time code the user enters on OpenAI's page. */
  code?: string
}

export interface LoginResult {
  /** `pending`: the user has not finished yet (Codex); ask again later. */
  state: LoginState | 'pending'
  error?: string
}

export interface LoginDeps {
  sandbox: SandboxProvider
  store: Store
  app: string
  pins: Pins
  /** The app's encryptionKey. */
  encryptionKey: string
  jobTimeoutMs?: number
}

export interface LoginDriver {
  /** The volumes every job of this user and harness mounts. */
  volumes(user: string, h: HarnessName): Promise<Volume[]>
  /** Environment variables for the harness. `job`: when the job's sandbox time ends, and how long the job waits for
   *  the login when another job holds it. */
  env(sbx: Sandbox, user: string, h: HarnessName, job?: JobLogin): Promise<Record<string, string>>
  /** During the job, every minute or so: saves what the CLI changed in its login (a refresh) now, so a backend that
   *  dies loses at most that much (R1.4). */
  checkpoint?(sbx: Sandbox, user: string, h: HarnessName): Promise<void>
  /** Whether the sandbox has a login for the harness. */
  present(sbx: Sandbox, user: string, h: HarnessName): Promise<boolean>
  /** After the job, before byoa pauses or destroys the sandbox (also when the job failed, or env was never called). */
  release?(sbx: Sandbox, user: string, h: HarnessName): Promise<void>
  start(user: string, h: HarnessName): Promise<LoginStart>
  /** Claude Code: `code` is the code Anthropic's page shows after sign-in. Codex: no code; `waitMs` waits that long
   *  for the user to finish on OpenAI's page. With no code (Claude) or no wait (Codex), it only checks in: the
   *  sign-in sandbox lives while the app checks in (R1.7). */
  finish(user: string, h: HarnessName, input?: { code?: string; waitMs?: number }): Promise<LoginResult>
  /** Ends a sign-in that has not finished, and its sandbox, at once. Nothing happens when none runs. */
  cancel(user: string, h: HarnessName): Promise<void>
  state(user: string, h: HarnessName): Promise<LoginState>
  setState(user: string, h: HarnessName, s: LoginState): Promise<void>
  signOut(user: string, h: HarnessName): Promise<void>
}

export interface JobLogin {
  /** When the provider ends or pauses the job's sandbox (ms since 1970): the login files leave the sandbox before. */
  deadline?: number
  /** While the job waits in line for the login: how many jobs are ahead. */
  onWait?: (ahead: number) => void
}

/** Where each harness keeps its login, relative to the home folder. Each is the mount path of a login volume. */
export const LOGIN_DIRS: Record<HarnessName, string> = { claude: '.claude', codex: '.codex' }
const CREDS: Record<HarnessName, string> = { claude: '.claude/.credentials.json', codex: '.codex/auth.json' }
const URL_RE: Record<HarnessName, RegExp> = {
  claude: /https:\/\/claude\.(?:com|ai)\/[^\s\x07\x1b]+/,
  codex: /https:\/\/auth\.openai\.com\/[^\s\x07\x1b]+/,
}
const CODE_RE = /\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\s*\r?\n/
/** The most a sign-in may take, as long as Codex's device code lasts. */
export const LOGIN_MAX_MS = 15 * 60_000
/** After this long with no check-in (finishLogin), the provider ends the sign-in sandbox (R1.7). */
export const LOGIN_IDLE_MS = 2 * 60_000

const enc = encodeURIComponent
const stateKey = (user: string, h: HarnessName) => `login/${enc(user)}/${h}`
const pendingKey = (user: string, h: HarnessName) => `loginjob/${enc(user)}/${h}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Runs the CLI's sign-in under `script` (it wants a terminal), with its input from a FIFO that a later call writes
 *  the code into. `status` gets the CLI's exit code when it ends. */
const loginScript = (cmd: string) => `#!/bin/bash
cd "$(dirname "$0")" || exit 1
rm -f in out status
mkfifo in
sleep ${LOGIN_MAX_MS / 1000} > in &
holder=$!
run=${q(`stty cols 2000 2>/dev/null; exec ${cmd}`)}
# util-linux's script (every Linux sandbox) gives the CLI a terminal. BSD's script (macOS, with the local sandbox) has
# other flags and refuses input that is not a terminal: there the CLI runs with no terminal, which is enough for
# \`codex login --device-auth\` (checked with codex-cli 0.171.0 on macOS 27).
if script --version >/dev/null 2>&1; then script -qfec "$run" /dev/null < in > out 2>&1
else bash -c "$run" < in > out 2>&1
fi
echo $? > status
kill $holder 2>/dev/null
`

/** The harness's environment: where it keeps its login, relative to the sandbox's home folder. */
export const loginEnv = (sbx: Sandbox, h: HarnessName): Record<string, string> => h === 'claude'
    // Claude Code keeps .credentials.json and .claude.json in CLAUDE_CONFIG_DIR, so both are in the volume; and it
    // must not update itself: byoa runs the pinned version (R5.1)
    ? { CLAUDE_CONFIG_DIR: `${sbx.home}/${LOGIN_DIRS.claude}`, DISABLE_AUTOUPDATER: '1' }
    : { CODEX_HOME: `${sbx.home}/${LOGIN_DIRS.codex}` }

/** For storedLogin only: how the CLI sign-in differs when the login is not in a volume. */
export interface CliHooks {
  volumes?: (user: string, h: HarnessName) => Promise<Volume[]>
  /** The CLI signed in: called with its sandbox, before byoa destroys it. */
  signedIn?: (sbx: Sandbox, user: string, h: HarnessName) => Promise<void>
}

export function cliLogin(d: LoginDeps, hooks: CliHooks = {}): LoginDriver {
  const volumeName = async (user: string, h: HarnessName) => `byoa-${d.app}-${h}-${(await sha256hex(user)).slice(0, 24)}`
  const volumes = hooks.volumes ?? (async (user: string, h: HarnessName): Promise<Volume[]> => [{ name: await volumeName(user, h), path: LOGIN_DIRS[h] }])
  const envOf = loginEnv
  const present = async (sbx: Sandbox, _user: string, h: HarnessName) => (await sbx.run(`test -s ${q(`${sbx.home}/${CREDS[h]}`)}`)).exitCode === 0
  const dirOf = (sbx: Sandbox) => `${sbx.home}/.byoa/login`
  const read = async (sbx: Sandbox) => {
    const r = await sbx.run(`cd ${q(dirOf(sbx))} 2>/dev/null && { cat out 2>/dev/null; printf '\\n\\x01'; cat status 2>/dev/null; }; true`)
    const [out = '', status = ''] = r.stdout.split('\n\x01')
    return { out: out.replace(/\x1b\[[0-9;]*m/g, ''), status: status.trim() }
  }
  const lastLine = (out: string) => (/Couldn't log in[^\r\n]*|Error[^\r\n]*/.exec(out)?.[0] || out.trim().split(/\r?\n/).pop() || 'the sign-in did not finish').slice(0, 300)
  const setState = async (user: string, h: HarnessName, s: LoginState) => { await d.store.put(stateKey(user, h), s) }
  const state = async (user: string, h: HarnessName): Promise<LoginState> => ((await d.store.get(stateKey(user, h)))?.value as LoginState) ?? 'signed-out'
  /** Ends an earlier sign-in of this user and harness that never finished. */
  const dropPending = async (user: string, h: HarnessName) => {
    const p = await d.store.get(pendingKey(user, h))
    if (!p) return
    await d.store.delete(pendingKey(user, h))
    try { await d.sandbox.destroy(JSON.parse(p.value).sandbox) } catch {}
  }
  /** The sign-in sandbox ends `ms` from now, at the latest LOGIN_MAX_MS after the sign-in started. */
  const keepAlive = async (id: string, at: number, ms: number) => {
    await d.sandbox.keepAlive?.(id, Math.max(1_000, Math.min(ms, at + LOGIN_MAX_MS - Date.now()))).catch(() => {})
  }

  return {
    volumes,
    env: async (sbx, _user, h) => envOf(sbx, h),
    present,
    state,
    setState,

    async start(user, h) {
      await dropPending(user, h)
      const at = Date.now()
      const sbx = await d.sandbox.create({ volumes: await volumes(user, h), labels: { 'byoa-app': d.app, 'byoa-login': h }, timeoutMs: LOGIN_MAX_MS })
      try {
        const { bin } = await ensureHarness(sbx, h, d.pins)
        const cmd = h === 'claude' ? `${q(bin)} auth login` : `${q(bin)} login --device-auth`
        await sbx.writeFile(`${dirOf(sbx)}/run.sh`, loginScript(cmd))
        await sbx.run(`bash ${q(`${dirOf(sbx)}/run.sh`)}`, { background: true, env: { ...envOf(sbx, h), BROWSER: 'false' } })
        for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
          const { out, status } = await read(sbx)
          const url = URL_RE[h].exec(out)?.[0]
          const code = h === 'codex' ? CODE_RE.exec(out)?.[1] : undefined
          if (url && (h === 'claude' || code)) {
            await d.store.put(pendingKey(user, h), JSON.stringify({ sandbox: sbx.id, at }))
            // from now on the sandbox lives only while the app checks in
            await keepAlive(sbx.id, at, LOGIN_IDLE_MS)
            return { harness: h, url, ...(code ? { code } : {}) }
          }
          if (status) throw new Error(`byoa: the ${h} sign-in ended at once: ${lastLine(out)}`)
        }
        throw new Error(`byoa: the ${h} sign-in did not show its page: ${lastLine((await read(sbx)).out)}`)
      } catch (e) {
        await sbx.destroy().catch(() => {})
        throw e
      }
    },

    async finish(user, h, input = {}) {
      const code = input.code === undefined ? undefined : input.code.trim()
      if (h === 'claude' && code !== undefined && (!code || /[\s]/.test(code))) throw new Error("byoa: the Claude Code sign-in needs the code that Anthropic's page shows")
      const p = await d.store.get(pendingKey(user, h))
      if (!p) return { state: await state(user, h), error: 'no sign-in is in progress' }
      const { sandbox: id, at } = JSON.parse(p.value) as { sandbox: string; at: number }
      const ranOut = async () => { await dropPending(user, h); return { state: await state(user, h), error: 'the sign-in ran out; start it again' } }
      if (Date.now() - at > LOGIN_MAX_MS) return ranOut()
      const wait = input.waitMs ?? (h === 'claude' && code ? 60_000 : 0)
      let sbx: Sandbox
      try { sbx = await d.sandbox.resume(id, { timeoutMs: LOGIN_IDLE_MS + wait }) } catch { return ranOut() }
      await keepAlive(id, at, LOGIN_IDLE_MS + wait)
      if (h === 'claude' && code) await sbx.run(`timeout 5 bash -c ${q(`printf '%s\\r' ${q(code)} > ${q(`${dirOf(sbx)}/in`)}`)}`)
      const end = Date.now() + wait
      let r = await read(sbx)
      while (!r.status) {
        if (Date.now() >= end) return { state: 'pending' }
        await sleep(500)
        r = await read(sbx)
      }
      const ok = await present(sbx, user, h)
      await d.store.delete(pendingKey(user, h))
      try { if (ok) await hooks.signedIn?.(sbx, user, h) } finally { await sbx.destroy().catch(() => {}) }
      if (ok) { await setState(user, h, 'signed-in'); return { state: 'signed-in' } }
      return { state: await state(user, h), error: lastLine(r.out) }
    },

    cancel: dropPending,

    async signOut(user, h) {
      await dropPending(user, h)
      // sign out with the CLI first, so the lab can revoke the login; deleting the volume removes the files anyway
      try {
        const sbx = await d.sandbox.create({ volumes: await volumes(user, h), labels: { 'byoa-app': d.app, 'byoa-logout': h }, timeoutMs: 5 * 60_000 })
        try {
          const { bin } = await ensureHarness(sbx, h, d.pins)
          await sbx.run(`${q(bin)} ${h === 'claude' ? 'auth logout' : 'logout'} >/dev/null 2>&1; true`, { env: envOf(sbx, h), timeoutMs: 60_000 })
        } finally { await sbx.destroy().catch(() => {}) }
      } catch {}
      await d.sandbox.deleteVolume(await volumeName(user, h))
      await setState(user, h, 'signed-out')
    },
  }
}
