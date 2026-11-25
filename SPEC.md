# byoa requirements, version 1

**Status:** draft, 2026-11-22. **Owner:** Ian Hsiao.

This document says what version 1 of byoa must do and how we check it. It does not say how to build it. "MUST" and "SHOULD" have their usual meanings (RFC 2119).

## Goal

A developer makes an app AI-native in one day, not in weeks. The app runs the user's own Claude Code, Codex or Grok Build in any sandbox. The user signs in to ChatGPT, Claude or Grok one time, or gives the key of their OpenCode Go plan one time, and connects each MCP tool one time.

## Users of this library

- **App developer.** Imports byoa into their own backend. Does not want to build login, MCP OAuth, skills loading, harness updates or sandbox code.
- **End user.** Uses the developer's app. Has a ChatGPT, Claude, Grok (SuperGrok, X Premium+) or OpenCode Go plan, and accounts in tools such as Notion, Gmail or Heptabase.

## Scope

In scope for version 1:

- Harnesses: Claude Code and Codex, both from the first version, and Grok Build (xAI), added on 2026-11-25.
- Plans: the user's Claude, ChatGPT or Grok plan, through the lab's own sign-in; and OpenCode Go, through a key that the user gives, with Claude Code or Codex (R1.8). OpenCode Go is a plan, not a harness.
- Sandbox providers: E2B, Daytona and Instabox.
- Backends: Node, and Convex actions. Cloudflare Workers SHOULD work if it costs little.
- Store adapters: Convex and Postgres.

Out of scope for version 1:

- A hosted service. byoa never runs a server for other apps.
- Sharing one user's AI login between different apps.
- Harnesses other than Claude Code, Codex and Grok Build (OpenCode, Amp, Pi, Cursor). OpenCode Go runs in Claude Code and Codex (R1.8), not in OpenCode.
- A UI kit. The library gives data and events; the app draws its own UI.

## Requirements

### R1. AI login

- **R1.1** byoa MUST sign the user in to Claude Code by running the unmodified `claude` CLI login in the sandbox. The user completes sign-in on Anthropic's own page.
- **R1.2** byoa MUST sign the user in to Codex by running the unmodified `codex login --device-auth` in the sandbox, and to Grok Build by running the unmodified `grok login --device-auth`. The user enters the code on the lab's own page (OpenAI's, xAI's).
- **R1.3** byoa MUST give the app the sign-in URL and code as data, so the app can show them on any device (for example a phone).
- **R1.4** By default, byoa MUST keep the login (the CLI's own login files) in the app's own database, through the store adapter (R6), encrypted with a key that the app gives, for one user of one app. Each job MUST get a copy in its sandbox. After the job, byoa MUST save the files back when the CLI changed them (a token refresh), and MUST remove them from the sandbox, also from a sandbox that it keeps for the user's next job (R5.4). So between jobs the store is the only copy. byoa MUST NOT let two sandboxes refresh one user's login at the same time, so that two token refreshes do not revoke each other. The login is shared by default (`parallel`), for every harness, so that one user's jobs run at the same time: while the login is not due for a refresh before a job's time runs out, the jobs of one user each hold a copy; when it is due, one job MUST hold it alone, after the other jobs end. The app MAY turn sharing off. To know when a login is due, byoa MAY read the time its access token ends from the login files. byoa MUST NOT use a token, and MUST NOT call the lab's token endpoints itself; the CLI is the only client that uses the tokens.
  A backend can die during a job, so that the job never closes. byoa MUST then lose little: during the job it MUST save what the CLI changed about every minute; the next job in a kept sandbox that a dead job left MUST save the login that job's CLI refreshed, under the lease, before it writes the stored copy, unless the stored login changed since; and byoa MUST remove the files from the sandbox before the provider pauses or ends it, also with no backend. byoa MUST save files from a sandbox only when they are of the same account as the stored login and not older (the agent of a job can change any file), and MAY read the account and the refresh time from them for this.
- **R1.5** The login part MUST be replaceable, with no change to R2 to R5. byoa MUST also ship a login that stays in a volume of that one user of that one app, mounted through the sandbox adapter (R5.3), which the app's database never holds.
- **R1.6** byoa MUST report login state: `signed-in`, `signed-out`, `expired`; and for the key of a plan (R1.8), also `no-plan`.
- **R1.7** A sign-in that the user leaves MUST NOT keep its sandbox: the app MUST be able to end it at once (`cancelLogin`, also at sign-out), and with no word from the app, the sign-in sandbox MUST end within a few minutes after the app's last check-in (`finishLogin`), on every provider that can change a sandbox's time. A sign-in lasts 15 minutes at most, as long as Codex's device code.
- **R1.8** (beta: V20 has not run with a real Go key yet) byoa MUST also run Claude Code and Codex on the user's OpenCode Go plan, with a Console API key of the user (`oc_sk_…`) that the app gives (`connectKey`), instead of a lab login. byoa MUST check the key with OpenCode and keep it through the store adapter (R6), encrypted with a key that the app gives, for one user of one app. The key MUST NOT be in the sandbox's environment, files or processes at any time: the harness sends its model requests with the job token to a relay in the app's proxy (R3), which adds the key and sends them on to OpenCode, with the harness's own user agent and session headers, and refuses the job token after the job (R3.4). The relay MUST send on only the model APIs (`anthropic/v1/…`, `openai/v1/…`), and only for a job that has the plan. When OpenCode answers 401 (a wrong, revoked or expired key), the key is `expired`; when it answers 403 "OpenCode Go subscription required", it is `no-plan`. A key does not rotate, so one user's jobs with it MUST run at the same time, with no lease. byoa MUST use only OpenCode's documented API and its documented settings for each harness (Claude Code: `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; Codex: a model provider with the Responses API, for the job only), with a config folder of the job's own that has no lab login. Unlike a lab login (R1.4), the key is used by byoa itself, in the app's backend.

### R2. MCP connections

- **R2.1** byoa MUST connect a remote MCP server for one user with MCP authorization (OAuth 2.1 with PKCE). It MUST use Client ID Metadata Documents when the server supports them, and Dynamic Client Registration only when it does not.
- **R2.2** byoa MUST also accept a bearer token that the user pastes.
- **R2.3** Each grant MUST have exactly one refresh owner: the app's backend. Two jobs that need a refresh at the same time MUST cause one refresh request.
- **R2.4** byoa MUST store grants through the store adapter (R6), in the app's own database, encrypted with a key that the app gives.
- **R2.5** byoa MUST let the app choose which MCP servers each job gets. (Bookish gives MCP servers only to jobs that the user asked for.)
- **R2.6** byoa MUST let the app's backend send a request with a user's grant to an API of the same service that is not MCP (for example an export). By default, the token goes only to the origin of the grant's MCP server. The app's backend MAY name more origins for the grants of one MCP server origin, as exact origins (https, no path, no wildcard), in its own configuration; the MCP server, the sandbox and the user MUST NOT be able to add one. byoa MUST add the token only for those origins, MUST NOT follow redirects, and MUST NOT give the token to the app. (Margins' MCP server is on `margin.rippling.computer`, and its export is on `helpful-tern-930.convex.site`.)
- **R2.7** byoa MUST let the app give its own tools as functions in its backend. The proxy (R3) MUST serve them as the tools of an MCP server, only to a job that the app gave them (R2.5), and MUST give each call the user of the job. The app writes no MCP server, and no user connects anything for them.

### R3. MCP proxy: real tokens stay outside the sandbox

- **R3.1** The `mcp.json` in the sandbox MUST point to the app's proxy, with a short-lived token for one job and one user.
- **R3.2** The proxy MUST add the real token to each request and send it to the MCP server.
- **R3.3** No real MCP token MUST be in the sandbox's environment, files or processes at any time.
- **R3.4** The proxy MUST refuse a job token after the job ends.
- **R3.5** Before the harness starts, byoa MUST check from the job's sandbox that each MCP server of the job answers through the proxy. When the sandbox cannot reach the proxy, the job MUST NOT start, and MUST end with an error. A server that does not answer MUST give an error event. (A harness that cannot reach a server leaves its tools out and still ends well.)

### R4. Skills, AGENTS.md and config

- **R4.1** byoa MUST write skills in the Agent Skills format where each harness reads them (for example `.claude/skills/`, `.agents/skills/`).
- **R4.2** byoa MUST write AGENTS.md, and CLAUDE.md for Claude Code, from one source.
- **R4.3** byoa MUST write MCP config in each harness's own format: JSON for Claude Code, TOML for Codex and Grok Build.
- **R4.4** byoa SHOULD read an Agent Plugins 1.0 package (`plugin.json`, `skills/`, `mcp.json`).

### R5. Harness and sandbox

- **R5.1** byoa MUST install a pinned version of each harness in each sandbox, or use a provider template with that version.
- **R5.2** A new harness version MUST reach every user at their next job. (Bookish had to copy a new core into old sandboxes, because a template reaches only new sandboxes.)
- **R5.3** Each sandbox provider MUST be one adapter with one interface: create, resume, run a command, write a file, read a file, mount a volume, pause, destroy. A command that runs out of its time MUST end with exit code 137 on every provider, not throw. Reading a file is optional: without it, byoa reads a file as base64 on a command's output. A provider says what it can do (`capabilities`): a provider with no volumes (Instabox) refuses a volume, so the volume login of R1.5 does not work on it and createAgents refuses it; the stored login of R1.4 does. One conformance check (`test/helpers/conformance.ts`) MUST pass for each adapter.
- **R5.4** The lifecycle MUST be the app's choice, with the same app code on every provider:
  - **One kept sandbox per user (the default).** Each user has one sandbox of the app for each harness. The first job creates it. After each job, byoa pauses it (E2B: pause; Daytona and Instabox: stop), and the next job resumes it, with a new job folder. One job of a user and harness runs at a time; the others wait in line (R5.8). When the provider no longer has the sandbox (it was deleted, or it expired), the next job creates a new one. A sandbox that times out during a job (a crash, a lost network) is paused, not deleted, and no process of that job runs when it resumes. byoa MUST delete the user's sandbox at sign-out, and MUST give the app a way to delete it, such as when it deletes the user.
  - **Many kept sandboxes per user (a `sandboxKey` for each job).** The same, but each key that the app gives a job (such as a project), and each conversation (R5.9), has its own sandbox and its own lease, so jobs with different keys run at the same time. With the stored login of R1.4, jobs share the login by default, for every harness. The app MUST be able to delete the sandbox of one key, or all of the user's.
  - **One sandbox per job (`sandboxPer: 'job'`).** Create a sandbox, load the user's setup, run the job, destroy the sandbox.

  In all three, the user's AI login (R1.4) and grants (R2) stay in the app's database, and the security properties of R1.4 and R3 do not depend on the choice: no real MCP token goes into the sandbox, a job token is refused after its job, and no copy of the AI login stays in the sandbox between jobs.
- **R5.5** `agents.run` MUST stream events (text, tool calls, permission requests, errors, turns, end) in one schema for every harness.
- **R5.6** byoa MUST let the app limit what the agent of a job may do, with each CLI's own options only (Lab rules). With `access: 'read-only'`, the agent MUST be able to call the job's MCP tools and to read files, so that the harness can read its skills and AGENTS.md; it MUST NOT be able to change a file, or to reach the network by itself. The default (`full`) is every tool of the harness with no approval, for a sandbox that is the job's alone.
- **R5.7** byoa MUST let the app choose the model and effort of each job, and of each harness by default, with each CLI's own flags only, and MUST list the models a user's plan can use, as each CLI lists them with that user's login. For a plan with a key (R1.8), byoa MUST list the plan's models from its API with the user's key, with no sandbox, and a job MUST name one of them (or get the app's default for the plan).
- **R5.8** One user's many agents MUST be the app's choice, in three patterns that work together: jobs of one sandbox wait in line and run in the order they came, with no time limit unless the app sets one; one job MAY carry several messages to one agent, which decides their order; and jobs with different sandboxes run at the same time (R5.4, R1.4).
- **R5.9** A job MAY name a conversation (the app's id, such as a chat thread). Then the job MUST continue the harness's own session of the earlier jobs of that conversation, with each CLI's own flags only (Lab rules): Claude Code `--session-id`, then `--resume`; Codex `exec` without `--ephemeral`, the thread id from its `thread.started` event, then `exec resume <id>`; Grok Build `-s`, then `-r`. A conversation MUST have its own kept sandbox (R5.4), whose job folder stays from job to job, except the files byoa writes (R4), which each job gets new. Its jobs run one at a time. The `start` event MUST say whether the job resumed, and the `end` event MUST name the harness's session. After each job, byoa MUST keep the session id and, when it is not larger than the app's limit, a copy of the session's files, encrypted in the store; when the provider lost the sandbox, the next job MUST write that copy into its new sandbox. When there is no copy, the job MUST say so (an `error` with code `conversation`) and start a new session. The app MUST be able to delete a conversation, with its copy and its sandbox.
- **R5.10** A running job SHOULD take more messages from the app, where the harness reads messages while it runs (steering). Claude Code does, with stream-json input: a message waits for the turn that runs, each turn before the last gives a `turn` event, and the job ends after the turn that answers the last message. Codex (`exec`) and Grok Build (`-p`) read the whole task before they start and no input after, so their jobs take no message while they run; the app sends it as the next job of the conversation (R5.9).

### R6. Store adapter

- **R6.1** The store adapter MUST be a small interface (get, put, delete, compare-and-set) that an app can write for its own database.
- **R6.2** Compare-and-set is needed for R2.3.

### R7. Developer experience

- **R7.1** A new app MUST reach its first agent run in under 50 lines of its own code.
- **R7.2** byoa MUST include a fake harness for tests, so apps can test without a plan or a sandbox.
- **R7.3** byoa SHOULD ship an agent skill in the Agent Skills format (`skills/byoa/`) that teaches a coding agent to add byoa to an app, and its site SHOULD serve the docs for LLMs as `llms.txt` and `llms-full.txt`. Both MUST name only the API that byoa has.

## Lab rules

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

## Verification

Version 1 is done when every check below passes. Each check names the requirement it proves.

| # | Check | How | Proves |
|---|---|---|---|
| V1 | Bookish uses byoa | Replace `site/agent/login.ts`, `site/agent/sandbox.ts` and `src/core/connectors.ts` in Bookish with byoa. Bookish's existing e2e tests pass. | R1, R2, R5 |
| V2 | A second app uses byoa | A second app (the to-do example in `examples/todo`, Margins, or the mail app) runs its first agent job with byoa, on a real sandbox provider and a real plan, with no code copied from Bookish. Count the app's own lines. | R7.1 |
| V3 | Every harness | One test user runs the same task with Claude Code, with Codex and with Grok Build. Each run uses that user's own plan. | R1.1, R1.2, R5.5 |
| V4 | Two providers | The same user runs a job on E2B, then on Daytona or Instabox. The second job uses the same MCP grants and skills with no new MCP sign-in. | R5.3, R2 |
| V5 | Tokens stay out | After a job with an MCP call, a test searches the sandbox's environment, every file, and `/proc/*/cmdline` and `/proc/*/environ` for each real token. It finds none. | R3.3 |
| V6 | Old job tokens fail | A job token is used after its job ends. The proxy refuses it. | R3.4 |
| V7 | One refresh | Two jobs start at the same time with an expired access token (with `sandboxPer: 'job'`, so that they run at the same time). The MCP server's token endpoint gets one refresh request, and both jobs succeed. | R2.3, R6.2 |
| V8 | Sandbox lifecycle | By default, a user's second job runs in the first job's sandbox, which was paused between them, and jobs with two sandbox keys run in two more sandboxes, of which deleting one key removes only that one. When the provider no longer has a sandbox, the next job works in a new one with no new sign-in, and deleting the user's sandbox removes it at the provider. With `sandboxPer: 'job'`, after a job its sandbox no longer exists at the provider. | R5.4 |
| V9 | Harness update | Change the pinned version of a harness (Claude Code, Grok Build). The next job for an existing user runs the new version. | R5.2 |
| V10 | Config formats | For a sample plugin, the files byoa writes match the expected files for each harness, byte for byte. | R4 |
| V11 | Unmodified binaries | The test checks the hash of the installed `claude`, `codex` and `grok` binaries against the published packages. Grok's own postinstall unpacks its binary from the published `grok.br`: the test unpacks that file too. | Lab rules |
| V12 | The docs match the API | A test checks that every `agents.*` method, and every name imported from byoa, in the README, the docs (`docs/`) and the agent skill exists in byoa. | R7.3 |
| V13 | The app's own tools | A job with a real harness calls a tool that the app gave as a function. The function runs in the backend for the job's user. The app has no MCP server, and the user has no grant. | R2.7 |
| V14 | A proxy that is down | A job starts while its sandbox cannot reach the proxy. The harness does not start, and the job ends with an `mcp` error and `ok: false`. | R3.5 |
| V15 | Read-only access | A job with a real harness and `access: 'read-only'` reads its skill and calls an MCP tool. A command that writes a file fails, and a command that opens a network connection fails. | R5.6 |
| V16 | Jobs at the same time | One user starts three Codex jobs with three sandbox keys. They run at the same time with one sign-in, and the login works after them. | R1.4, R5.4, R5.8 |
| V17 | A backend that dies | A job's CLI refreshes its login, and the backend dies before the job closes. The next job in that sandbox uses the refreshed login, and a job after a new sign-in uses the new login. A real check also finds no login file in the sandbox once the provider paused it. | R1.4 |
| V18 | A sign-in that is left | A sign-in that the app cancels has no sandbox at the provider right after. A sign-in with no check-in for a few minutes has none either. | R1.7 |
| V19 | Models | `listModels` returns, for a real login of each harness, what the CLI lists; a job with a model and effort from that list runs with them. | R5.7 |
| V20 | OpenCode Go (beta: not run yet) | One test user with a real Go key runs the same task with Claude Code and with Codex on E2B, through the relay. Three jobs of that user run at the same time; a job gets the model it names; a key that OpenCode refuses is `expired`, and one of a workspace with no Go plan is `no-plan`. A search of each sandbox's environment, files and `/proc/*/cmdline` finds no key. | R1.8, R1.6, R5.7, R5.8 |
| V21 | Conversations | With a real login of each harness on E2B, one user's conversation has three jobs. The second job knows what the first was told and finds the file the first wrote in the job folder. The third job runs after the conversation's sandbox was deleted at the provider, and still knows it, from the stored copy. A Claude Code job takes a second message while it runs and answers it before it ends. | R5.9, R5.10 |

V1 to V9 and V13 to V21 run against real providers and real plans, so they cost money. They run before each release, not on every commit. V10, V11, V12 and the fake-harness tests run on every commit; these include V13, V14, V16, V17, V18, V19, V20 and V21 with the fake harness, a stand-in CLI and, for V20, a stand-in for OpenCode's API. In this repository: `npm test` runs V10, V12 and the fake-harness tests, `npm run test:v11` runs V11, and the job `example-todo` runs the to-do example's fake-harness tests (`.github/workflows/ci.yml`). `npm test` starts no paid sandbox, also when the providers' keys are set: each paid check needs its own flag. `npm run test:v4` runs V4 (`test/v4.test.ts`) with `E2B_API_KEY` and `DAYTONA_API_KEY`; `BYOA_V4_PROVIDERS=e2b,instabox` runs it on E2B and Instabox. `npm run test:e2b` runs V8 on E2B (`test/e2b.test.ts`), `npm run test:daytona` runs V8 on Daytona (`test/daytona.test.ts`), and `npm run test:instabox` runs V8 on Instabox (`test/instabox.test.ts`). `npm run test:v20` runs V20 on E2B (`test/v20.test.ts`), with `OPENCODE_GO_API_KEY` and `E2B_API_KEY` set. V20 has not run yet, so OpenCode Go (R1.8) is in beta: its tests use a stand-in for OpenCode's API, and the real Claude Code and Codex were checked only against that stand-in, locally and on E2B. `node scripts/v21.ts` runs V21 on E2B in steps (`login <harness>`, `check`, `cleanup`), because it needs a person to sign in. On an Instabox plan that allows fewer than three sandboxes (the free plan allows one), V8 there checks one sandbox key alone, not two at the same time.

## Open questions

- Does the first version support Cloudflare Workers, or only Node and Convex?
- How does a Claude login move from one sandbox provider to another without the app holding it? Today the user signs in again.
- Do Anthropic, OpenAI and xAI accept the default stored login (R1.4) for apps that run their unmodified CLIs, or does an app need an agreement with them? We will ask them.
- Does OpenCode accept an app that runs a user's Go key for that user's own tasks (R1.8), given "only for your own internal use"? We will ask them.
- The shared login (R1.4) is the default for every harness. The CLIs also refresh their login when the lab answers 401 to a token that has not run out. Two sandboxes that get that answer at the same time both refresh, and one refresh fails. How often does that occur?
- `access: 'read-only'` (R5.6) does not hide files: the agent can read each file that its user can read, also the CLI's own login files. Does byoa need a level that lets the agent read only its job folder, for apps that run on the user's own computer?
- How long does a user's paused sandbox stay? Today byoa deletes it only at sign-out and when the app calls `deleteSandbox`. E2B and Instabox keep a paused or stopped sandbox with no time limit; Daytona archives a stopped one after 7 days, and the next job restores it more slowly. Does byoa need a limit for users who stop using an app?
- Do we write a spec for credential references as an extension of Agent Plugins, and send it to the Agentic AI Foundation?
