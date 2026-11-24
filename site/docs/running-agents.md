# Running agents

Your app runs a job with `agents.run`. byoa takes the user's sandbox, loads the user's setup, runs the user's own harness on the user's own plan, and streams its events. For a program of your own around the harness, use `agents.session`; for a harness outside byoa's sandboxes, `agents.jobToken`.

## Run a job and stream its events

```ts
for await (const ev of agents.run(userId, {
  harness: 'claude',                   // 'claude' | 'codex' | 'fake'
  task,                                // the user's request
  mcp: ['notion', 'todos'],            // the servers this job gets; default none
  setup: { agentsMd, skills },         // AGENTS.md (and CLAUDE.md for Claude Code); skills: [{ name, files: { 'SKILL.md': '...' } }]
})) {
  // ev.type: 'start' | 'text' | 'tool_call' | 'tool_result' | 'permission' | 'error' | 'end'
}
```

- The events are the same for Claude Code and Codex. The schema is in the [API reference](https://byoa.rippling.computer/docs/api.md#events-one-schema-for-both-harnesses).
- `run` does not throw when a job fails. It gives `error` events (`code`: `signed-out`, `expired`, `harness`, `sandbox` or `mcp`), and always ends with one `end` event (`ok`, `result`, `usage`). On `signed-out` or `expired`, show the sign-in again.
- byoa writes skills where each harness reads them (`.claude/skills/`, `.agents/skills/`), AGENTS.md (and CLAUDE.md for Claude Code) from one source, and the MCP config in each harness's own format. `plugins` adds the skills and MCP servers of an Agent Plugins package (`readPlugin(readPluginDir(dir))`).
- byoa installs the pinned version of each harness in each sandbox, so a new pin reaches every user at their next job.
- If the client goes away, stop the loop (or call `return()` on the generator). byoa still ends the job token, takes the login out, and pauses or destroys the sandbox.

## What the agent may do

By default (`access: 'full'`), the agent has every tool of its harness, with no approval: a shell, file changes and the network. This is for a sandbox that is the job's alone. An app whose agent must only use its MCP tools, such as a to-do list or a mail client, gives the job `access: 'read-only'`:

```ts
agents.run(userId, { harness: 'codex', task, mcp: ['mail'], setup: { skills }, access: 'read-only' })
```

The agent can then call the job's MCP tools and read files, so the harness can still read its skills and AGENTS.md. It cannot change a file or reach the network by itself. byoa only sets each CLI's own options: Codex runs in its own `read-only` sandbox, and Claude Code gets only its tools that read; each tool it refuses is a `permission` event. `read-only` does not hide files: the agent can read each file that its user can read. Use it always with `localSandbox()` on a user's own computer, where the sandbox isolates nothing.

## Sandbox modes

| | Where a job runs | Jobs of one user and harness at the same time |
|---|---|---|
| `sandboxPer: 'user'` (the default) | the user's one kept sandbox for that harness, paused between jobs | one; another job waits (`waitMs`, default 10 minutes) |
| a `sandboxKey` for each job | one kept sandbox for each key, such as a project or a conversation, each with its own lease | one for each key, but see the AI login below |
| `sandboxPer: 'job'` | a new sandbox, destroyed after the job | see the AI login below |

```ts
agents.run(userId, { harness: 'claude', task, sandboxKey: projectId })  // one kept sandbox for each project
const agents = createAgents({ ...options, sandboxPer: 'job' })          // a new sandbox for each job; default 'user'
```

[Sandbox lifecycle](https://byoa.rippling.computer/docs/sandbox-lifecycle.md) shows each step of each mode, and what each provider does.

## Jobs at the same time

With the default stored login, one job of a user and harness holds the AI login at a time, and another job waits for it. So a user's Claude Code or Codex jobs run one after the other in every mode, also with different sandbox keys. Only the fake harness runs them at the same time.

For many Codex agents of one user at the same time, each on its own machine, with one sign-in, turn on the shared login and give each agent its own sandbox:

```ts
import { createAgents, storedLogin } from '@madeyexz/byoa'

const agents = createAgents({ ...options, login: storedLogin({ parallel: true }) })
await Promise.all(tasks.map((task, i) => drain(agents.run(userId, { harness: 'codex', task, sandboxKey: `agent-${i}` }))))
```

(`drain` is your own function that reads each job's events.) The jobs then share the login while it is not due for a refresh. One risk stays, and Claude Code jobs of one user always run one at a time: see [AI login](https://byoa.rippling.computer/docs/ai-login.md#codex-jobs-at-the-same-time-the-shared-login).

## A program of your own around the harness

An app that runs its own program around the unmodified harness (for example its own server, which starts `claude` or `codex` itself) opens the job with `agents.session` instead. It gets the same sandbox, login, pinned harness and job token, and runs its own command:

```ts
const s = await agents.session(userId, { harness: 'claude', mcp: ['notion'] })
try {
  // s.bin: the pinned claude binary; s.env: its login folder, the job token and its MCP start timeout; s.mcp: [{ name, url }] at the proxy
  await s.sandbox.run(`my-server --claude ${s.bin}`, { cwd: s.work, env: s.env })
} finally { await s.close() }  // ends the job token, takes the AI login out, and pauses the user's sandbox
```

`session` throws `LoginError` when the harness is not signed in, and `ProxyError` when the sandbox cannot reach the proxy.

## A harness outside byoa's sandboxes

A program outside byoa's sandboxes, such as a harness on the user's own computer, gets a job token with no sandbox: `const t = await agents.jobToken(userId, { mcp: ['notion'] })` gives `t.token` and `t.mcp` (the proxy URLs), with the same rules as a job's token, until `t.close()`. Send `t.token` as `Authorization: Bearer` to each `t.mcp[].url`.
