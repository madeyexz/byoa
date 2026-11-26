// What a job runs the harness with: one concept for the two kinds (R1). A lab login (R1.4, R1.5) is the CLI's own login
// files: it needs the sandbox to check it, it has a lease, and the CLI rotates it. A plan's key (R1.8) stays in the
// store and in the app's backend: the harness reaches the plan through the relay with the job token, and the key needs
// no lease. The fake harness (R7.2) has neither. A job asks its credential for its environment and flags, and gives it
// back after; it does not know which kind it has.
import type { AgentEvent } from './harness/events.ts'
import { harnessEnv } from './harness/index.ts'
import type { Harness, LabHarness, ModelChoice } from './harness/types.ts'
import type { UsageLimits } from './limits.ts'
import type { JobLogin, LoginDriver } from './login.ts'
import { NO_PLAN, relayUrl, type PlanKeys, type PlanName } from './plan.ts'
import type { Sandbox, Volume } from './sandbox/types.ts'
import { q } from './sh.ts'
import { now } from './time.ts'

/** The harness has no login for this user. */
export class LoginError extends Error { readonly code = 'signed-out' }

export interface Credential {
  /** Before any sandbox: throws LoginError when the store says the user has none (a plan's key). */
  ready(): Promise<void>
  /** The volumes every sandbox of this user and harness mounts (R1.5). */
  volumes(): Promise<Volume[]>
  /** In the job's sandbox: throws LoginError when the user has no login there. */
  check(sbx: Sandbox): Promise<void>
  /** Puts the credential in the sandbox (R1.4) or points the harness at the relay (R1.8): the harness's environment
   *  and the flags of the job's model and effort (R5.7). */
  load(sbx: Sandbox, o: { token: string; job: JobLogin }): Promise<{ env: Record<string, string>; args: string[] }>
  /** During the job, every minute: saves what the CLI changed in its login (R1.4). */
  checkpoint?(sbx: Sandbox): Promise<void>
  /** After the job, before the sandbox pauses or goes: saves the login and removes it from the sandbox. */
  release(sbx: Sandbox): Promise<void>
  /** What a job showed of the credential (R1.6). */
  report(state: 'signed-in' | 'expired'): Promise<void>
  /** An event of the harness, in this credential's terms (a plan's `no-plan`, or `usage-limit` that the relay saw). */
  event(ev: AgentEvent): AgentEvent | Promise<AgentEvent>
}

/** The user's own lab login: the CLI's login files, through the login driver. */
export function labLogin(login: LoginDriver, user: string, x: LabHarness, model: ModelChoice): Credential {
  const h = x.name
  return {
    ready: async () => {},
    volumes: () => login.volumes(user, h),
    async check(sbx) {
      if (await login.present(sbx, user, h)) return
      await login.setState(user, h, 'signed-out')
      throw new LoginError(`${h} is not signed in for this user; call connectLogin first`)
    },
    load: async (sbx, o) => ({ env: { ...(await login.env(sbx, user, h, o.job)), ...x.jobEnv }, args: x.modelArgs(model) }),
    ...(login.checkpoint ? { checkpoint: (sbx: Sandbox) => login.checkpoint!(sbx, user, h) } : {}),
    release: async (sbx) => { await login.release?.(sbx, user, h) },
    async report(state) { if (state === 'expired' || (await login.state(user, h)) !== state) await login.setState(user, h, state) },
    event: (ev) => ev,
  }
}

/** A plan that the user brought as a key (R1.8). The key never enters the sandbox. */
export function planKey(plans: PlanKeys, login: LoginDriver, limits: UsageLimits, user: string, plan: PlanName, x: Harness & { plan: NonNullable<Harness['plan']> }, o: { proxyUrl: string; model: string; effort?: string }): Credential {
  const h = x.name as LabHarness['name']
  const since = now()
  return {
    async ready() { if (!(await plans.has(user, plan))) throw new LoginError(`${plan} is not connected for this user; call connectKey first`) },
    // the user's kept sandbox of this harness is the same for both kinds, so it mounts the login volume of cliLogin too
    volumes: () => login.volumes(user, h),
    check: async () => {},
    async load(sbx, l) {
      const p = x.plan({ base: relayUrl(o.proxyUrl, plan), token: l.token, home: sbx.home, model: o.model, effort: o.effort })
      await sbx.run(`mkdir -p ${p.dirs.map(q).join(' ')}`)
      return { env: { ...p.env, ...x.jobEnv }, args: p.args }
    },
    // a job of a lab login that never closed may have left its files in this kept sandbox: they go too
    release: async (sbx) => { await login.release?.(sbx, user, h) },
    // the relay saw OpenCode's answer and set `expired` or `no-plan` itself; a job that worked is signed in
    async report(state) { if (state === 'signed-in' && (await plans.state(user, plan)) !== 'signed-in') await plans.setState(user, plan, 'signed-in') },
    async event(ev) {
      if (ev.type !== 'error') return ev
      if (NO_PLAN.test(ev.message)) return { ...ev, code: 'no-plan' }
      // R1.9: the harness saw OpenCode's 429 in its own words; the relay asked OpenCode's usage meter whether the plan
      // is used up, and kept it during this job
      if (ev.code !== 'harness' && ev.code !== 'rate-limited' && ev.code !== 'usage-limit') return ev
      const l = await limits.get(user, plan)
      if (!l || l.at < since) return ev
      const { resetsAt: _, ...rest } = ev
      return { ...rest, code: 'usage-limit', ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) }
    },
  }
}

/** The fake harness (R7.2): no login. */
export const noCredential = (x: Harness): Credential => ({
  ready: async () => {},
  volumes: async () => [],
  check: async () => {},
  load: async (sbx) => ({ env: harnessEnv(sbx.home, x), args: [] }),
  release: async () => {},
  report: async () => {},
  event: (ev) => ev,
})
