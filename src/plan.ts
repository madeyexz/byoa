// A plan that the user brings as an API key (R1.8): OpenCode Go. Beta: checked only against a stand-in for OpenCode's
// API (test/plan.test.ts, and the real CLIs locally and on E2B); V20, with a real Go key, has not run yet. It is not a harness and not a lab sign-in: the user
// creates a key in OpenCode's Console (`oc_sk_…`), the app gives it to connectKey, and byoa keeps it encrypted in the
// app's store (R6), as it keeps MCP grants (R2.4). A job of the unmodified Claude Code or Codex then runs with it
// instead of the lab's login.
// The key never goes into the sandbox. The harness sends its model requests to a relay in `agents.proxy`
// (`<proxyUrl>/_plan/opencode-go/...`) with the job token, as it reaches MCP servers (R3); the relay checks the job
// token, puts the user's key on the request, and sends it on to OpenCode, with the harness's own headers (its user
// agent and session id, which OpenCode Go wants), and streams the answer back. So a job token, which stops working
// when its job ends (R3.4), is all the agent can read. A key does not rotate, so jobs need no lease and run at the
// same time. OpenCode answers 401 to a key that is wrong, revoked or expired (`expired`; a key cannot be renewed), and
// 403 "OpenCode Go subscription required" to a key whose workspace has no Go plan (`no-plan`).
// Only OpenCode's documented API and its documented settings for Claude Code and Codex: no OpenCode client, no
// Console CLI sign-in (it has OpenCode's own client ID; SPEC.md, Lab rules).
import { claudeModelArgs } from './harness/claude.ts'
import { codexModelArgs } from './harness/codex.ts'
import type { ModelInfo } from './harness/models.ts'
import type { HarnessName } from './harness/pins.ts'
import { open, seal } from './crypto.ts'
import { JOB_TOKEN_ENV } from './config.ts'
import type { LoginState } from './login.ts'
import type { JobRecord } from './mcp/proxy.ts'
import type { Store } from './store.ts'

export type PlanName = 'opencode-go'
export const PLANS: PlanName[] = ['opencode-go']
/** A key's state (R1.6): `no-plan` when the key works but its workspace has no Go plan. */
export type PlanState = LoginState | 'no-plan'
export const isPlan = (s: unknown): s is PlanName => PLANS.includes(s as PlanName)

/** OpenCode Go's API (https://opencode.ai/docs/console/go). */
export const GO_API = 'https://opencode.ai/inference/go'
/** The relay's path below proxyUrl. An MCP server name has no `_`, so this is no server's path. */
export const RELAY_PREFIX = '_plan/'
export const relayUrl = (proxyUrl: string, plan: PlanName) => `${proxyUrl.replace(/\/+$/, '')}/${RELAY_PREFIX}${plan}`
/** What OpenCode says when the key's workspace has no Go plan. */
export const NO_PLAN = /subscription required|EntitlementError/i

/** How each harness runs with the plan: its environment and flags. A harness with no entry cannot use a plan.
 *  `base`: the relay for this job; `home`: the sandbox's home folder. Each job has a config folder of its own, with no
 *  login of the lab in it, so the CLI sends only the job token. */
export const PLAN_HARNESS: Partial<Record<HarnessName, (o: { base: string; token: string; home: string; model: string; effort?: string }) => { env: Record<string, string>; args: string[]; dirs: string[] }>> = {
  // OpenCode's settings for Claude Code (docs/console/harnesses/claude-code): ANTHROPIC_BASE_URL with no /v1/messages,
  // and ANTHROPIC_AUTH_TOKEN, which Claude Code sends as `Authorization: Bearer`. Every model alias is the job's model,
  // so a background request of Claude Code (a small model) does not ask for a Claude model the plan does not have.
  claude: (o) => {
    const dir = `${o.home}/.byoa/plan/claude`
    return {
      dirs: [dir],
      env: {
        CLAUDE_CONFIG_DIR: dir, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        ANTHROPIC_BASE_URL: `${o.base}/anthropic`, ANTHROPIC_AUTH_TOKEN: o.token,
        ANTHROPIC_DEFAULT_OPUS_MODEL: o.model, ANTHROPIC_DEFAULT_SONNET_MODEL: o.model, ANTHROPIC_DEFAULT_HAIKU_MODEL: o.model,
        ANTHROPIC_SMALL_FAST_MODEL: o.model, CLAUDE_CODE_SUBAGENT_MODEL: o.model,
      },
      args: claudeModelArgs(o),
    }
  },
  // OpenCode's settings for Codex (docs/console/harnesses/codex), as `-c` overrides, so they hold for this job only:
  // a model provider with the Responses API, which reads the job token from JOB_TOKEN_ENV.
  codex: (o) => {
    const dir = `${o.home}/.byoa/plan/codex`
    return {
      dirs: [dir],
      env: { CODEX_HOME: dir },
      args: [
        '-c', 'model_provider="opencode-go"',
        '-c', `model_providers.opencode-go={name="OpenCode Go",base_url=${JSON.stringify(`${o.base}/openai/v1`)},env_key="${JOB_TOKEN_ENV}",wire_api="responses"}`,
        ...codexModelArgs(o),
      ],
    }
  },
}

/** Request headers the relay sends on: the harness's own (its user agent, its session id, the API version and betas),
 *  as Claude Code 2.1.330 and Codex 0.171.0 send them (seen at a stand-in API). Every other header stays behind, as at
 *  the MCP proxy (mcp/proxy.ts): the job token, cookies, and anything the app's own gateway or a tunnel added. */
const UP = new Set(['accept', 'content-type', 'user-agent', 'x-app', 'originator', 'session-id', 'session_id', 'thread-id',
  'x-client-request-id', 'x-opencode-session'])
const UP_PREFIX = ['anthropic-', 'x-stainless-', 'x-claude-code-', 'x-codex-', 'openai-']
const sendUp = (k: string) => UP.has(k) || UP_PREFIX.some((p) => k.startsWith(p))
/** fetch has decoded the body already. */
const DROP_DOWN = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'])

/** An error in the shape of the Anthropic and OpenAI APIs, so the harness shows its message. */
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ type: 'error', error: { type: 'byoa_error', message } }), { status, headers: { 'content-type': 'application/json' } })

const enc = encodeURIComponent
const keyKey = (user: string, p: PlanName) => `aikey/${enc(user)}/${p}`
const stateKey = (user: string, p: PlanName) => `aikeystate/${enc(user)}/${p}`
const UA = 'byoa'

export function planKeys(store: Store, key: Promise<CryptoKey>) {
  const get = async (user: string, p: PlanName) => {
    const e = await store.get(keyKey(user, p))
    return e ? open(await key, e.value, keyKey(user, p)) : undefined
  }
  const setState = async (user: string, p: PlanName, s: PlanState) => { await store.put(stateKey(user, p), s) }
  const state = async (user: string, p: PlanName): Promise<PlanState> => {
    if (!(await store.get(keyKey(user, p)))) return 'signed-out'
    return ((await store.get(stateKey(user, p)))?.value as PlanState) ?? 'signed-in'
  }
  const message = (text: string) => { try { return String(JSON.parse(text)?.error?.message ?? text) } catch { return text } }

  return {
    get,
    has: async (user: string, p: PlanName) => !!(await store.get(keyKey(user, p))),
    state,
    setState,

    /** Checks the key with OpenCode's usage meter, and keeps it when OpenCode knows it: `signed-in`, or `no-plan` when
     *  its workspace has no Go plan (it works once the user subscribes). A key OpenCode refuses is not kept. */
    async connect(user: string, p: PlanName, apiKey: string): Promise<{ state: PlanState; error?: string }> {
      const k = apiKey.trim()
      if (!k || /\s/.test(k) || k.length > 512) throw new Error('byoa: the key must be one word')
      const r = await fetch(`${GO_API}/v1/usage`, { headers: { authorization: `Bearer ${k}`, 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      const text = await r.text()
      if (r.status === 401) return { state: await state(user, p), error: `OpenCode did not accept the key (it is wrong, revoked or expired): ${message(text).slice(0, 300)}` }
      if (!r.ok && r.status !== 403) throw new Error(`byoa: OpenCode answered ${r.status}: ${message(text).slice(0, 300)}`)
      await store.put(keyKey(user, p), await seal(await key, k, keyKey(user, p)))
      if (r.status === 403) {
        await setState(user, p, 'no-plan')
        return { state: 'no-plan', error: message(text).slice(0, 300) }
      }
      await setState(user, p, 'signed-in')
      return { state: 'signed-in' }
    },

    async remove(user: string, p: PlanName) {
      await store.delete(keyKey(user, p))
      await store.delete(stateKey(user, p))
    },

    /** The plan's chat models, as OpenCode lists them for this key. Not the free ones: OpenCode serves them only to
     *  its own client, and answers 403 to Claude Code and Codex. */
    async models(apiKey: string): Promise<ModelInfo[]> {
      const r = await fetch(`${GO_API}/v1/models`, { headers: { authorization: `Bearer ${apiKey}`, 'user-agent': UA }, signal: AbortSignal.timeout(15_000) })
      if (!r.ok) throw new Error(`byoa: OpenCode did not list its models (${r.status}): ${message(await r.text()).slice(0, 300)}`)
      const data: any[] = (await r.json())?.data ?? []
      return data.filter((m) => m?.type === 'chat' && typeof m.go?.monthly_usage?.go === 'number').map((m) => ({
        id: String(m.id), name: String(m.name ?? m.id), description: String(m.description ?? ''), isDefault: false,
        efforts: (m.capabilities?.reasoning?.effort ?? []).map(String),
      }))
    },

    /** The relay, for `<proxyUrl>/_plan/<plan>/<api path>` (proxy.ts has checked the job token). */
    async relay(req: Request, job: JobRecord, rest: string): Promise<Response> {
      const i = rest.indexOf('/')
      const p = rest.slice(0, i), path = rest.slice(i + 1)
      if (i < 0 || !isPlan(p) || job.plan !== p) return fail(403, `this job does not have the plan ${p || rest}`)
      // only the model APIs that the harnesses use
      if (!/^(?:anthropic|openai)\/v1\/[a-z0-9_./-]+$/i.test(path) || path.split('/').includes('..')) return fail(404, 'no such API')
      if (req.method !== 'POST' && req.method !== 'GET') return fail(405, 'only GET and POST')
      const apiKey = await get(job.user, p)
      if (!apiKey) return fail(401, `the user has no ${p} key; connect it again`)
      const h = new Headers()
      req.headers.forEach((v, k) => { if (sendUp(k)) h.set(k, v) })
      h.set('authorization', `Bearer ${apiKey}`)
      // OpenCode Go routes and caches by a session id of each conversation; Claude Code and Codex send their own,
      // which OpenCode knows. A job is one conversation.
      if (!h.has('x-opencode-session')) h.set('x-opencode-session', `ses_${job.job}`)
      let res: Response
      try {
        res = await fetch(`${GO_API}/${path}${new URL(req.url).search}`, {
          method: req.method, headers: h, redirect: 'manual', signal: req.signal,
          ...(req.method === 'POST' ? { body: await req.arrayBuffer() } : {}),
        })
      } catch (e) { return fail(502, `OpenCode did not answer: ${(e as Error).message}`) }
      const down = new Headers()
      res.headers.forEach((v, k) => { if (!DROP_DOWN.has(k)) down.set(k, v) })
      if (res.status === 401 || res.status === 403) {
        const text = await res.text()
        if (res.status === 401) await setState(job.user, p, 'expired')
        else if (NO_PLAN.test(text)) await setState(job.user, p, 'no-plan')
        return new Response(text, { status: res.status, headers: down })
      }
      return new Response(res.body, { status: res.status, headers: down })
    },
  }
}

export type PlanKeys = ReturnType<typeof planKeys>
