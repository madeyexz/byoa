// The app's own tools (R2.7): functions in the app's backend that a job's harness calls as the tools of an MCP server.
// The app gives them to createAgents; the proxy (proxy.ts) serves each group at `<proxyUrl>/<name>`, as it serves a
// connected MCP server, and checks the job token first. So the app writes no MCP server, keeps no token for it, and
// connects nothing for each user: the job token says which user the call is for.
// This is the small part of MCP that a tool server needs (Streamable HTTP with JSON answers, no session): initialize,
// ping, tools/list and tools/call. It uses only `fetch` types, so it runs where the proxy runs.

export interface AppTool {
  description?: string
  /** The arguments, as a JSON Schema of an object. The harness shows it to the model. byoa does not check the
   *  arguments against it: check them in `run`. Default: no arguments. */
  input?: Record<string, unknown>
  /** Runs in the app's backend for the user of the job. What it returns goes to the agent: a string as it is, and
   *  every other value as JSON. When it throws, the agent gets the error's message as a failed call. */
  run(args: any, ctx: { user: string; job: string }): unknown
}

/** MCP server name → tool name → tool. A job gets a group by its name in `mcp`, as it gets a connected server. */
export type AppTools = Record<string, Record<string, AppTool>>

/** The MCP versions this server answers; a client that asks for another one gets the newest. */
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** Throws when a tool has a name a harness does not take, or no `run`. */
export function checkTools(server: string, tools: Record<string, AppTool>) {
  for (const [name, t] of Object.entries(tools)) {
    if (!TOOL_NAME.test(name)) throw new Error(`byoa: tools.${server}: tool name ${JSON.stringify(name)}: letters, digits, _ and -, at most 64`)
    if (typeof t?.run !== 'function') throw new Error(`byoa: tools.${server}.${name} has no run function`)
  }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** One MCP request to the app's tools of one server, for the user of a checked job token. */
export async function serveTools(server: string, tools: Record<string, AppTool>, req: Request, ctx: { user: string; job: string }): Promise<Response> {
  // no stream from the server to the client, and no session to end
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
  let m: any
  try { m = await req.json() } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'the request is not JSON' } }, 400) }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'one JSON-RPC message for each request' } }, 400)
  // a notification, or the client's answer to a request: nothing to send back
  if (m.id === undefined || m.id === null || typeof m.method !== 'string') return new Response(null, { status: 202 })
  const result = (r: unknown) => json({ jsonrpc: '2.0', id: m.id, result: r })
  const error = (code: number, message: string) => json({ jsonrpc: '2.0', id: m.id, error: { code, message } })
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion
      return result({ protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: server, version: '1' } })
    }
    case 'ping': return result({})
    case 'tools/list': return result({
      tools: Object.entries(tools).map(([name, t]) => ({ name, ...(t.description ? { description: t.description } : {}), inputSchema: t.input ?? { type: 'object', properties: {} } })),
    })
    case 'tools/call': {
      const name = m.params?.name
      if (typeof name !== 'string' || !own(tools, name)) return error(-32602, `${server} has no tool ${JSON.stringify(name)}`)
      try {
        const out = await tools[name]!.run(m.params?.arguments ?? {}, ctx)
        return result({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out ?? null) }] })
      } catch (e) {
        return result({ content: [{ type: 'text', text: (e as Error)?.message || String(e) }], isError: true })
      }
    }
    default: return error(-32601, `no such method: ${m.method}`)
  }
}
