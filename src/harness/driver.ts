// Drivers (R5.10): a running job takes more messages, in each CLI's own protocol. byoa runs the harness under a small
// Node script that it writes into the sandbox:
//
//   node <driver> <inbox> <setup JSON> <cli> <args...>
//
// The driver starts the unmodified CLI, gives it the task and each later message, and prints the CLI's output, one JSON
// object per line, for the harness's event reader. byoa writes message n as `<inbox>/<n>.json` (a JSON string),
// complete once `<inbox>/<n>.ok` is there, in order from 0, and `<inbox>/end` once the job has its last answer; the
// driver then ends the CLI. It exits with the CLI. A line `{"byoa":"failed","message":...}` says that the driver could
// not start the job (a refused resume, a login the CLI does not take); each reader reads it as the job's end.
//
// This prelude is the part every driver shares; a harness adds its protocol after it (claude.ts, codex.ts, grok.ts).

export const DRIVER_PRELUDE = String.raw`
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
const [dir, setupArg, bin, ...args] = process.argv.slice(2)
const setup = JSON.parse(setupArg)
const cli = spawn(bin, args, { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...setup.env } })
cli.on('error', (e) => { console.error(e.message); process.exit(127) })
cli.on('exit', (code) => process.exit(code ?? 137))
cli.stdin.on('error', () => {})
const print = (o) => process.stdout.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n')
/** The CLI's output, one line at a time. */
const onLine = (f) => {
  let b = ''
  cli.stdout.setEncoding('utf8').on('data', (c) => {
    b += c
    for (let k; (k = b.indexOf('\n')) >= 0;) { const l = b.slice(0, k); b = b.slice(k + 1); if (l.trim()) f(l) }
  })
}
/** Reads the inbox: each message, in order, to message(text); then end(), once. */
const inbox = (message, end) => {
  let n = 0
  const tick = () => {
    while (existsSync(dir + '/' + n + '.ok')) message(JSON.parse(readFileSync(dir + '/' + n++ + '.json', 'utf8')))
    if (existsSync(dir + '/end')) return end()
    setTimeout(tick, 200)
  }
  tick()
}
/** JSON-RPC on the CLI's stdin and stdout. onMessage gets each notification and request of the CLI, and its line. */
const rpc = (onMessage) => {
  let id = 0
  const calls = new Map()
  const send = (o) => cli.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
  onLine((l) => {
    let m
    try { m = JSON.parse(l) } catch { return }
    const c = m.method === undefined && calls.get(m.id)
    if (!c) return onMessage(m, l)
    calls.delete(m.id)
    if (m.error) c.reject(new Error(m.error.message + (m.error.data ? ': ' + JSON.stringify(m.error.data) : '')))
    else c.resolve(m.result)
  })
  return {
    call: (method, params) => new Promise((resolve, reject) => { calls.set(++id, { resolve, reject }); send({ id, method, params }) }),
    notify: (method, params) => send({ method, ...(params ? { params } : {}) }),
    answer: (id, result) => send({ id, result }),
    refuse: (id, message) => send({ id, error: { code: -32601, message } }),
  }
}
/** The job cannot go on: one line for the reader, then the CLI ends. */
const fail = (e) => { print({ byoa: 'failed', message: String(e?.message ?? e) }); cli.kill('SIGKILL') }
/** Ends the CLI: its input first, then a kill if it has not exited 5 s later. */
const close = () => { cli.stdin.end(); setTimeout(() => cli.kill('SIGKILL'), 5000).unref() }
`

/** A driver: the prelude and a harness's protocol. */
export const driver = (protocol: string) => DRIVER_PRELUDE + protocol

/** The driver's line that says the job could not start, else undefined. */
export const driverFailure = (ev: any): string | undefined => ev?.byoa === 'failed' ? String(ev.message ?? 'the job did not start') : undefined
