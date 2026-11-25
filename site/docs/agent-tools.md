# Give your agent tools

The agent in each job is the user's own Claude Code, Codex or Grok Build. You decide what it can do in that job: which tools it can call, what it knows, and what it may do in its sandbox. This page shows each way, and which one to choose.

| The agent needs | Give it | Where it runs | Who connects it |
|---|---|---|---|
| your app's own data and actions (to-dos, mail, documents) | [your app's tools](#your-apps-own-tools), as functions in `createAgents({ tools })` | in your backend | nobody: the job token says which user |
| a service where the user has an account (Notion, Gmail) | [the user's MCP server](#the-users-mcp-servers), with `connectMcp` once | at the service | the user, one time |
| to know how to do a task, or your app's rules | [skills and AGENTS.md](#skills-and-agentsmd), in `setup` | files in the sandbox | nobody |
| skills and MCP servers as one package | [a plugin](#plugins) (Agent Plugins 1.0), in `plugins` | files, and the user's servers | the user, for each server |
| a shell, files, packages and the network | [the sandbox itself](#what-the-agent-can-do-in-its-sandbox), with `access: 'full'` | in the sandbox | nobody |

Name the tools of each job in its `mcp`. A job gets only the servers that you name, and none by default.

## Which one to choose

Diagram: Which way gives the agent an ability

1. Question: Is it your app's own data or action? If no: go on to step 2.
   - If yes: Your app's own tools. This is the end. `tools: { todos: { add_todo: { description, input, run } } }`, and `mcp: ['todos']` in the job.
2. Question: Does the user have an account at a service with an MCP server? If no: go on to step 3.
   - If yes: The user's MCP server. This is the end. `connectMcp(user, url, { name })` once, and `mcp: ['notion']` in each job.
3. Question: Is it knowledge, a how-to or a rule, not an action? If no: go on to step 4.
   - If yes: A skill or AGENTS.md. This is the end. `setup: { agentsMd, skills }`. The harness reads them from the job folder.
4. Question: Does it need a shell, files, packages or the open network? If no: go on to step 5.
   - If yes: The sandbox, with access: 'full'. This is the end. The default. The agent installs and runs what it needs in its own sandbox.
5. Write it as one of your app's tools. This is the end. An API that your backend can call becomes a function in `tools`. The agent then calls it through the proxy, and your backend keeps every key.

Keep secrets out of the sandbox. A key that a tool needs stays in your backend, in the tool's `run` or in the user's grant. Never put a token in `setup`, the task, the environment or a file: the agent can read everything in its sandbox.

## Your app's own tools

Give your app's tools to `createAgents` as functions: MCP server name → tool name → `{ description, input, run }`. A job gets a group by its name in `mcp`, as it gets a connected server. You write no MCP server, keep no token for it, and connect nothing for each user.

```ts
const agents = createAgents({
  ...options,
  tools: {
    todos: {
      add_todo: {
        description: 'Add one to-do.',
        input: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        run: ({ title }, { user }) => db.addTodo(user, String(title)),
      },
      list_todos: { description: "List the user's to-dos.", run: (_args, { user }) => db.todos(user) },
    },
  },
})
agents.run(userId, { harness: 'codex', task, mcp: ['todos'] })
```

Diagram: A call to one of your app's tools

1. The agent calls todos.add_todo. The harness sends an MCP `tools/call` to `<proxyUrl>/todos`, with the job token.
2. Question: Is the job token good, and did the job get todos? If yes: go on to step 3.
   - If no: Refuse the call. This is the end. The job ended, or its mcp did not name todos.
3. run(args, { user, job }) in your backend. `user` is the job's user, from the token. Never take the user from the arguments.
4. Question: Did run throw? If no: go on to step 5.
   - If yes: The agent gets a failed call. This is the end. With the error's message. The agent can try again or tell the user.
5. The agent gets the result. This is the end. A string as it is, and any other value as JSON.

- `input` is the JSON Schema of the arguments, which the harness shows to the model. byoa does not check the arguments against it: check them in `run`.
- Write a `description` that says when to use the tool. The model reads it to choose.
- Names: a server is lower-case letters, digits and `-`, at most 32; a tool is letters, digits, `_` and `-`, at most 64.
- Give a job only the groups it needs. A to-do job gets `todos`, not your billing tools.

## The user's MCP servers

The user connects a service one time, and each job that you give it can use it. The real token stays in your database, and the proxy adds it to each call. [MCP tools and the proxy](https://byoa.rippling.computer/docs/mcp.md) has the sign-in routes and the details.

```ts
const c = await agents.connectMcp(userId, 'https://mcp.notion.com/mcp', { name: 'notion' })
if (!c.connected) return Response.json({ signInUrl: c.signInUrl })  // the browser comes back to your redirectUrl route
agents.run(userId, { harness: 'claude', task, mcp: ['notion', 'todos'] })
```

Diagram: A call to the user's MCP server

1. The agent calls notion.search. To `<proxyUrl>/notion`, with the job token. The sandbox has no Notion token.
2. Question: Is the job token good, and did the job get notion? If yes: go on to step 3.
   - If no: Refuse the call. This is the end.
3. Take the user's grant. From your database, decrypted in your backend. byoa refreshes it first when it is due, with one refresh owner.
4. Send the call on to Notion's MCP server. This is the end. With the real token. The answer goes back to the agent; the token does not.

A server in `mcp` that the user has not connected gives an `error` event with code `mcp`, and the job runs without it. Before the harness starts, byoa checks from the sandbox that each server answers through the proxy ([When the proxy is down](https://byoa.rippling.computer/docs/mcp.md#when-the-proxy-is-down)).

## Skills and AGENTS.md

A skill teaches the agent how to do one kind of task, in the [Agent Skills](https://agentskills.io) format: a folder with a `SKILL.md` and any files it needs. AGENTS.md has the rules for every task of the job, such as your app's voice or what the agent must not do.

```ts
agents.run(userId, {
  harness: 'claude', task, mcp: ['todos'],
  setup: {
    agentsMd: 'You are the to-do assistant of Acme. Change only the to-dos that the user asks about.',
    skills: [{ name: 'weekly-review', files: { 'SKILL.md': weeklyReviewSkill } }],
  },
})
```

byoa writes them into a new job folder, where each harness reads them:

```text
~/work                          the job folder, new for each job
├── AGENTS.md                   setup.agentsMd
├── CLAUDE.md                   the same text, for Claude Code
├── .claude/skills/<name>/      the skills, for Claude Code
├── .agents/skills/<name>/      the skills, for Codex and Grok Build
├── .codex/config.toml          Codex's MCP config: each server at the proxy, with the job token
├── .grok/config.toml           Grok Build's MCP config: the same (it reads the folder with --trust)
└── .byoa/
    ├── mcp.json                Claude Code's MCP config: the same
    └── task.md                 the task
```

## Plugins

A plugin in the Agent Plugins 1.0 format is a folder with `plugin.json`, `skills/<name>/` and `mcp.json`. Read it with `readPlugin(readPluginDir(dir))` (`readPluginDir` from `@madeyexz/byoa/node`), and give it to a job in `plugins`:

```ts
import { readPlugin } from '@madeyexz/byoa'
import { readPluginDir } from '@madeyexz/byoa/node'

const plugin = readPlugin(readPluginDir('./plugins/research'))
agents.run(userId, { harness: 'codex', task, plugins: [plugin] })
```

- The job gets the plugin's skills, and each of its MCP servers through the user's grant of the same name. So the user connects each server with `connectMcp` under that name; byoa never gives the plugin's URL to the harness, only the proxy's.
- Only Streamable HTTP servers load. A stdio server would run inside the sandbox with no proxy, so byoa skips it and lists it in `plugin.skipped`.

## What the agent can do in its sandbox

With `access: 'full'` (the default), the agent has every tool of its harness, with no approval: a shell, file changes and the network. So it can install a package, run a script, clone a repository or call a public API, in a sandbox that is the job's alone.

- **Files stay in a kept sandbox.** With the default `sandboxPer: 'user'`, files that the agent writes outside `~/work` are there in the user's next job. The job folder `~/work` is new each time. With `sandboxPer: 'job'`, nothing stays. See [Sandbox lifecycle](https://byoa.rippling.computer/docs/sandbox-lifecycle.md).
- **Results come back as events.** The agent's answer is the `end` event's `result`, and its tool calls are `tool_call` and `tool_result` events. To get a file out, give the agent a tool that saves it, such as `save_report` in your `tools`, or open the job with `agents.session` and read the file yourself with `s.sandbox.run`.
- **Limit it with `access: 'read-only'`** when the agent needs only its MCP tools, such as in a mail client. It can then call the job's MCP tools and read files, but not change a file or reach the network by itself. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#what-the-agent-may-do).
