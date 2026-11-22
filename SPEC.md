# byoa requirements, version 1

**Status:** draft, 2026-11-22. **Owner:** Ian Hsiao.

This document says what version 1 of byoa must do and how we check it. It does not say how to build it. "MUST" and "SHOULD" have their usual meanings (RFC 2119).

## Goal

A developer makes an app AI-native in one day, not in weeks. The app runs the user's own Claude Code or Codex in any sandbox. The user signs in to ChatGPT or Claude one time and connects each MCP tool one time.

## Users of this library

- **App developer.** Imports byoa into their own backend. Does not want to build login, MCP OAuth, skills loading, harness updates or sandbox code.
- **End user.** Uses the developer's app. Has a ChatGPT or Claude plan, and accounts in tools such as Notion, Gmail or Heptabase.

## Scope

In scope for version 1:

- Harnesses: Claude Code and Codex. Both from the first version.
- Sandbox providers: E2B and Daytona.
- Backends: Node, and Convex actions. Cloudflare Workers SHOULD work if it costs little.
- Store adapters: Convex and Postgres.

Out of scope for version 1:

- A hosted service. byoa never runs a server for other apps.
- Sharing one user's AI login between different apps.
- Harnesses other than Claude Code and Codex (OpenCode, Amp, Pi, Cursor).
- A UI kit. The library gives data and events; the app draws its own UI.

## Requirements

### R1. AI login

- **R1.1** byoa MUST sign the user in to Claude Code by running the unmodified `claude` CLI login in the sandbox. The user completes sign-in on Anthropic's own page.
- **R1.2** byoa MUST sign the user in to Codex by running the unmodified `codex login --device-auth` in the sandbox. The user enters the code on OpenAI's own page.
- **R1.3** byoa MUST give the app the sign-in URL and code as data, so the app can show them on any device (for example a phone).
- **R1.4** By default, byoa MUST keep the login (the CLI's own login files) in the app's own database, through the store adapter (R6), encrypted with a key that the app gives, for one user of one app. Each job MUST get a copy in its new sandbox, and byoa MUST save the files back when the CLI changed them (a token refresh). byoa MUST NOT let two sandboxes hold one user's login at the same time, so that two token refreshes do not revoke each other. byoa MUST NOT call the lab's token endpoints itself; the CLI is the only client that uses the tokens.
- **R1.5** The login part MUST be replaceable, with no change to R2 to R5. byoa MUST also ship a login that stays in a volume of that one user of that one app, mounted through the sandbox adapter (R5.3), which the app's database never holds.
- **R1.6** byoa MUST report login state: `signed-in`, `signed-out`, `expired`.

### R2. MCP connections

- **R2.1** byoa MUST connect a remote MCP server for one user with MCP authorization (OAuth 2.1 with PKCE). It MUST use Client ID Metadata Documents when the server supports them, and Dynamic Client Registration only when it does not.
- **R2.2** byoa MUST also accept a bearer token that the user pastes.
- **R2.3** Each grant MUST have exactly one refresh owner: the app's backend. Two jobs that need a refresh at the same time MUST cause one refresh request.
- **R2.4** byoa MUST store grants through the store adapter (R6), in the app's own database, encrypted with a key that the app gives.
- **R2.5** byoa MUST let the app choose which MCP servers each job gets. (Bookish gives MCP servers only to jobs that the user asked for.)
- **R2.6** byoa MUST let the app's backend send a request with a user's grant to the MCP server's own origin, for an API next to the MCP endpoint that is not MCP (for example an export). byoa MUST add the token only for that origin, MUST NOT follow redirects, and MUST NOT give the token to the app.

### R3. MCP proxy: real tokens stay outside the sandbox

- **R3.1** The `mcp.json` in the sandbox MUST point to the app's proxy, with a short-lived token for one job and one user.
- **R3.2** The proxy MUST add the real token to each request and send it to the MCP server.
- **R3.3** No real MCP token MUST be in the sandbox's environment, files or processes at any time.
- **R3.4** The proxy MUST refuse a job token after the job ends.

### R4. Skills, AGENTS.md and config

- **R4.1** byoa MUST write skills in the Agent Skills format where each harness reads them (for example `.claude/skills/`, `.agents/skills/`).
- **R4.2** byoa MUST write AGENTS.md, and CLAUDE.md for Claude Code, from one source.
- **R4.3** byoa MUST write MCP config in each harness's own format: JSON for Claude Code, TOML for Codex.
- **R4.4** byoa SHOULD read an Agent Plugins 1.0 package (`plugin.json`, `skills/`, `mcp.json`).

### R5. Harness and sandbox

- **R5.1** byoa MUST install a pinned version of each harness in each new sandbox, or use a provider template with that version.
- **R5.2** A new harness version MUST reach every user at their next job. (Bookish had to copy a new core into old sandboxes, because a template reaches only new sandboxes.)
- **R5.3** Each sandbox provider MUST be one adapter with one interface: create, resume, run a command, write a file, mount a volume, destroy.
- **R5.4** The default lifecycle MUST be: create a sandbox, load the user's setup, run the job, destroy the sandbox. The user's AI login (R1.4) and grants (R2) stay.
- **R5.5** `agents.run` MUST stream events (text, tool calls, permission requests, errors, end) in one schema for both harnesses.

### R6. Store adapter

- **R6.1** The store adapter MUST be a small interface (get, put, delete, compare-and-set) that an app can write for its own database.
- **R6.2** Compare-and-set is needed for R2.3.

### R7. Developer experience

- **R7.1** A new app MUST reach its first agent run in under 50 lines of its own code.
- **R7.2** byoa MUST include a fake harness for tests, so apps can test without a plan or a sandbox.

## Lab rules

byoa follows the labs' published rules as read on 2026-11-22:

- Anthropic ([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)) allows an end user to sign in to the unmodified Claude Code binary with their own plan, including where a platform hosts Claude Code. It forbids third parties to "collect, store, or intermediate Claude.ai credentials or session tokens", unless Anthropic agrees otherwise.
- OpenAI ([Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/), effective 2026-11-04) requires that "any persistent storage of Authentication Tokens must be local and under the user's control, not in a remote or managed environment", and that the plan is used "only for the application they connected". Paid or remotely hosted apps must [apply](https://openai.com/form/sign-in-with-chatgpt-interest/) to be partners.

So byoa MUST:

- run only unmodified `claude` and `codex` binaries, and never pretend to be another client;
- send the user to the lab's own sign-in page;
- not share one AI login between apps.

The labs' terms above restrict where these tokens may be stored. byoa keeps the AI login in the app's database by default (R1.4), and ships a per-user volume as an option (R1.5). Each app checks the labs' terms for its own use.

Each app is responsible for its own agreements with the labs. We plan to sign agreements for our own apps when they have traction.

## Verification

Version 1 is done when every check below passes. Each check names the requirement it proves.

| # | Check | How | Proves |
|---|---|---|---|
| V1 | Bookish uses byoa | Replace `site/agent/login.ts`, `site/agent/sandbox.ts` and `src/core/connectors.ts` in Bookish with byoa. Bookish's existing e2e tests pass. | R1, R2, R5 |
| V2 | A second app uses byoa | Margins or the mail app runs its first agent job with byoa and no code copied from Bookish. Count the app's own lines. | R7.1 |
| V3 | Both harnesses | One test user runs the same task with Claude Code and with Codex. Both runs use that user's own plan. | R1.1, R1.2, R5.5 |
| V4 | Both providers | The same user runs a job on E2B, then on Daytona. The second job uses the same MCP grants and skills with no new MCP sign-in. | R5.3, R2 |
| V5 | Tokens stay out | After a job with an MCP call, a test searches the sandbox's environment, every file, and `/proc/*/cmdline` and `/proc/*/environ` for each real token. It finds none. | R3.3 |
| V6 | Old job tokens fail | A job token is used after its job ends. The proxy refuses it. | R3.4 |
| V7 | One refresh | Two jobs start at the same time with an expired access token. The MCP server's token endpoint gets one refresh request, and both jobs succeed. | R2.3, R6.2 |
| V8 | Disposable sandbox | After a job, the sandbox no longer exists at the provider. The next job works with no new sign-in. | R5.4 |
| V9 | Harness update | Change the pinned Claude Code version. The next job for an existing user runs the new version. | R5.2 |
| V10 | Config formats | For a sample plugin, the files byoa writes match the expected files for each harness, byte for byte. | R4 |
| V11 | Unmodified binaries | The test checks the hash of the installed `claude` and `codex` binaries against the published packages. | Lab rules |

V1 to V9 run against real providers and real plans, so they cost money. They run before each release, not on every commit. V10, V11 and the fake-harness tests run on every commit. In this repository: `npm test` runs V10 and the fake-harness tests, and `npm run test:v11` runs V11 (`.github/workflows/ci.yml`). With `E2B_API_KEY` and `DAYTONA_API_KEY` set, `npm test` also runs V4 (`test/v4.test.ts`).

## Open questions

- Does the first version support Cloudflare Workers, or only Node and Convex?
- How does a Claude login move from one sandbox provider to another without the app holding it? Today the user signs in again.
- Do Anthropic and OpenAI accept the default stored login (R1.4) for apps that run their unmodified CLIs, or does an app need an agreement with them? We will ask them.
- Do we write a spec for credential references as an extension of Agent Plugins, and send it to the Agentic AI Foundation?
