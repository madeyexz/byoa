// V21: conversations (R5.9) and steering (R5.10) with real logins on E2B. It needs a person to sign in, so it is a
// script in steps, not a test. The store is a file, so the steps can run apart; the login in it is encrypted with a
// key in the same folder (V21_DIR, default /tmp/byoa-v21). Each step needs E2B_API_KEY.
//
//   node scripts/v21.ts login claude|codex|grok   the sign-in: it prints the page (and the code) to open. For Claude
//                                                 Code, write the code that the page shows into $V21_DIR/claude.code.
//                                                 It checks in until the sign-in ends, at most 20 minutes.
//   node scripts/v21.ts check [harness...]        for each signed-in harness: a conversation of three jobs, the third
//                                                 after the conversation's sandbox was destroyed at E2B; and a job
//                                                 that takes a second message while its turn runs (steering)
//   node scripts/v21.ts cleanup                   signs out of each harness and deletes the user's sandboxes,
//                                                 conversations and the folder
//
// BYOA_E2B_TEMPLATE: the E2B template (default `byoa`; any template with Node 20 works, byoa installs the harness).
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createAgents, type AgentEvent, type HarnessName, type Store } from '../src/index.ts'
import { e2b } from '../src/sandbox/e2b.ts'

const DIR = process.env.V21_DIR ?? '/tmp/byoa-v21'
const USER = 'v21-user'
const HARNESSES: HarnessName[] = ['claude', 'codex', 'grok']
mkdirSync(DIR, { recursive: true, mode: 0o700 })

/** A store in one JSON file, with versions for compare-and-set. */
function fileStore(path: string): Store {
  type Row = { value: string; version: string }
  const read = (): Record<string, Row> => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  const write = (d: Record<string, Row>) => writeFileSync(path, JSON.stringify(d), { mode: 0o600 })
  return {
    async get(k) { return read()[k] ?? null },
    async put(k, value) { const d = read(); d[k] = { value, version: randomUUID() }; write(d) },
    async delete(k) { const d = read(); delete d[k]; write(d) },
    async cas(k, version, value) {
      const d = read()
      if ((d[k]?.version ?? null) !== version) return false
      d[k] = { value, version: randomUUID() }; write(d); return true
    },
  }
}

const keyFile = join(DIR, 'key')
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 })
const agents = createAgents({
  app: 'byoa-v21', sandbox: e2b({ template: process.env.BYOA_E2B_TEMPLATE ?? 'byoa' }), store: fileStore(join(DIR, 'store.json')),
  encryptionKey: readFileSync(keyFile, 'utf8'), proxyUrl: 'http://127.0.0.1:9/byoa/mcp',
  oauth: { redirectUrl: 'http://127.0.0.1:9/callback', clientName: 'byoa V21' },
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const show = (e: AgentEvent) => e.type === 'text' ? `text: ${e.text.slice(0, 200)}` : JSON.stringify(e).slice(0, 300)

async function job(h: HarnessName, conversation: string, task: string) {
  const ev: AgentEvent[] = []
  for await (const e of agents.run(USER, { harness: h, task, conversation })) { ev.push(e); console.log(`  ${h}: ${show(e)}`) }
  const end = ev.at(-1) as Extract<AgentEvent, { type: 'end' }>
  return { ev, end, start: ev.find((e) => e.type === 'start') as Extract<AgentEvent, { type: 'start' }> | undefined, errors: ev.filter((e) => e.type === 'error') }
}

async function check(h: HarnessName) {
  if (await agents.loginState(USER, h) !== 'signed-in') { console.log(`${h}: not signed in; run login ${h} first`); return false }
  const word = `byoa-${randomBytes(3).toString('hex')}`
  const conv = `v21-${h}-${randomBytes(3).toString('hex')}`
  const fails: string[] = []
  const expect = (ok: boolean, what: string) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${h}: ${what}`); if (!ok) fails.push(what) }

  const one = await job(h, conv, `Remember this word for later: ${word}. Also write it into the file note.txt in the current folder. Then reply with only OK.`)
  expect(one.end.ok && one.start?.resumed === false && !!one.end.session, `job 1 ends well, new session ${one.end.session}`)
  const two = await job(h, conv, 'What word did I ask you to remember? Reply with only that word. Then say whether the file note.txt is still in the current folder (yes or no).')
  expect(two.end.ok && two.start?.resumed === true && two.end.session === one.end.session, 'job 2 resumes the same session')
  expect(!!two.end.result?.includes(word), `job 2 remembers the word (${JSON.stringify(two.end.result)})`)
  expect(/\byes\b/i.test(two.end.result ?? ''), 'job 2 finds note.txt in ~/work')

  // the provider loses the sandbox: the next job gets a new one, with the transcript from the store
  await agents.deleteSandbox(USER, { sandboxKey: conv })
  const three = await job(h, conv, 'One more time: what word did I ask you to remember? Reply with only that word.')
  expect(three.end.ok && three.start?.resumed === true && !three.errors.some((e) => e.code === 'conversation'), 'job 3, in a new sandbox, resumes from the stored transcript')
  expect(!!three.end.result?.includes(word), `job 3 remembers the word (${JSON.stringify(three.end.result)})`)

  {
    // R5.10: a second message while the job runs; the shell command keeps the turn running when it comes
    const r = agents.run(USER, { harness: h, task: 'Run the shell command `sleep 15`, then count from 1 to 5, one number on each line, then stop.', conversation: conv })
    const ev: AgentEvent[] = []
    let sent: boolean | undefined
    for await (const e of r) {
      ev.push(e); console.log(`  ${h}: ${show(e)}`)
      if (e.type === 'start') sent = await r.send(`Now also reply with the word ${word.toUpperCase()} in capitals.`)
    }
    const end = ev.at(-1) as Extract<AgentEvent, { type: 'end' }>
    const turns = ev.filter((e) => e.type === 'turn').length
    expect(sent === true && end.ok, `steering: send is taken and the job ends well (${turns} turn event(s) before the end)`)
    const all = ev.flatMap((e) => e.type === 'text' ? [e.text] : e.type === 'turn' || e.type === 'end' ? [e.result ?? ''] : []).join('\n')
    expect(all.includes(word.toUpperCase()), 'steering: the agent answered the second message in the same job')
    expect(await r.send('too late') === false, 'steering: send after the end is refused')
  }
  await agents.deleteConversation(USER, conv)
  console.log(fails.length ? `${h}: ${fails.length} check(s) failed` : `${h}: all checks passed`)
  return !fails.length
}

const [step, ...rest] = process.argv.slice(2)
if (step === 'login') {
  const h = rest[0] as HarnessName
  if (!HARNESSES.includes(h)) throw new Error(`login ${HARNESSES.join('|')}`)
  const s = await agents.connectLogin(USER, h)
  console.log(JSON.stringify(s))
  const codeFile = join(DIR, 'claude.code')
  rmSync(codeFile, { force: true })
  const until = Date.now() + 20 * 60_000
  for (;;) {
    const code = h === 'claude' && existsSync(codeFile) ? readFileSync(codeFile, 'utf8').trim() : undefined
    if (code) rmSync(codeFile)
    const r = await agents.finishLogin(USER, h, code ? { code } : { waitMs: 15_000 })
    if (r.state !== 'pending') { console.log(JSON.stringify(r)); break }
    if (Date.now() > until) { await agents.cancelLogin(USER, h); console.log('timed out; the sign-in was cancelled'); break }
    if (h === 'claude') await sleep(3_000)
  }
} else if (step === 'check') {
  const hs = (rest.length ? rest : HARNESSES) as HarnessName[]
  const ok = []
  for (const h of hs) ok.push(await check(h))
  process.exitCode = ok.every(Boolean) ? 0 : 1
} else if (step === 'cleanup') {
  await agents.deleteConversation(USER)
  for (const h of HARNESSES) { await agents.signOut(USER, h); console.log(`${h}: ${await agents.loginState(USER, h)}`) }
  await agents.deleteSandbox(USER)
  rmSync(DIR, { recursive: true, force: true })
  console.log('signed out; sandboxes and the folder deleted')
} else {
  console.log('node scripts/v21.ts login claude|codex|grok | check [harness...] | cleanup')
}
