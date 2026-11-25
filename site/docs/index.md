# byoa docs

**byoa, short for "bring your own agent", is the simplest way to let your users power the AI in your app with their own AI subscription.**

Each user signs in to their own Claude or ChatGPT plan one time. When your app has work for the AI, byoa runs that user's own Claude Code or Codex in a sandbox, with the user's tools, and streams the result back. The user's plan pays for the AI. Your app pays only for the sandbox.

byoa is an open-source library (Apache 2.0). It runs inside your app's own backend. It is not a hosted service. Start with [Getting started](https://byoa.rippling.computer/docs/getting-started.md). To learn the parts first, read [Concepts](https://byoa.rippling.computer/docs/concepts.md). To see which plans work, read [Supported AI subscriptions](https://byoa.rippling.computer/docs/subscriptions.md).

These pages are the Markdown files in [docs/](https://github.com/madeyexz/byoa/tree/main/docs) of the repository. The site at https://byoa.rippling.computer/docs shows the same pages, and serves each page as Markdown for LLMs (add `.md` to its address) and all of them in [llms-full.txt](https://byoa.rippling.computer/llms-full.txt).

## Start

- [Getting started](https://byoa.rippling.computer/docs/getting-started.md): install byoa, make one `agents` object, serve its two routes, sign a user in and run a first job
- [Concepts](https://byoa.rippling.computer/docs/concepts.md): who brings what, what byoa is and is not, how a job runs, and why real tokens never go into the sandbox
- [Supported AI subscriptions](https://byoa.rippling.computer/docs/subscriptions.md): which Claude, ChatGPT and OpenCode Go (beta) plans your users can bring, and what each one gives
- [FAQ](https://byoa.rippling.computer/docs/faq.md): whether a user's AI account can get banned, many agents of one user, models, and what an AI job costs with byoa and with an API key

## Guides

- [Give your agent tools](https://byoa.rippling.computer/docs/agent-tools.md): your app's own tools, the user's MCP servers, skills, AGENTS.md and plugins, which one to choose, and what the agent can do in its sandbox
- [AI login](https://byoa.rippling.computer/docs/ai-login.md): the sign-in on the lab's own page, where the login stays between jobs, one job step by step, jobs at the same time with one login, and sign-out
- [Sandbox lifecycle](https://byoa.rippling.computer/docs/sandbox-lifecycle.md): every sandbox byoa creates, from creation to removal, what each provider does, and what byoa does when your backend dies
- [MCP tools and the proxy](https://byoa.rippling.computer/docs/mcp.md): connect a user's MCP servers once, the proxy and job tokens, your app's own tools, and calls with a user's grant
- [Running agents](https://byoa.rippling.computer/docs/running-agents.md): `agents.run` and its events, what the agent may do, sandbox modes, jobs at the same time, models and effort, `session` and `jobToken`
- [Sandbox providers](https://byoa.rippling.computer/docs/providers.md): E2B, Daytona, Instabox and the local sandbox, and how to write an adapter
- [Stores and Convex](https://byoa.rippling.computer/docs/stores.md): the store adapter, Postgres, Convex, your own database, and a table of its own for the AI logins
- [Testing](https://byoa.rippling.computer/docs/testing.md): test your app with the fake harness, the local sandbox and the memory store, and run byoa's own tests

## Reference

- [API reference](https://byoa.rippling.computer/docs/api.md): every import, method, option and event
- [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md): what Anthropic's and OpenAI's terms allow, and what byoa and each app must do
- [Security](https://byoa.rippling.computer/docs/security.md): where each secret is kept, and how to report a problem
