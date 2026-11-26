# FAQ

## Can my user's AI account get banned?

It can. byoa cannot promise that it will not, because the labs decide, and their terms allow parts of what byoa does but not all of it. byoa is built to stay inside the parts that the labs allow:

- **It runs the labs' own CLIs, unmodified.** The agent is the real Claude Code, Codex or Grok Build, installed from the labs' own npm packages, and a test checks the binaries against those packages (V11). byoa never pretends to be another client, and never calls the labs' APIs with the user's tokens.
- **The user signs in on the lab's own page,** with the CLI's own sign-in. byoa never sees a password.
- **Each user uses their own plan, for their own work,** and one app's login is only for that app.

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". But the same page also says:

- developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". byoa's default login stores the CLI's login files, encrypted, in your app's database ([AI login](https://byoa.rippling.computer/docs/ai-login.md)).
- "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code". An app that runs many jobs for one user can go beyond that.
- Anthropic "reserves the right to take measures to enforce these restrictions and may do so without prior notice."

OpenAI's [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) say that stored tokens "must be local and under the user's control, not in a remote or managed environment", and that paid or remotely hosted apps must [apply to be partners](https://openai.com/form/sign-in-with-chatgpt-interest/).

xAI's [terms of service](https://x.ai/legal/terms-of-service) say "You may not share your account credentials or make your account available to anyone else", and its [acceptable use policy](https://x.ai/legal/acceptable-use-policy) forbids "Accessing the Services through unauthorized automated or non-human means". Neither says anything about an app that runs Grok Build for its users, or that stores their login. So for Grok, the answer is unclear.

OpenCode's [Terms of Use](https://opencode.ai/legal/terms-of-service) say the user uses its services "only for your own internal use, and not on behalf of or for the benefit of any third party". So an OpenCode Go key (beta) in your app is arguable, not clearly allowed ([AI login](https://byoa.rippling.computer/docs/ai-login.md#opencode-go-a-key-not-a-sign-in-beta)).

So, before you launch:

- Read the [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md), and decide where the logins stay: the default stored login, or `cliLogin` in a volume of each user.
- Apply to OpenAI's partner program if your app is paid or hosted, and ask Anthropic for an agreement if you store Claude logins. If you offer OpenCode Go, ask OpenCode (help@anoma.ly) first.
- Keep each user's jobs to the user's own requests, at a pace that a person would use.
- Tell your users that the jobs use their own plan and its limits.

## Can one user run many agents at the same time?

Yes, with one sign-in, for Claude Code, Codex and Grok Build. Give each agent its own sandbox: a `sandboxKey` for each, or `sandboxPer: 'job'`. The jobs then share the user's login while it is not due for a refresh. Jobs in one sandbox wait in line instead, and one job can also carry several messages to one agent. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#jobs-at-the-same-time).

All these jobs use the same plan, so they reach the plan's limits sooner. One risk stays with a shared login: when the lab answers 401 to two sandboxes at the same time, both CLIs refresh, one refresh fails, and the user may have to sign in again. `storedLogin({ parallel: false })` turns sharing off ([AI login](https://byoa.rippling.computer/docs/ai-login.md#jobs-at-the-same-time-the-shared-login)). Jobs on an OpenCode Go key have no such risk: a key does not rotate.

## Does the agent remember earlier jobs?

Only in a conversation. A job with a `conversation` id continues the harness's own session of the earlier jobs with that id, in the conversation's own kept sandbox, and its job folder (`~/work`) stays. A job with no `conversation` starts a new session, and its job folder is new. byoa keeps a copy of each conversation's transcript, encrypted in your database, so the agent still remembers when the provider loses the sandbox. A running job of each harness also takes more messages (`job.send`): Codex and Grok Build into the turn that runs, Claude Code after it. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#conversations) and [what carries over between jobs](https://byoa.rippling.computer/docs/sandbox-lifecycle.md#what-carries-over-between-jobs).

## Which model does a job use?

The model and effort that you give `run`, else the harness's default from `createAgents({ models })`, else the CLI's own default. `agents.listModels(userId, harness)` lists the models that the user's plan can use, and the efforts of each, as the CLI lists them with the user's login. Pick from that list, because each plan has its own models. A job on an OpenCode Go key (beta) needs a Go model: `agents.listModels(userId, 'opencode-go')` lists them from OpenCode's API, with no sandbox. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#models-and-effort).

## What does an AI job cost with byoa, and with an API key?

Your app passes its AI costs on to its users, in its price, so the question is what each user pays. With an API key, your app buys every token at API prices. With byoa, the user's own plan pays for the model, and your app passes on only the sandbox. For 100 small tasks a month, that takes each user's cost from $24.50 to $49 with a frontier model, or from $3 with a cheap open-weight model and a worse agent, down to $1.38 on E2B, and a frontier agent on the plan they already pay for.

### One small task

Take a small task in an AI-native app, such as "add these three to-dos and sort them by date". The agent makes about 20 model calls. Each call sends the conversation so far, so the inputs add up to about 500,000 tokens, of which about 90% are cache hits. The agent writes about 10,000 tokens, with its reasoning. The job takes about 5 minutes of sandbox time, from start to `close()`.

These are estimates. To get your own numbers, read the `usage` of each job's `end` event (`input`, `output`, `cached`, and `costUsd` when the CLI reports it).

**The model, at API prices** (per million tokens, from the labs' price pages on 25 November 2026):

| Model | Kind | 50,000 uncached input | 450,000 cached input | 10,000 output | One task |
|---|---|---|---|---|---|
| Claude Opus 5.5 ($4.00 in, $0.20 cached, $20.00 out) | frontier | $0.200 | $0.090 | $0.200 | **$0.490** |
| GPT-6.2 Sol ($2.00 in, $0.10 cached, $10.00 out) | frontier | $0.100 | $0.045 | $0.100 | **$0.245** |
| Kimi K3 ($3.00 in, $0.30 cached, $15.00 out) | frontier, open-weight | $0.150 | $0.135 | $0.150 | **$0.435** |
| DeepSeek V4.1 Flash ($0.30 in, $0.006 cached, $1.20 out) | smaller, open-weight | $0.015 | $0.0027 | $0.012 | **$0.0297** |

**The sandbox,** 2 vCPU and 4 GiB of memory, for 5 minutes (prices per hour, billed by the second, only while it runs):

| Provider | 2 vCPU | 4 GiB | One hour | One task (5 minutes) |
|---|---|---|---|---|
| E2B ($0.0504 a vCPU, $0.0162 a GiB) | $0.1008 | $0.0648 | $0.1656 | **$0.0138** |
| Daytona (the same rates) | $0.1008 | $0.0648 | $0.1656 | **$0.0138** |
| Instabox ($0.004 a vCPU, $0.00225 a GiB) | $0.008 | $0.009 | $0.017 | **$0.0014** |

Claude Opus 5.5 has a cache write price too ($5.00), which this leaves out. DeepSeek's prices are its weekday peak prices; at other times they are half.

Sources: [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing), [OpenAI API pricing](https://developers.openai.com/api/docs/pricing), [Kimi API pricing](https://platform.kimi.ai/docs/pricing/chat), [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/), [E2B pricing](https://e2b.dev/pricing), [Daytona pricing](https://www.daytona.io/pricing), [Instabox pricing](https://instabox.sh/pricing).

### For a month

What each user pays a month for 100 such tasks, when your app passes its costs on:

| | Model at API prices | Sandbox with byoa |
|---|---|---|
| Claude Opus 5.5 | $49.00 | |
| GPT-6.2 Sol | $24.50 | |
| Kimi K3 | $43.50 | |
| DeepSeek V4.1 Flash | $2.97 | |
| E2B or Daytona | | $1.38 |
| Instabox | | $0.14 |

The user already pays for their own plan, such as $20 a month for Claude Pro or ChatGPT Plus, and the task uses its allowance.

To try other numbers of tasks:

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

### What the numbers leave out

- **Plan fees at the provider.** E2B's Pro plan is $150 a month, and Instabox's Pro plan is $20 a month with $20 of usage in it. Daytona has no plan fee.
- **A kept sandbox between jobs.** A paused or stopped sandbox costs no compute. It can cost a little for its disk: Daytona bills disk past the first 5 GiB.
- **The sign-in sandbox,** once for each user and harness, for a few minutes.
- **An agent with no sandbox.** An agent that only calls your app's own API, with no shell and no files, can run as an agent loop of your own, such as on AWS Lambda, with no sandbox. Then an API key costs only the tokens. byoa needs a sandbox, because Claude Code, Codex and Grok Build need a shell.
- **The user's plan has limits.** A user who runs many long tasks reaches the five-hour or weekly limit of their plan, and the jobs stop until it resets.

### When an API key costs the user less

- **The user has no plan.** Then they must buy one, such as $20 a month, before your agent works.
- **The user runs only a few tasks.** 10 small tasks on DeepSeek V4.1 Flash cost $0.30 at API prices, much less than a plan. A plan pays off when the user uses it in many apps, or uses your agent a lot.
- **The user runs many long tasks.** They reach the limits of their plan.

### What your app gets

Your costs do not grow with each user's tokens. You do not have to choose between a good agent and a low price. Your app has no per-user token bill, no usage metering or credits to sell, and no API key for the model to keep secret.
