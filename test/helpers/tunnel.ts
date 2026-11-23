// A Cloudflare quick tunnel to a local port, so a real sandbox reaches the proxy that a test or the benchmark serves.
// Needs `cloudflared` on PATH, or BYOA_CLOUDFLARED.
import { spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'

/** A Cloudflare quick tunnel to the local port: its public https URL. */
export async function tunnel(port: number) {
  const p = spawn(process.env.BYOA_CLOUDFLARED ?? 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  const url = await new Promise<string>((res, rej) => {
    let log = ''
    const t = setTimeout(() => rej(new Error(`cloudflared gave no URL: ${log.slice(-500)}`)), 60_000)
    p.on('error', (e) => { clearTimeout(t); rej(e) })
    p.stderr.setEncoding('utf8').on('data', (d: string) => {
      log += d
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)
      if (m) { clearTimeout(t); res(m[0]) }
    })
  })
  return { url, close: () => { p.kill() } }
}

/** Waits until `proxyUrl` reaches the proxy (it refuses a request with no job token), and returns a line for a
 *  sandbox's /etc/hosts with the IPv4 address of its host. In E2B sandboxes about one lookup of a new tunnel's name in
 *  four fails (no answer, or an IPv6 address the sandbox has no route to), and the fake harness does not retry. */
export async function reachProxy(proxyUrl: string): Promise<string> {
  for (let i = 0; ; i++) {
    const r = await fetch(`${proxyUrl}/notes`, { method: 'POST' }).catch(() => undefined)
    if (r?.status === 401) break
    if (i === 60) throw new Error(`${proxyUrl} does not reach the proxy (${r?.status})`)
    await new Promise((r) => setTimeout(r, 2000))
  }
  const host = new URL(proxyUrl).hostname
  for (let i = 0; ; i++) {
    try { return `${(await lookup(host, { family: 4 })).address} ${host}` } catch (e) { if (i === 30) throw e; await new Promise((r) => setTimeout(r, 2000)) }
  }
}
