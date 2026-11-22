// Helpers for Node backends: read a plugin folder, and serve the MCP proxy with node:http (or Express).
import { readdirSync, readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, relative, sep } from 'node:path'
import { Readable } from 'node:stream'

/** All files of a folder, as paths relative to it → text. For readPlugin. */
export function readPluginDir(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue
    const full = join(e.parentPath, e.name)
    files[relative(dir, full).split(sep).join('/')] = readFileSync(full, 'utf8')
  }
  return files
}

/** A node:http request listener for a fetch handler such as `agents.proxy`. */
export function toNodeListener(handler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
      const ac = new AbortController()
      res.on('close', () => ac.abort())
      const r = await handler(new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, {
        method: req.method, headers, signal: ac.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } : {}),
      } as RequestInit))
      res.writeHead(r.status, Object.fromEntries(r.headers))
      if (r.body) Readable.fromWeb(r.body as any).on('error', () => res.destroy()).pipe(res)
      else res.end()
    } catch {
      if (!res.headersSent) res.writeHead(500)
      res.end()
    }
  }
}
