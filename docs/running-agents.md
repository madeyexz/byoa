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

- The events are the same for Claude Code and Codex. The schema is in the [API reference](api.md#events-one-schema-for-both-harnesses).
- `run` does not throw when a job fails. It gives `error` events (`code`: `signed-out`, `expired`, `no-plan`, `harness`, `sandbox` or `mcp`), and always ends with one `end` event (`ok`, `result`, `usage`). On `signed-out` or `expired`, show the sign-in again (for `plan: 'opencode-go'`, ask for a new key). On `no-plan`, tell the user that the key's workspace has no OpenCode Go plan.
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
| `sandboxPer: 'user'` (the default) | the user's one kept sandbox for that harness, paused between jobs | one; the others wait in line, in the order they came |
| a `sandboxKey` for each job | one kept sandbox for each key, such as a project or a conversation, each with its own lease | one for each key |
| `sandboxPer: 'job'` | a new sandbox, destroyed after the job | all of them |

```ts
agents.run(userId, { harness: 'claude', task, sandboxKey: projectId })  // one kept sandbox for each project
const agents = createAgents({ ...options, sandboxPer: 'job' })          // a new sandbox for each job; default 'user'
```

A job waits in line with no time limit. To make it fail after a time, set `createAgents({ waitMs })`, for example on a short-lived backend such as a Convex action. [Sandbox lifecycle](sandbox-lifecycle.md) shows each step of each mode, and what each provider does.

## Jobs at the same time

Your app chooses how one user's agents run. It can mix the three ways:

```ts
// 1. A queue: jobs of one sandbox run one after the other, in the order they came
agents.run(userId, { harness: 'claude', task, onWait: ({ for: what, ahead }) => show(`${ahead} jobs before yours (${what})`) })

// 2. Several messages to one agent, which reads them all and decides the order itself
agents.run(userId, { harness: 'codex', task: ['water the plants', 'call mom', 'plan the week'] })

// 3. Several sandboxes at once: a sandbox key for each agent (or sandboxPer: 'job')
const jobs = projects.map((p) => agents.run(userId, { harness: 'codex', task, sandboxKey: p.id }))  // read each stream; they run together
```

- **A queue.** `onWait` gets `{ for, ahead }` each time the number of jobs ahead changes. `for` is `'sandbox'` while the job waits for its sandbox, and `'login'` while it waits for the AI login.
- **Several messages.** byoa gives the agent all of them in one task, with a line that tells it to read them all first and then decide the order. It is one job, in one sandbox.
- **Several sandboxes.** Jobs of one user in different sandboxes run at the same time with one sign-in, for Claude Code and Codex. They share the login while it is not due for a refresh. One risk stays, and `storedLogin({ parallel: false })` turns sharing off: see [AI login](ai-login.md#jobs-at-the-same-time-the-shared-login).

## Models and effort

`run(userId, { harness, task, model, effort })` runs the harness with that model and effort, with each CLI's own flags: Claude Code's `--model` (an alias such as `opus`, or a full name) and `--effort` (`low` to `max`), Codex's `-m` and `model_reasoning_effort`. Without them, a job gets the harness's default from `createAgents({ models })`, else the CLI's own.

```ts
const agents = createAgents({ ...options, models: { claude: { model: 'opus' }, codex: { effort: 'high' } } })

const models = await agents.listModels(userId, 'codex')   // [{ id: 'gpt-6.2-sol', isDefault: true, efforts: ['low', ...] }, ...]
agents.run(userId, { harness: 'codex', task, model: models[0].id, effort: 'high' })
```

`agents.listModels(userId, harness)` lists the models that the user's plan can use, as the CLI lists them with the user's login: `[{ id, name, description, isDefault, efforts, resolved? }]`. `id` is what `model` takes, and `efforts` what `effort` takes; `resolved` (Claude Code) is the full name of an alias. Each call starts a sandbox, so keep the list for a while. It throws `LoginError` when the harness is not signed in. With `session`, `s.args` has the flags for the job's model and effort, for your own command line.

A job on the user's OpenCode Go key (beta) passes `plan: 'opencode-go'` and a Go model; `listModels(userId, 'opencode-go')` lists them with no sandbox. See [AI login](ai-login.md#opencode-go-a-key-not-a-sign-in-beta).

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
