# Supported AI subscriptions

Your users bring a Claude plan or a ChatGPT plan. byoa signs each user in with the lab's own CLI, on the lab's own page, and then runs that CLI for them: Claude Code for a Claude plan, Codex for a ChatGPT plan. So a plan works with byoa when its lab lets it sign in to that CLI.

| Agent | Lab | Plans that work | Can the user's account get banned? |
|---|---|---|---|
| [Claude Code](#claude-plans-through-claude-code) | Anthropic | Claude Pro, Max, Ultra, Team and Enterprise | [Read the FAQ](https://byoa.rippling.computer/docs/faq.md#can-my-users-ai-account-get-banned) |
| [Codex](#chatgpt-plans-through-codex) | OpenAI | ChatGPT Plus, Pro, Business, Enterprise and Edu | [Read the FAQ](https://byoa.rippling.computer/docs/faq.md#can-my-users-ai-account-get-banned) |

Prices and plan names are from the labs' pages on 25 November 2026, in US dollars a month, before tax. The labs change them often: check [Claude's plans](https://claude.com/pricing) and [Codex's pricing](https://chatgpt.com/codex/pricing).

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

## What every plan has in common

- **The user's plan limits apply.** A job uses the same allowance as the user's own chats and coding: the five-hour and weekly limits are shared. When the user is at a limit, the CLI refuses, and the job ends with an `error` event.
- **One plan for each harness.** A user can sign in to both, and each job names its harness: `harness: 'claude'` or `harness: 'codex'`.
- **The login belongs to your app.** A login that a user made in your app is only for your app. Another app on byoa needs its own sign-in. See [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md).
- **The labs' terms apply.** The labs restrict where an app may store the login, and OpenAI asks paid or hosted apps to apply to be partners. Read [the FAQ](https://byoa.rippling.computer/docs/faq.md#can-my-users-ai-account-get-banned) before you launch.

## What byoa does not support

- **API keys.** byoa signs in only with a plan. An app that wants to pay for the AI with its own API key does not need byoa for the login.
- **Other labs' plans,** such as Gemini or Kimi memberships. byoa runs only Claude Code and Codex in version 1. Gemini or Antigravity may come later.
- **Sharing one login between apps.** The labs do not allow it, and byoa keeps each app's logins apart (`app` in `createAgents`).
