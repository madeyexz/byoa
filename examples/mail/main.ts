// Runs the mail app on Node: `node main.ts`. The settings are in README.md.
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import type { RunHarness, SandboxProvider } from '@madeyexz/byoa'
import { toNodeListener } from '@madeyexz/byoa/node'
import { mailApp } from './app.ts'

const env = process.env
const port = Number(env.PORT ?? 3000)
const publicUrl = env.PUBLIC_URL ?? `http://127.0.0.1:${port}`
for (const k of ['BYOA_KEY', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) if (!env[k]) throw new Error(`Set ${k} (README.md, Settings)`)
mkdirSync('.data', { recursive: true })

async function sandbox(): Promise<SandboxProvider> {
  if (env.SANDBOX === 'e2b') return (await import('@madeyexz/byoa/sandbox/e2b')).e2b()
  if (env.SANDBOX === 'daytona') return (await import('@madeyexz/byoa/sandbox/daytona')).daytona()
  if (env.SANDBOX === 'instabox') return (await import('@madeyexz/byoa/sandbox/instabox')).instabox({ snapshot: env.INSTABOX_SNAPSHOT })
  // Folders on this computer. It isolates nothing: only for development on your own computer.
  return (await import('@madeyexz/byoa/sandbox/local')).localSandbox({ root: `${process.cwd()}/.data/sandboxes` })
}

/** A Cloudflare quick tunnel to this server, so a remote sandbox reaches byoa's proxy: its https URL. */
function tunnel(): Promise<string> {
  const p = spawn(env.CLOUDFLARED ?? 'cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'ignore', 'pipe'] })
  process.on('exit', () => p.kill())
  return new Promise((res, rej) => {
    let log = ''
    p.on('error', rej)
    p.stderr.setEncoding('utf8').on('data', (d: string) => {
      log += d
      const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)
      if (m) res(m[0])
    })
  })
}

const proxyUrl = env.PROXY_URL ?? (env.TUNNEL === '1' ? `${await tunnel()}/byoa/mcp` : undefined)
const app = mailApp({
  db: new DatabaseSync(env.DB ?? '.data/mail.db'),
  sandbox: await sandbox(),
  publicUrl,
  proxyUrl,
  encryptionKey: env.BYOA_KEY!,
  google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! },
  archiveSpam: env.ARCHIVE_SPAM === '1',
  max: env.MAX ? Number(env.MAX) : undefined,
})

// A refresh token from elsewhere (such as Google's OAuth Playground), for the user GMAIL_USER.
if (env.GMAIL_REFRESH_TOKEN && app.mail.state(env.GMAIL_USER ?? 'me') === 'not-connected') {
  app.mail.connect(env.GMAIL_USER ?? 'me', env.GMAIL_REFRESH_TOKEN)
  await app.mail.profile(env.GMAIL_USER ?? 'me').catch((e) => console.error(`Gmail: ${e.message}`))
}

// Jobs with no one at the page: every TRIAGE_EVERY_MIN minutes, triage each connected user's new mail.
if (Number(env.TRIAGE_EVERY_MIN) > 0) {
  const harness = (env.HARNESS ?? 'codex') as RunHarness
  setInterval(async () => {
    for (const user of app.mail.users()) {
      if (await app.agents.loginState(user, harness as 'codex') !== 'signed-in') continue
      for await (const e of app.triage(user, harness)) if (e.type === 'end' || e.type === 'error') console.log(`triage ${user}:`, JSON.stringify(e))
    }
  }, Number(env.TRIAGE_EVERY_MIN) * 60_000)
}

createServer(toNodeListener(app.handler)).listen(port, () => console.log(`The mail app is at ${publicUrl}${proxyUrl ? `; byoa's proxy at ${proxyUrl}` : ''}`))
