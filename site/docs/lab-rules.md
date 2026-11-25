# Lab rules

byoa runs the labs' own CLIs on each user's own plan, so byoa and every app on it follow the labs' published rules. This page has the rules from [SPEC.md](https://github.com/madeyexz/byoa/blob/main/SPEC.md#lab-rules), and what each app must do.

## Rules we follow

- We run the real, unmodified `claude` and `codex` binaries. We never pretend to be another client. A test checks the hash of the installed binaries against the published packages (V11).
- The user signs in through Anthropic's or OpenAI's own sign-in page.
- One app's AI login is used only by that app.
- For OpenCode Go (beta), byoa uses only the user's own key, with OpenCode's documented API and the harness's own user agent, never OpenCode's Console CLI sign-in. OpenCode's terms do not clearly allow an app to run it for its users, so each app asks OpenCode first.
- The labs' terms restrict where an AI login may be stored. byoa keeps it in your database by default, so each app checks those terms and signs its own agreements with the labs.

## What the labs' terms say

byoa follows the labs' published rules as read on 2026-11-22:

- Anthropic ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) allows an end user to sign in to the unmodified Claude Code binary with their own plan, including where a platform hosts Claude Code. It forbids third parties to "collect, store, or intermediate Claude.ai credentials or session tokens", unless Anthropic agrees otherwise.
- OpenAI ([Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), effective 2026-11-04) requires that "any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment", and that the plan is used "only for the application they connected". Paid or remotely hosted apps must [apply](https://openai.com/form/sign-in-with-chatgpt-interest/) to be partners.
- OpenCode ([Terms of Use](https://opencode.ai/legal/terms-of-service), effective 2026-11-08, read on 2026-11-25) says that the user "will only use the Services for your own internal use, and not on behalf of or for the benefit of any third party", and forbids using "multiple accounts to circumvent usage limits". Its [Go docs](https://opencode.ai/docs/console/go) say Go "is designed for OpenCode and other coding agents that produce similar types of requests", and ask each client to send "its own user agent" and "a stable session ID". OpenCode documents a Go key in Claude Code and in Codex. Whether an app may run a user's key for that user's own tasks is arguable, not clearly allowed: the work is the user's own, but the app gains from it too. Ian Hsiao accepted this for version 1 on 2026-11-25. There is no "Sign in with OpenCode" for apps; the user creates the key in OpenCode's Console.
- xAI (read on 2026-11-25) publishes Grok Build (`@xai-official/grok`, Apache-2.0) for SuperGrok and X Premium+ subscribers, with a device-code sign-in and a headless mode for scripts. Its [terms of service](https://x.ai/legal/terms-of-service) (2026-10-27) say "You may not share your account credentials or make your account available to anyone else", and its [acceptable use policy](https://x.ai/legal/acceptable-use-policy) forbids "Accessing the Services through unauthorized automated or non-human means". Neither says anything about an app that runs Grok Build for its own users, or that stores their login. Ian Hsiao accepted this when he added Grok Build to version 1; we have not asked xAI.

So byoa MUST:

- run only unmodified `claude`, `codex` and `grok` binaries, and never pretend to be another client;
- send the user to the lab's own sign-in page;
- not share one AI login between apps;
- for OpenCode Go, use only the user's own key, with OpenCode's documented API and the harness's own user agent, and never OpenCode's Console CLI sign-in, which has OpenCode's own client ID.

The labs' terms above restrict where these tokens may be stored. byoa keeps the AI login in the app's database by default (R1.4), and ships a per-user volume as an option (R1.5). Each app checks the labs' terms for its own use.

Each app is responsible for its own agreements with the labs. An app that offers OpenCode Go asks OpenCode (help@anoma.ly) before it ships it. We plan to sign agreements for our own apps when they have traction.

## What your app must do

Every app on byoa must follow these rules. If a request breaks one, stop and tell the developer.

- Run only the unmodified `claude`, `codex` and `grok` binaries that byoa installs (pinned, and checked in byoa's own tests). Do not patch them, wrap them to change what they send, or set headers or a user agent to pretend to be another client.
- Send the user to the lab's own sign-in page, from `connectLogin`. Do not embed, proxy or copy that page, and never ask the user for a password or an API key in place of it. The one key byoa takes is an OpenCode Go key, with `connectKey`, which OpenCode's Console makes for this.
- For OpenCode Go, never use OpenCode's Console CLI sign-in (`npx @opencode/console`): it has OpenCode's own client ID. OpenCode's terms say "only for your own internal use, and not on behalf of or for the benefit of any third party", so it is not clearly allowed for an app: tell the developer to ask OpenCode (help@anoma.ly) first.
- Never read, export or call the labs' APIs with the user's AI tokens. The CLI is the only client that uses them. Do not call the labs' token endpoints.
- One app's AI login is only for that app. Give each app its own `app` name and its own store. Never share a login between apps.
- Real MCP tokens never go into the sandbox. Give a job its servers with `mcp: [...]`. Never put a grant's token in `setup`, the task, environment variables or files.
- The labs' terms restrict where AI logins may be stored. Anthropic says third parties may not "collect, store, or intermediate Claude.ai credentials or session tokens" without its agreement. OpenAI says stored tokens must be "local and under the user's control", and paid or hosted apps must apply to be partners. xAI's terms forbid sharing an account and "unauthorized automated" access, and say nothing about an app that runs Grok Build for its users. byoa's default keeps the login in the app's database; `cliLogin` keeps it in a per-user volume. Each app checks the terms and makes its own agreements: https://github.com/madeyexz/byoa/blob/main/SPEC.md#lab-rules
