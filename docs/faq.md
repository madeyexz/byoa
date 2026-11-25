# FAQ

## Can my user's AI account get banned?

It can. byoa cannot promise that it will not, because the labs decide, and their terms allow parts of what byoa does but not all of it. byoa is built to stay inside the parts that the labs allow:

- **It runs the labs' own CLIs, unmodified.** The agent is the real Claude Code or Codex, installed from the labs' own npm packages, and a test checks the binaries against those packages (V11). byoa never pretends to be another client, and never calls the labs' APIs with the user's tokens.
- **The user signs in on the lab's own page,** with the CLI's own sign-in. byoa never sees a password.
- **Each user uses their own plan, for their own work,** and one app's login is only for that app.

Anthropic's [Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance) allows "an end user signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code". But the same page also says:

- developers "may not collect, store, or intermediate Claude.ai credentials or session tokens". byoa's default login stores the CLI's login files, encrypted, in your app's database ([AI login](ai-login.md)).
- "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code". An app that runs many jobs for one user can go beyond that.
- Anthropic "reserves the right to take measures to enforce these restrictions and may do so without prior notice."

OpenAI's [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) say that stored tokens "must be local and under the user's control, not in a remote or managed environment", and that paid or remotely hosted apps must [apply to be partners](https://openai.com/form/sign-in-with-chatgpt-interest/).

So, before you launch:

- Read the [Lab rules](lab-rules.md), and decide where the logins stay: the default stored login, or `cliLogin` in a volume of each user.
- Apply to OpenAI's partner program if your app is paid or hosted, and ask Anthropic for an agreement if you store Claude logins.
- Keep each user's jobs to the user's own requests, at a pace that a person would use.
- Tell your users that the jobs use their own plan and its limits.

## Can one user run many agents at the same time?

Yes, with one sign-in, for Claude Code and Codex. Give each agent its own sandbox: a `sandboxKey` for each, or `sandboxPer: 'job'`. The jobs then share the user's login while it is not due for a refresh. Jobs in one sandbox wait in line instead, and one job can also carry several messages to one agent. See [Running agents](running-agents.md#jobs-at-the-same-time).

All these jobs use the same plan, so they reach the plan's limits sooner. One risk stays with a shared login: when the lab answers 401 to two sandboxes at the same time, both CLIs refresh, one refresh fails, and the user may have to sign in again. `storedLogin({ parallel: false })` turns sharing off ([AI login](ai-login.md#jobs-at-the-same-time-the-shared-login)).

## Which model does a job use?

The model and effort that you give `run`, else the harness's default from `createAgents({ models })`, else the CLI's own default. `agents.listModels(userId, harness)` lists the models that the user's plan can use, and the efforts of each, as the CLI lists them with the user's login. Pick from that list, because each plan has its own models. See [Running agents](running-agents.md#models-and-effort).

## What does an AI job cost with byoa, and with an API key?

With byoa, the user's plan pays for the model, and your app pays for the sandbox. With an API key, your app pays for every token. The model is by far the larger cost, so for an agent that runs small tasks, byoa costs your app about 18 to 300 times less.

### One small task

Take a small task in an AI-native app, such as "add these three to-dos and sort them by date". The agent makes about 20 model calls. Each call sends the conversation so far, so the inputs add up to about 500,000 tokens, of which about 90% are cache hits. The agent writes about 10,000 tokens, with its reasoning. The job takes about 5 minutes of sandbox time, from start to `close()`.

These are estimates. To get your own numbers, read the `usage` of each job's `end` event (`input`, `output`, `cached`, and `costUsd` when the CLI reports it).

**The model, at API prices** (per million tokens, from the labs' price pages on 25 November 2026):

| Model | 50,000 uncached input | 450,000 cached input | 10,000 output | One task |
|---|---|---|---|---|
| GPT-6.2 Sol ($2.00 in, $0.10 cached, $10.00 out) | $0.100 | $0.045 | $0.100 | **$0.245** |
| Kimi K3 ($3.00 in, $0.30 cached, $15.00 out) | $0.150 | $0.135 | $0.150 | **$0.435** |

**The sandbox,** 2 vCPU and 4 GiB of memory, for 5 minutes (prices per hour, billed by the second, only while it runs):

| Provider | 2 vCPU | 4 GiB | One hour | One task (5 minutes) |
|---|---|---|---|---|
| E2B ($0.0504 a vCPU, $0.0162 a GiB) | $0.1008 | $0.0648 | $0.1656 | **$0.0138** |
| Daytona (the same rates) | $0.1008 | $0.0648 | $0.1656 | **$0.0138** |
| Instabox ($0.004 a vCPU, $0.00225 a GiB) | $0.008 | $0.009 | $0.017 | **$0.0014** |

Sources: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing), [Kimi API pricing](https://platform.kimi.ai/docs/pricing/chat), [E2B pricing](https://e2b.dev/pricing), [Daytona pricing](https://www.daytona.io/pricing), [Instabox pricing](https://instabox.sh/pricing).

### For a month

A user who runs 100 such tasks a month costs your app:

| | Model at API prices | Sandbox with byoa |
|---|---|---|
| GPT-6.2 Sol | $24.50 | |
| Kimi K3 | $43.50 | |
| E2B or Daytona | | $1.38 |
| Instabox | | $0.14 |

The user already pays for their own plan, such as $20 a month for Claude Pro or ChatGPT Plus, and the task uses its allowance.

### What the numbers leave out

- **Plan fees at the provider.** E2B's Pro plan is $150 a month, and Instabox's Pro plan is $20 a month with $20 of usage in it. Daytona has no plan fee.
- **A kept sandbox between jobs.** A paused or stopped sandbox costs no compute. It can cost a little for its disk: Daytona bills disk past the first 5 GiB.
- **The sign-in sandbox,** once for each user and harness, for a few minutes.
- **An agent needs a sandbox either way.** With an API key, your app also pays for the sandbox, and for the tokens on top. byoa takes the token bill off your app. An app that only chats, with no tools and no files, needs no sandbox; there an API key can cost less for small use.
- **The user's plan has limits.** A user who runs many long tasks reaches the five-hour or weekly limit of their plan, and the jobs stop until it resets.

It is also simpler: your app has no per-user token bill, no usage metering or credits to sell, and no API key for the model to keep secret.
