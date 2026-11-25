# Supported AI subscriptions

Your users bring an AI subscription that they already pay for. byoa runs it in the lab's own, unmodified CLI: Claude Code or Codex.

| Subscription | Plans that work | Can the user's account get banned? |
|---|---|---|
| [Claude](https://claude.com/pricing), in Claude Code | Pro, Max, Ultra, Team and Enterprise. Not Free. | It can. Anthropic's terms forbid apps to store Claude logins, and Anthropic may act without notice. |
| [ChatGPT](https://chatgpt.com/codex/pricing), in Codex | Plus, Pro, Business, Enterprise and Edu. Not Free or Go. | It can. OpenAI's terms want the login kept where the user controls it, and paid or hosted apps must apply to be partners. |
| [OpenCode Go](https://opencode.ai/docs/console/go) **(beta)**, in Claude Code or Codex | Go, Go Plus and Go Teams | It can. OpenCode's terms say "only for your own internal use". |

Why, and what to do before you launch: [Can my user's AI account get banned?](https://byoa.rippling.computer/docs/faq.md#can-my-users-ai-account-get-banned)

- **Claude and ChatGPT:** the user signs in on the lab's own page. See [AI login](https://byoa.rippling.computer/docs/ai-login.md).
- **OpenCode Go (beta):** the user gives a key from OpenCode's Console, and the key never goes into the sandbox. No real Go key has run it yet. See [AI login](https://byoa.rippling.computer/docs/ai-login.md#opencode-go-a-key-not-a-sign-in-beta).
- **Prices and limits:** the labs change them often, so read their own pages, linked in the table.

## What every plan has in common

- **The user's plan limits apply.** A job uses the same allowance as the user's own chats and coding: the five-hour and weekly limits are shared. When the user is at a limit, the CLI refuses, and the job ends with an `error` event.
- **One plan for each harness.** A user can sign in to both, and each job names its harness: `harness: 'claude'` or `harness: 'codex'`. A job on the user's OpenCode Go key also names `plan: 'opencode-go'`.
- **The login belongs to your app.** A login that a user made in your app is only for your app. Another app on byoa needs its own sign-in. See [Lab rules](https://byoa.rippling.computer/docs/lab-rules.md).
- **The labs' terms apply.** The labs restrict where an app may store the login, and OpenAI asks paid or hosted apps to apply to be partners. Read [the FAQ](https://byoa.rippling.computer/docs/faq.md#can-my-users-ai-account-get-banned) before you launch.

## What byoa does not support

- **API keys.** byoa signs in only with a plan. The one key it takes is the user's OpenCode Go key, which is a plan's key. An app that wants to pay for the AI with its own API key does not need byoa for the login.
- **Other labs' plans,** such as Gemini or Kimi memberships. byoa runs only Claude Code and Codex in version 1. Gemini or Antigravity may come later. OpenCode is also an agent itself (the `opencode` CLI), but byoa does not run it in version 1: an OpenCode Go plan runs in Claude Code or Codex.
- **Sharing one login between apps.** The labs do not allow it, and byoa keeps each app's logins apart (`app` in `createAgents`).
