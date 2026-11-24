// Runs the to-do app on Node: `node main.ts`. The settings are in README.md.
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import type { SandboxProvider } from '@madeyexz/byoa'
import { toNodeListener } from '@madeyexz/byoa/node'
import { todoApp } from './app.ts'

const env = process.env
const port = Number(env.PORT ?? 3000)
const publicUrl = env.PUBLIC_URL ?? `http://127.0.0.1:${port}`
if (!env.BYOA_KEY) throw new Error('Set BYOA_KEY to 32 random bytes as base64: openssl rand -base64 32')
mkdirSync('.data', { recursive: true })

async function sandbox(): Promise<SandboxProvider> {
  if (env.SANDBOX === 'e2b') return (await import('@madeyexz/byoa/sandbox/e2b')).e2b()
  if (env.SANDBOX === 'daytona') return (await import('@madeyexz/byoa/sandbox/daytona')).daytona()
  // Folders on this computer. It isolates nothing: only for development on your own computer.
  return (await import('@madeyexz/byoa/sandbox/local')).localSandbox({ root: `${process.cwd()}/.data/sandboxes` })
}

const handler = todoApp({
  db: new DatabaseSync(env.DB ?? '.data/todo.db'),
  sandbox: await sandbox(),
  publicUrl,
  localUrl: `http://127.0.0.1:${port}`,
  encryptionKey: env.BYOA_KEY,
  fake: env.FAKE === '1',
})
createServer(toNodeListener(handler)).listen(port, () => console.log(`The to-do app is at ${publicUrl}`))
