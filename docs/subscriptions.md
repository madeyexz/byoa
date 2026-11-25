# Supported AI subscriptions

Your users bring a Claude plan or a ChatGPT plan. byoa signs each user in with the lab's own CLI, on the lab's own page, and then runs that CLI for them: Claude Code for a Claude plan, Codex for a ChatGPT plan. So a plan works with byoa when its lab lets it sign in to that CLI.

In beta, a user can also bring an OpenCode Go plan, with a key in place of a sign-in. It runs in Claude Code or Codex.

| Agent | Lab | Plans that work | Can the user's account get banned? |
|---|---|---|---|
| [Claude Code](#claude-plans-through-claude-code) | Anthropic | Claude Pro, Max, Ultra, Team and Enterprise | [Read the FAQ](faq.md#can-my-users-ai-account-get-banned) |
| [Codex](#chatgpt-plans-through-codex) | OpenAI | ChatGPT Plus, Pro, Business, Enterprise and Edu | [Read the FAQ](faq.md#can-my-users-ai-account-get-banned) |
| [Claude Code or Codex](#opencode-go-through-a-key-beta) **(beta)** | OpenCode | OpenCode Go, Go Plus and Go Teams | [Read the FAQ](faq.md#can-my-users-ai-account-get-banned) |

Prices and plan names are from the labs' pages on 25 November 2026, in US dollars a month, before tax. The labs change them often: check [Claude's plans](https://claude.com/pricing), [Codex's pricing](https://chatgpt.com/codex/pricing) and [OpenCode Go](https://opencode.ai/docs/console/go).

## Claude plans, through Claude Code

| Plan | Price | Works with byoa | Notes |
|---|---|---|---|
| Free | $0 | no | The Free plan does not include Claude Code. |
| Pro | $20 | yes | A five-hour limit and a weekly limit. |
| Max | $100 | yes | 5 times Pro's usage. |
| Ultra | $200 | yes | 10 times Pro's weekly usage. This was Max 20x. |
| Team | $25 a seat (Standard), $125 a seat (Premium) | yes | Every Team seat includes Claude Code. |
| Enterprise | $20 a seat, and usage at API rates | yes | The organization pays for the usage. |

Sources: [Use Claude Code with your Pro or Max plan](https://support.claude.com/en/articles/11145838), [What is the Team plan?](https://support.claude.com/en/articles/9266767), [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

## ChatGPT plans, through Codex

| Plan | Price | Works with byoa | Notes |
|---|---|---|---|
| Free | $0 | no | Codex only in the ChatGPT desktop app, not in the Codex CLI that byoa runs. |
| Go | $8 | no | The same as Free. |
| Plus | $20 | yes | Codex in the CLI, with a five-hour limit and weekly limits. |
| Pro | $100, $200 or $500 | yes | More usage than Plus. |
| Business | $25 a seat (Standard), $125 a seat (Premium) | yes | A workspace admin can restrict how members sign in to Codex. |
| Enterprise and Edu | from OpenAI's sales team | yes | The same; the admin may also have to turn the models on. |

Sources: [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540), [Codex pricing](https://learn.chatgpt.com/docs/pricing), [Codex authentication](https://developers.openai.com/codex/auth).

## OpenCode Go, through a key (beta)

**Beta.** No real OpenCode Go key has run this yet. byoa's tests use a stand-in for OpenCode's API, with the real Claude Code and Codex, locally and on E2B. The real check ([V20](../SPEC.md#verification)) has not run.

OpenCode Go is a plan, not a harness. It gives open models and others, such as Kimi, GLM, DeepSeek, Qwen and MiniMax, and the job still runs the unmodified `claude` or `codex`.

| Plan | Price | Works with byoa | Notes |
|---|---|---|---|
| Go | $10 | yes (beta) | |
| Go Plus | $40 | yes (beta) | More usage than Go. |
| Go Teams | $20 a member | yes (beta) | |

There is no sign-in page. The user creates an API key in [OpenCode's Console](https://opencode.ai/console) (`oc_sk_…`), and your app gives it to byoa one time:

```ts
const r = await agents.connectKey(userId, 'opencode-go', key)   // { state: 'signed-in' }; or 'no-plan', or an error
const models = await agents.listModels(userId, 'opencode-go')    // the plan's models, from OpenCode's API: no sandbox
agents.run(userId, { harness: 'codex', plan: 'opencode-go', model: 'kimi-k3.1-pro', task })
```

```flow
title: A job on the user's OpenCode Go key
nodes:
  - step: Your app gives byoa the key, one time
    text: "`connectKey(user, 'opencode-go', key)`. byoa checks the key with OpenCode and keeps it encrypted in your store, as it keeps MCP grants."
  - step: A job runs with plan 'opencode-go'
    text: "The unmodified Claude Code or Codex, with a Go model, and a config folder with no lab login. Claude Code gets `ANTHROPIC_BASE_URL`; Codex gets a model provider for this job only."
  - step: The harness sends its model requests to your proxy
    text: "To `<proxyUrl>/_plan/opencode-go/…`, with the job token. Only the model APIs go through, and only during the job."
  - end: The proxy adds the key and sends them on to OpenCode
    text: With the harness's own user agent and session id, as OpenCode asks. The key never goes into the sandbox.
```

- **A model of the plan.** A job with a plan needs a Go model: `model` in `run`, or `createAgents({ models: { 'opencode-go': { model } } })`. `listModels(userId, 'opencode-go')` lists them from OpenCode's API with the user's key, with no sandbox. The free models (`…-free`) are not in the list: OpenCode serves them only to its own client.
- **States.** `loginState(userId, 'opencode-go')` is `signed-in`; `expired` when OpenCode refuses the key (401: a wrong, revoked or expired key; the user makes a new one); or `no-plan` when the key's workspace has no Go plan (403). A job that gets one of these from OpenCode gives an `error` event with that code. `signOut(userId, 'opencode-go')` deletes the key.
- **Jobs at the same time.** A key does not rotate, so a user's jobs with it run at the same time, with no lease.
- **Terms.** OpenCode's terms say the user uses its services "only for your own internal use, and not on behalf of or for the benefit of any third party". A job with the user's own key for the user's own task is arguably that, but it is not clearly allowed. Ask OpenCode (help@anoma.ly) before your app offers it. See [Lab rules](lab-rules.md).

Sources: [OpenCode Go](https://opencode.ai/docs/console/go), [OpenCode Terms of Use](https://opencode.ai/legal/terms-of-service).

## What every plan has in common

- **The user's plan limits apply.** A job uses the same allowance as the user's own chats and coding: the five-hour and weekly limits are shared. When the user is at a limit, the CLI refuses, and the job ends with an `error` event.
- **One plan for each harness.** A user can sign in to both, and each job names its harness: `harness: 'claude'` or `harness: 'codex'`. A job on the user's OpenCode Go key also names `plan: 'opencode-go'`.
- **The login belongs to your app.** A login that a user made in your app is only for your app. Another app on byoa needs its own sign-in. See [Lab rules](lab-rules.md).
- **The labs' terms apply.** The labs restrict where an app may store the login, and OpenAI asks paid or hosted apps to apply to be partners. Read [the FAQ](faq.md#can-my-users-ai-account-get-banned) before you launch.

## What byoa does not support

- **API keys.** byoa signs in only with a plan. The one key it takes is the user's OpenCode Go key, which is a plan's key. An app that wants to pay for the AI with its own API key does not need byoa for the login.
- **Other labs' plans,** such as Gemini or Kimi memberships. byoa runs only Claude Code and Codex in version 1. Gemini or Antigravity may come later. OpenCode Go runs in Claude Code and Codex, not in OpenCode.
- **Sharing one login between apps.** The labs do not allow it, and byoa keeps each app's logins apart (`app` in `createAgents`).
