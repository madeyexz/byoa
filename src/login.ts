// AI login (R1), in a volume (R1.5): an option; the default is storedLogin (login-stored.ts, R1.4). This driver runs
// the labs' own, unmodified CLI sign-in in a sandbox that has the user's login volume mounted: `claude auth login`
// (R1.1), `codex login --device-auth` (R1.2) or `grok login --device-auth` (R1.2). The user signs in on the lab's own
// page; byoa gives the app only that page's address and, for Codex and Grok, the code to enter there (R1.3). The login files stay in the volume, which belongs to
// one user of one app; byoa never reads them or copies them anywhere.
// Each step uses only the sandbox interface (run, write a file), so it works on every provider and from short-lived
// backends such as Convex actions: the CLI runs in the background, and later calls resume the sandbox to read its
// output and to type the code into it. storedLogin uses the same steps with no volume, through CliHooks.
// Adapted from Bookish site/agent/login.ts.
import { sha256hex } from './crypto.ts'
import { HARNESSES, ensureHarness, harnessEnv } from './harness/index.ts'
import type { HarnessName, Pins } from './harness/pins.ts'
import { keys } from './keys.ts'
import type { Sandbox, SandboxProvider, Volume } from './sandbox/types.ts'
import { q } from './sh.ts'
import { sleep } from './time.ts'
import { update, type Store } from './store.ts'

export type LoginState = 'signed-in' | 'signed-out' | 'expired'

export interface LoginStart {
  harness: HarnessName
  /** The lab's own sign-in page. Show it to the user (as a link or a QR code). */
  url: string
  /** Codex and Grok: the one-time code the user enters on the lab's page (OpenAI's, xAI's). */
  code?: string
}

export interface LoginResult {
  /** `pending`: the user has not finished yet (Codex, Grok); ask again later. */
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
  /** Claude Code: `code` is the code Anthropic's page shows after sign-in. Codex and Grok: no code; `waitMs` waits
   *  that long for the user to finish on the lab's page. With no code (Claude) or no wait (Codex, Grok), it only checks in: the
   *  sign-in sandbox lives while the app checks in (R1.7). */
  finish(user: string, h: HarnessName, input?: { code?: string; waitMs?: number }): Promise<LoginResult>
  /** Ends a sign-in that has not finished, and its sandbox, at once. Nothing happens when none runs. */
  cancel(user: string, h: HarnessName): Promise<void>
  state(user: string, h: HarnessName): Promise<LoginState>
  setState(user: string, h: HarnessName, s: LoginState): Promise<void>
  signOut(user: string, h: HarnessName): Promise<void>
}

export interface JobLogin {
  /** When the provider ends or pauses the job's sandbox (ms since 1970), as the job saw it when it asked for the
   *  login: the login files leave the sandbox before. The job's time starts again once it has the login (it sets the
   *  sandbox's time again, Sandbox.setTimeout), so a driver that waits in line for the login adds the time it waited. */
  deadline?: number
  /** While the job waits in line for the login: how many jobs are ahead. */
  onWait?: (ahead: number) => void
}

/** The CLI's sign-out, for a sandbox that has the user's login: `<bin> <signOut>`. */
export const logoutCmd = (bin: string, h: HarnessName) => `${q(bin)} ${HARNESSES[h].login.signOut}`
const CODE_RE = /\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\s*\r?\n/
/** The most a sign-in may take, as long as Codex's device code lasts (Grok's lasts at least as long). */
export const LOGIN_MAX_MS = 15 * 60_000
/** After this long with no check-in (finishLogin), the provider ends the sign-in sandbox (R1.7). */
export const LOGIN_IDLE_MS = 2 * 60_000

const stateKey = keys.loginState
const pendingKey = keys.loginPending

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

/** The harness's environment: where it keeps its login, relative to the sandbox's home folder, and no self-update
 *  (byoa runs the pinned version, R5.1). Claude Code keeps .credentials.json and .claude.json in CLAUDE_CONFIG_DIR, so
 *  both are in the volume; Grok keeps auth.json, its sessions and settings in GROK_HOME. */
export const loginEnv = (sbx: Sandbox, h: HarnessName): Record<string, string> => harnessEnv(sbx.home, HARNESSES[h])

/** For storedLogin only: how the CLI sign-in differs when the login is not in a volume. */
export interface CliHooks {
  volumes?: (user: string, h: HarnessName) => Promise<Volume[]>
  /** The CLI signed in: called with its sandbox, before byoa destroys it. It saves the login with `save`, which writes
   *  only while this sign-in is still the one in progress, and returns what `save` returned. */
  signedIn?: (sbx: Sandbox, user: string, h: HarnessName, save: (store: Store, key: string, value: string) => Promise<boolean>) => Promise<boolean>
}

export function cliLogin(d: LoginDeps, hooks: CliHooks = {}): LoginDriver {
  // R5.3: a provider with no volumes refuses them; say so now, not at the user's first sign-in
  if (!hooks.volumes && d.sandbox.capabilities?.volumes === false) throw new Error(`byoa: the ${d.sandbox.name} provider has no volumes, so cliLogin cannot keep the login there; use storedLogin()`)
  const volumeName = async (user: string, h: HarnessName) => `byoa-${d.app}-${h}-${(await sha256hex(user)).slice(0, 24)}`
  const volumes = hooks.volumes ?? (async (user: string, h: HarnessName): Promise<Volume[]> => [{ name: await volumeName(user, h), path: HARNESSES[h].home.dir }])
  const envOf = loginEnv
  const present = async (sbx: Sandbox, _user: string, h: HarnessName) => (await sbx.run(`test -s ${q(`${sbx.home}/${HARNESSES[h].login.files[0]}`)}`)).exitCode === 0
  const dirOf = (sbx: Sandbox) => `${sbx.home}/.byoa/login`
  const read = async (sbx: Sandbox) => {
    const r = await sbx.run(`cd ${q(dirOf(sbx))} 2>/dev/null && { cat out 2>/dev/null; printf '\\n\\x01'; cat status 2>/dev/null; }; true`)
    const [out = '', status = ''] = r.stdout.split('\n\x01')
    return { out: out.replace(/\x1b\[[0-9;]*m/g, ''), status: status.trim() }
  }
  const lastLine = (out: string) => (/Couldn't log in[^\r\n]*|Error[^\r\n]*/.exec(out)?.[0] || out.trim().split(/\r?\n/).pop() || 'the sign-in did not finish').slice(0, 300)
  const setState = async (user: string, h: HarnessName, s: LoginState) => { await d.store.put(stateKey(user, h), s) }
  const state = async (user: string, h: HarnessName): Promise<LoginState> => ((await d.store.get(stateKey(user, h)))?.value as LoginState) || 'signed-out'
  /** An entry with no `at` is a sign-in that ended: none is in progress. */
  const ended = (v: string | undefined) => !v || JSON.parse(v).at === undefined
  /** Ends the sign-in of this user and harness that is in progress, and its sandbox. */
  const dropPending = async (user: string, h: HarnessName) => {
    // the entry ends with compare-and-set, and is never deleted: so the sandbox is the one of the entry it ended, also
    // when a connectLogin registers its sandbox or starts again meanwhile. An ended entry keeps its sandbox, which this
    // destroys again (signOut, also after a cancelLogin that has not destroyed it yet, or whose backend died).
    const p = await update(d.store, pendingKey(user, h), (v) => ended(v) ? undefined : JSON.stringify({ sandbox: JSON.parse(v!).sandbox }))
    // a connectLogin that still creates its sandbox finds its entry ended, and destroys the sandbox itself
    const { sandbox } = p ? JSON.parse(p) as { sandbox?: string } : {}
    if (sandbox) try { await d.sandbox.destroy(sandbox) } catch {}
  }
  /** Writes `value` at `key` with compare-and-set, only while `mine` is still the entry of the sign-in in progress, and
   *  returns the value it replaced (undefined: it wrote nothing). cancelLogin and signOut end that entry. A key that is
   *  not there gets an empty value first, so that a delete meanwhile changes its version. */
  const whileSigningIn = async (user: string, h: HarnessName, mine: string, store: Store, key: string, value: string) => {
    for (;;) {
      const e = await store.get(key)
      if ((await d.store.get(pendingKey(user, h)))?.value !== mine) return undefined
      if (!e) await store.cas(key, null, '')
      else if (await store.cas(key, e.version, value)) return e.value
    }
  }
  /** Ends the entry of the sign-in in progress if it is still `mine`. `sandbox`: its sandbox, when the provider could
   *  not destroy it, so that the next cancelLogin or signOut does. */
  const endPending = (user: string, h: HarnessName, mine: string, sandbox?: string) => update(d.store, pendingKey(user, h), (v) => v === mine ? JSON.stringify(sandbox ? { sandbox } : {}) : undefined)
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
      const at = Date.now(), mine = JSON.stringify({ at })
      // the sign-in's entry comes first, so a cancelLogin or signOut while the sandbox starts ends this sign-in too. It
      // replaces an earlier sign-in's entry with compare-and-set, after it destroyed that sign-in's sandbox: so no
      // sandbox of an earlier sign-in runs once this one is in progress (with cliLogin, it could still write the volume)
      for (;;) {
        const e = await d.store.get(pendingKey(user, h))
        const { sandbox: earlier } = e ? JSON.parse(e.value) as { sandbox?: string } : {}
        if (earlier) await d.sandbox.destroy(earlier).catch(() => {})
        if (await d.store.cas(pendingKey(user, h), e?.version ?? null, mine)) break
      }
      let sbx: Sandbox | undefined
      try {
        sbx = await d.sandbox.create({ volumes: await volumes(user, h), labels: { 'byoa-app': d.app, 'byoa-login': h }, timeoutMs: LOGIN_MAX_MS })
        const { bin } = await ensureHarness(sbx, h, d.pins)
        const cmd = `${q(bin)} ${HARNESSES[h].login.signIn}`
        await sbx.writeFile(`${dirOf(sbx)}/run.sh`, loginScript(cmd))
        await sbx.run(`bash ${q(`${dirOf(sbx)}/run.sh`)}`, { background: true, env: { ...envOf(sbx, h), BROWSER: 'false' } })
        for (const end = Date.now() + 30_000; Date.now() < end; await sleep(250)) {
          const { out, status } = await read(sbx)
          const spec = HARNESSES[h].login
          const url = spec.url.exec(out)?.[0]
          const code = spec.device ? CODE_RE.exec(out)?.[1] : undefined
          if (url && (!spec.device || code)) {
            if (!(await whileSigningIn(user, h, mine, d.store, pendingKey(user, h), JSON.stringify({ sandbox: sbx.id, at })))) throw new Error(`byoa: the ${h} sign-in was cancelled`)
            // from now on the sandbox lives only while the app checks in
            await keepAlive(sbx.id, at, LOGIN_IDLE_MS)
            return { harness: h, url, ...(code ? { code } : {}) }
          }
          if (status) throw new Error(`byoa: the ${h} sign-in ended at once: ${lastLine(out)}`)
        }
        throw new Error(`byoa: the ${h} sign-in did not show its page: ${lastLine((await read(sbx)).out)}`)
      } catch (e) {
        const left = sbx && (await sbx.destroy().then(() => undefined, () => sbx!.id))
        await endPending(user, h, mine, left).catch(() => {})
        throw e
      }
    },

    async finish(user, h, input = {}) {
      const code = input.code === undefined ? undefined : input.code.trim()
      const device = HARNESSES[h].login.device
      if (!device && code !== undefined && (!code || /[\s]/.test(code))) throw new Error(`byoa: the ${h} sign-in needs the code that the lab's page shows`)
      const p = await d.store.get(pendingKey(user, h))
      if (!p || ended(p.value)) return { state: await state(user, h), error: 'no sign-in is in progress' }
      const { sandbox: id, at } = JSON.parse(p.value) as { sandbox?: string; at: number }
      const ranOut = async () => { await dropPending(user, h); return { state: await state(user, h), error: 'the sign-in ran out; start it again' } }
      if (Date.now() - at > LOGIN_MAX_MS) return ranOut()
      // connectLogin still starts it
      if (!id) return { state: 'pending' }
      const wait = input.waitMs ?? (!device && code ? 60_000 : 0)
      let sbx: Sandbox
      try { sbx = await d.sandbox.resume(id, { timeoutMs: LOGIN_IDLE_MS + wait }) } catch { return ranOut() }
      await keepAlive(id, at, LOGIN_IDLE_MS + wait)
      if (!device && code) await sbx.run(`timeout 5 bash -c ${q(`printf '%s\\r' ${q(code)} > ${q(`${dirOf(sbx)}/in`)}`)}`)
      const end = Date.now() + wait
      let r = await read(sbx)
      while (!r.status) {
        if (Date.now() >= end) return { state: 'pending' }
        await sleep(500)
        r = await read(sbx)
      }
      const ok = await present(sbx, user, h)
      // a cancelLogin or signOut meanwhile wins: the login and then the state are saved only while this sign-in is in
      // progress. The state's save checks that after the login's: when it fails, the login saved goes back as it was.
      let login: { store: Store; key: string; value: string; before: string } | undefined
      const save = async (store: Store, key: string, value: string) => {
        const before = await whileSigningIn(user, h, p.value, store, key, value)
        if (before !== undefined) login = { store, key, value, before }
        return before !== undefined
      }
      let saved = false
      try {
        saved = ok && (!hooks.signedIn || (await hooks.signedIn(sbx, user, h, save))) && (await whileSigningIn(user, h, p.value, d.store, stateKey(user, h), 'signed-in')) !== undefined
      } finally {
        // the login is the one saved here while its value is (each save seals it anew)
        if (!saved && login) { const l = login, e = await l.store.get(l.key); if (e?.value === l.value) await l.store.cas(l.key, e.version, l.before) }
        const left = await sbx.destroy().then(() => undefined, () => id)
        await endPending(user, h, p.value, left)
      }
      if (saved) return { state: 'signed-in' }
      return { state: await state(user, h), error: ok ? 'the sign-in was cancelled' : lastLine(r.out) }
    },

    cancel: dropPending,

    async signOut(user, h) {
      await dropPending(user, h)
      // sign out with the CLI first, so the lab can revoke the login; deleting the volume removes the files anyway
      try {
        const sbx = await d.sandbox.create({ volumes: await volumes(user, h), labels: { 'byoa-app': d.app, 'byoa-logout': h }, timeoutMs: 5 * 60_000 })
        try {
          const { bin } = await ensureHarness(sbx, h, d.pins)
          await sbx.run(`${logoutCmd(bin, h)} >/dev/null 2>&1; true`, { env: envOf(sbx, h), timeoutMs: 60_000 })
        } finally { await sbx.destroy().catch(() => {}) }
      } catch {}
      await d.sandbox.deleteVolume(await volumeName(user, h))
      await setState(user, h, 'signed-out')
    },
  }
}
