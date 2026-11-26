# byoa docs

**byoa, short for "bring your own agent", is the simplest way to let your users bring their own AI subscription to power the agents in your app.**

## The future of AI-native apps

AI-native apps are the future. But an app that buys its AI at API prices must pass that cost on to its users. So it must choose: a frontier model, and a high price for each user, or a cheap model, and a worse agent. AI subscriptions solve this. We bet on a future where everyone has a $20 AI plan, or the same in another form, and that plan powers every app they use. In that future, every app is AI-native, so nobody says "AI-native app" anymore.

AI is like electricity, and an AI subscription is like a portable battery pack. Battery packs come in different sizes, and one pack powers all the appliances in your home. This is the economy we bet on. We build byoa to make it come sooner, so that every developer can build on it.

Diagram: Where the power comes from and who pays for it. Today: the AI labs sell tokens to each app through its API key, and each app, such as a notes app, a mail app and your app, pays per token and puts that cost in its price. With byoa: each user owns one battery, their own AI plan, and it plugs into every app they use. Your app passes on only the cost of the sandbox.

## What byoa does

Each user powers the agent features of your app with their own AI subscription: they sign in to it one time. Today byoa supports Claude (in Claude Code), ChatGPT (in Codex), Grok (in Grok Build) and OpenCode Go (beta), and more are coming soon. When your app has work for the AI, byoa runs that user's own Claude Code, Codex or Grok Build in a sandbox, with the user's tools, and streams the result back. The user's plan pays for the AI. Your app pays only for the sandbox.

Diagram: Who brings what. Your app brings the product, the sandbox account, and one call: agents.run. Each user brings their AI plan, such as Claude, ChatGPT or Grok, and their tools, such as Notion or Gmail. byoa puts them together in a new sandbox for each job: it runs the user's own Claude Code, Codex or Grok Build with their tools, and streams the result back to your app. The user's plan pays for the AI. Your app pays only for the sandbox.

byoa is an open-source library (Apache 2.0). It runs inside your app's own backend. It is not a hosted service. Start with [Getting started](https://byoa.rippling.computer/docs/getting-started.md). To learn the parts first, read the [Overview](https://byoa.rippling.computer/docs/concepts.md). To see which plans work, read [Supported AI subscriptions](https://byoa.rippling.computer/docs/subscriptions.md).

## What your users pay

Your app passes its AI costs on to its users, in its price. So the real question is what each user pays for the same agent:

- **Without byoa,** your app buys the AI at API prices. A frontier model gives a good agent and a high price. A cheap open-weight model gives a low price and a worse agent.
- **With byoa,** each user brings the AI, on a plan that they already pay for and that powers every app they use. Your app passes on only the cost of the sandbox.

Diagram: What each user pays a month for small agent tasks, when your app passes its AI costs on. With your API key, frontier models cost each user a lot, and cheaper models cost less for a weaker agent. With byoa, the user's own plan pays for a frontier model, and your app passes on only the sandbox. The numbers come from the cost tables in the FAQ.

For 100 tasks for each user, a month:

| How your app gets the AI | Each user pays a month |
|---|---|
| Your API key: Claude Opus 5.5 (frontier) | $49.00 |
| Your API key: GPT-6.2 Sol (frontier) | $24.50 |
| Your API key: Kimi K3 (frontier, open-weight) | $43.50 |
| Your API key: DeepSeek V4.1 Flash (smaller, open-weight) | $2.97 |
| byoa on E2B: the user's own plan, with a frontier model | $1.38 and their plan |
| byoa on Daytona: the user's own plan, with a frontier model | $1.38 and their plan |
| byoa on Instabox: the user's own plan, with a frontier model | $0.14 and their plan |

These are estimates for a small agent task, from the [FAQ](https://byoa.rippling.computer/docs/faq.md#what-does-an-ai-job-cost-with-byoa-and-with-an-api-key). byoa does not make tokens cheaper: it moves them to the user's plan. The plan has limits, and a user who runs many long tasks reaches them.

## Why and when you need byoa

You want your app to have an AI agent that does real work for each user: it reads and changes the user's data, calls the user's tools, and writes files. To build this yourself, you need many parts:

- an agent loop as good as Claude Code, Codex or Grok Build, and its updates;
- a sandbox for each user, which starts, pauses and ends at the right times;
- a sign-in to each user's AI plan, and safe storage of that login;
- an OAuth connection to each of the user's MCP tools, with the tokens kept out of the agent's reach.

And with your own API key, your app buys every token at API prices, and your users pay for them in your price. byoa gives you all of these parts as one library, and the user's own plan pays for the AI.

Diagram: Your backend, before and after. Build it yourself: your app, an agent loop, sandbox control, AI sign-in and login storage, and MCP OAuth and token storage, and an AI bill per token, at API prices. With byoa: your app and byoa, one npm install, and no AI bill, because the user's plan pays.

Use byoa when:

- your users already pay for Claude, ChatGPT, Grok or OpenCode Go, and you do not want to pay for their AI or sell them AI credits;
- your app's AI work is agent work, with many steps, tools and files, not one chat answer;
- you want Claude Code, Codex or Grok Build as your agent, not a loop of your own;
- you want each user's tools, such as Notion or Gmail, in each job, after one connection.

You do not need byoa when:

- your app needs only one model call at a time, such as a summary or a chat reply: an API key costs less there ([FAQ](https://byoa.rippling.computer/docs/faq.md#what-does-an-ai-job-cost-with-byoa-and-with-an-api-key));
- your agent needs no shell and no files, so an agent loop of your own can run it without a sandbox, such as on AWS Lambda, and a cheap model is good enough for it;
- your app pays for the AI itself and does not want the user's plan;
- your users do not have an AI plan, or use the agent only a little: a few tasks on a cheap model at API prices cost them less than a $20 plan.

These pages are the Markdown files in [docs/](https://github.com/madeyexz/byoa/tree/main/docs) of the repository. The site at https://byoa.rippling.computer/docs shows the same pages, and serves each page as Markdown for LLMs (add `.md` to its address) and all of them in [llms-full.txt](https://byoa.rippling.computer/llms-full.txt).

## Learn

- [Overview](https://byoa.rippling.computer/docs/concepts.md): who brings what, what byoa is and is not, how a job runs, and why real tokens never go into the sandbox
- [Getting started](https://byoa.rippling.computer/docs/getting-started.md): install byoa, make one `agents` object, serve its two routes, sign a user in and run a first job

## How it works

- [Sandbox lifecycle](https://byoa.rippling.computer/docs/sandbox-lifecycle.md): every sandbox byoa creates, from creation to removal, what carries over between jobs, what each provider does, and what byoa does when your backend dies
- [MCP tools and the proxy](https://byoa.rippling.computer/docs/mcp.md): connect a user's MCP servers once, the proxy and job tokens, your app's own tools, and calls with a user's grant
- [Security](https://byoa.rippling.computer/docs/security.md): where each secret is kept, and how to report a problem

## How to

- [Sign users in](https://byoa.rippling.computer/docs/ai-login.md): the sign-in on the lab's own page, where the login stays between jobs, one job step by step, jobs at the same time with one login, the OpenCode Go key, and sign-out
- [Give the agent tools](https://byoa.rippling.computer/docs/agent-tools.md): your app's own tools, the user's MCP servers, skills, AGENTS.md and plugins, which one to choose, and what the agent can do in its sandbox
- [Run agents](https://byoa.rippling.computer/docs/running-agents.md): `agents.run` and its events, what the agent may do, sandbox modes, conversations and more messages to a running job, jobs at the same time, models and effort, `session` and `jobToken`
- [Pick a sandbox provider](https://byoa.rippling.computer/docs/providers.md): E2B, Daytona, Instabox and the local sandbox, and how to write an adapter
- [Store logins and grants](https://byoa.rippling.computer/docs/stores.md): the store adapter, Postgres, Convex, your own database, and a table of its own for the AI logins
- [Test your app](https://byoa.rippling.computer/docs/testing.md): test your app with the fake harness, the local sandbox and the memory store, and run byoa's own tests

## Plans and rules

- [Supported AI subscriptions](https://byoa.rippling.computer/docs/subscriptions.md): which Claude, ChatGPT, Grok and OpenCode Go (beta) plans your users can bring, and whether their accounts can get banned
- [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md): what Anthropic's, OpenAI's, xAI's and OpenCode's terms allow, and what byoa and each app must do
- [FAQ](https://byoa.rippling.computer/docs/faq.md): what byoa is, whether a user's AI account can get banned, many agents of one user, whether the agent remembers earlier jobs, models, and what an AI job costs with byoa and with an API key

## Reference

- [API reference](https://byoa.rippling.computer/docs/api.md): every import, method, option and event
