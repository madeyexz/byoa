# byoa docs

byoa lets your app run each user's own Claude Code or Codex, on their plan and with their tools, in any sandbox, from inside your own backend.

byoa is an open-source library (Apache 2.0). It runs inside your app's own backend. It is not a hosted service. Start with [Getting started](getting-started.md). To learn the parts first, read [Concepts](concepts.md).

These pages are the Markdown files in [docs/](../docs) of the repository. The site at https://byoa.rippling.computer/docs shows the same pages, and serves each page as Markdown for LLMs (add `.md` to its address) and all of them in [llms-full.txt](https://byoa.rippling.computer/llms-full.txt).

## Start

- [Getting started](getting-started.md): install byoa, make one `agents` object, serve its two routes, sign a user in and run a first job
- [Concepts](concepts.md): who brings what, what byoa is and is not, how a job runs, and why real tokens never go into the sandbox

## Guides

- [AI login](ai-login.md): the sign-in on the lab's own page, where the login stays between jobs, one job step by step, the shared Codex login, and sign-out
- [Sandbox lifecycle](sandbox-lifecycle.md): every sandbox byoa creates, from creation to removal, what each provider does, and what happens when your backend dies
- [MCP tools and the proxy](mcp.md): connect a user's MCP servers once, the proxy and job tokens, your app's own tools, and calls with a user's grant
- [Running agents](running-agents.md): `agents.run` and its events, what the agent may do, sandbox modes, jobs at the same time, `session` and `jobToken`
- [Sandbox providers](providers.md): E2B, Daytona, Instabox and the local sandbox, and how to write an adapter
- [Stores and Convex](stores.md): the store adapter, Postgres, Convex, your own database, and a table of its own for the AI logins
- [Testing](testing.md): test your app with the fake harness, the local sandbox and the memory store, and run byoa's own tests

## Reference

- [API reference](api.md): every import, method, option and event
- [Lab rules](lab-rules.md): what Anthropic's and OpenAI's terms allow, and what byoa and each app must do
- [Security](security.md): where each secret is kept, and how to report a problem
