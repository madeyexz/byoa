// A stand-in for OpenCode Go's API (https://opencode.ai/inference/go), for byoa's own tests only: it keeps each
// request, and answers the usage meter, the model list, Anthropic Messages and OpenAI Responses as the docs say
// (https://opencode.ai/docs/console/go). The real check (V20) uses OpenCode itself. While it runs, this process's
// requests to https://opencode.ai/ go to it, so byoa's relay reaches it with no change.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Seen { method: string; path: string; headers: Record<string, string>; body: string }

/** `oc_sk_good` works; `oc_sk_noplan` has no Go plan (403); every other key is refused (401). `mode` changes what a
 *  model request gets, for every key. `delayMs`: each model request waits that long. */
export async function fakeOpenCodeGo() {
  const seen: Seen[] = []
  const s = { seen, mode: 'ok' as 'ok' | '401' | '403', delayMs: 0, inFlight: 0, maxInFlight: 0 }
  const json = (res: any, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const c of req) body += c
    seen.push({ method: req.method!, path: req.url!, headers: req.headers as Record<string, string>, body })
    const path = req.url!.replace(/^\/inference\/go/, '')
    const key = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const status = s.mode === '401' || (key !== 'oc_sk_good' && key !== 'oc_sk_noplan') ? 401 : s.mode === '403' || key === 'oc_sk_noplan' ? 403 : 200
    if (status === 401) return json(res, 401, { type: 'error', error: { type: 'AuthError', message: 'Invalid API key.' } })
    if (status === 403) return json(res, 403, { type: 'error', error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' } })
    if (path === '/v1/usage') return json(res, 200, { rolling: { status: 'ok', percent: 1 }, weekly: { status: 'ok', percent: 1 }, monthly: { status: 'ok', percent: 1 } })
    if (path === '/v1/models') {
      return json(res, 200, { object: 'list', data: [
        { id: 'kimi-k3', type: 'chat', name: 'Kimi K3', description: 'Moonshot', capabilities: { reasoning: { supported: true, effort: ['max'] } }, go: { monthly_usage: { go: 15 } } },
        { id: 'beam-free', type: 'chat', name: 'Beam', description: 'free', go: { featured: true } },
        { id: 'text-embedding-3-small', type: 'embedding', name: 'Embedding', go: { monthly_usage: { go: 10 } } },
      ] })
    }
    s.inFlight++
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight)
    await new Promise((r) => setTimeout(r, s.delayMs))
    s.inFlight--
    if (path.startsWith('/anthropic/v1/messages')) return json(res, 200, { id: 'msg_1', type: 'message', role: 'assistant', model: JSON.parse(body).model, content: [{ type: 'text', text: 'pong' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    if (path.startsWith('/openai/v1/responses')) return json(res, 200, { id: 'resp_1', object: 'response', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'pong' }] }] })
    json(res, 404, { error: { message: 'no such path' } })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const real = globalThis.fetch
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return real(u.startsWith('https://opencode.ai/') ? url + u.slice('https://opencode.ai'.length) : input, init)
  }) as typeof fetch
  return Object.assign(s, { close: async () => { globalThis.fetch = real; server.closeAllConnections(); await new Promise((r) => server.close(r)) } })
}
