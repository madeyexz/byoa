# AI login

A user's AI login stays encrypted in your app's database, and is in a sandbox only while a sign-in, a job or a sign-out runs. This page shows how byoa signs a user in to Claude Code, Codex and Grok Build, keeps the CLI's own login files, and uses them for each job. An OpenCode Go plan (beta) has no sign-in: the user gives a key, which never goes into the sandbox ([below](#opencode-go-a-key-not-a-sign-in-beta)).

| The login tokens are in | They are never in |
|---|---|
| the sign-in sandbox, until byoa destroys it | what byoa returns to your app |
| your app's database, encrypted | the job's environment variables |
| a job's sandbox, only while the job runs | a kept sandbox between jobs |
| | the state, lease, line and loan entries in the store |

This is for the default login, `storedLogin()`. With `cliLogin`, the tokens stay in the user's volume instead of the database. byoa never uses the tokens itself and never calls the labs' token endpoints. The unmodified CLI is the only client that sends them to the lab.

## Sign-in

Your app calls `agents.connectLogin(user, harness)`. byoa starts a new sandbox, installs the pinned CLI and runs its own sign-in. The user signs in on the lab's page. byoa gives your app only that page's address and, for Codex and Grok Build, a code.

The sign-in sandbox lives only while your sign-in UI checks in. Each `finishLogin` call keeps it for 2 more minutes. A sign-in lasts 15 minutes at most, as long as Codex's device code (Grok's code lasts at least 9 minutes).

| | Claude Code | Codex | Grok Build |
|---|---|---|---|
| The CLI's sign-in | `claude auth login` | `codex login --device-auth` | `grok login --device-auth` |
| What your app shows | a link on claude.com | a link on auth.openai.com, and a one-time code | a link on accounts.x.ai, and a one-time code |
| What the user does | signs in; Anthropic's page shows a code | enters the code on OpenAI's page | enters the code on xAI's page |
| How your app finishes | `finishLogin(user, 'claude', { code })` with that code; byoa types it into the CLI and waits up to 60 s | `finishLogin(user, 'codex', { waitMs })`, again until the state is no longer `pending` | the same as Codex, with `'grok'` |
| How your app checks in | `finishLogin(user, 'claude')` with no code, about every 30 s while the user is on Anthropic's page; it answers `pending` | each `finishLogin` call; keep `waitMs` short, such as 20 s | the same as Codex |
| When the user closes the sign-in | `cancelLogin(user, 'claude')` | `cancelLogin(user, 'codex')` | `cancelLogin(user, 'grok')` |
| The files the CLI writes | in `~/.claude` (`CLAUDE_CONFIG_DIR`): `.credentials.json` (the tokens) and `.claude.json` (the account: email, organization, plan) | in `~/.codex` (`CODEX_HOME`): `auth.json` (access token, refresh token, last refresh time) | in `~/.grok` (`GROK_HOME`): `auth.json` (the tokens and the time they end) |

Claude Code also writes a copy of `.claude.json` in `backups/` at each start. byoa removes it and does not store it.

```flow
title: The sign-in sandbox, from connectLogin to the signed-in state
nodes:
  - step: Remove an unfinished earlier sign-in
    files: out
    text: "`connectLogin(user, h)` destroys this user's earlier sign-in sandbox for the harness, if one waits."
  - step: Create the sign-in sandbox
    text: "storedLogin: no volume. cliLogin: the user's volume at `~/.claude`, `~/.codex` or `~/.grok`."
    time: 15 min at most
  - step: Install the pinned CLI and start its sign-in
    text: "`claude auth login`, `codex login --device-auth` or `grok login --device-auth`, in the background"
  - if: Is the lab's page shown within 30 s?
    side:
      end: Destroy it, and throw an error
      label: "no"
      text: Also when the CLI exits at once.
  - step: The user signs in on the lab's page
    text: Your app shows the link, and the code of Codex or Grok Build. From now on, the sandbox lives only while your app checks in.
    time: 2 min after the last check-in
  - id: finish
    step: Your app calls finishLogin
    text: "Claude Code: with the code from Anthropic's page, byoa types it in; with no code, the call only checks in. Each call keeps the sandbox 2 more minutes."
    time: "waits: Claude with a code 60 s, else waitMs (default 0)"
  - if: Has the CLI ended?
    side:
      step: Answer 'pending'
      label: "no"
      text: The sandbox keeps running.
      time: until 15 min
      back: finish
      back-label: call again
  - if: Did the CLI write its token file?
    files: in
    side:
      end: Destroy it, and return the CLI's error
      label: "no"
      text: For example, a wrong code.
  - step: Keep the login
    text: "storedLogin: byoa encrypts the files into `ailogin/<user>/<h>`. cliLogin: they stay in the volume."
  - end: "Destroy the sandbox. The state is 'signed-in'."
    files: out
    text: "`login/<user>/<h>`"
```

- **The user closes the sign-in.** Call `agents.cancelLogin(user, harness)`. byoa destroys the sign-in sandbox at once. Nothing happens when no sign-in runs. `signOut` and a new `connectLogin` for the same user and harness also end an unfinished sign-in.
- **Your app stops calling `finishLogin`** (the user left, or your backend died). On E2B and Daytona, the provider ends the sandbox 2 minutes after the last check-in, with any login files in it. Instabox cannot change a sandbox's time after it starts, so there an unfinished sign-in ends after 15 minutes, unless you call `cancelLogin`.
- `finishLogin` after the sandbox is gone, or after 15 minutes, answers "the sign-in ran out; start it again".
- The to-do example's `page.html` checks in, and sends `cancelLogin` when the user closes the sign-in or the page.
- The state (`agents.loginState(user, h)`) is `signed-in`, `signed-out` or `expired`, with no token in it.

## Where the login stays between jobs

| | In your app's database (the default, `storedLogin()`) | In a volume of the user (`cliLogin`) |
|---|---|---|
| How it gets there | byoa reads the CLI's files from the sign-in sandbox and encrypts them together with AES-256-GCM, with your `encryptionKey` or the key you give `storedLogin`. The entry's name is part of the encryption, so the entry cannot be moved to another user. | The sign-in sandbox mounts the user's volume at `~/.claude` or `~/.codex`, and the CLI writes its files there. |
| Where it is | one entry for each user and harness, `ailogin/<user>/<harness>`, as `v1.<iv>.<ciphertext>`. It is the only copy between jobs. | the volume `byoa-<app>-<harness>-<first 24 hex of sha256(user)>`, with the files as the CLI wrote them |
| In a job | byoa copies the files in and takes them out again (below). | Every job sandbox of that user and harness mounts the same volume. byoa never reads or copies the files. The store keeps only the state. |
| Providers | all | providers with volumes: E2B (when volumes are on for your team) and Daytona, not Instabox |

To keep the logins in a table of their own, with a key of their own, so that you can give them their own access rules and backups, see [Stores and Convex](stores.md#a-table-of-its-own-for-the-ai-logins). To use the volume, pass `login: cliLogin` (from `@madeyexz/byoa`).

The labs' published terms limit where these tokens may be stored. Each app checks them: see [Lab rules](lab-rules.md).

## One job, step by step

This is a job with the default `storedLogin()`. First byoa checks that the store has the user's login. If it does not, the job stops with `LoginError` (in `run`, an `error` event with code `signed-out`) and the state becomes `signed-out`. `close()` runs steps 4 to 7, also when the job failed.

1. **Take the lease.** Two sandboxes must not refresh one login at the same time, because the CLIs rotate their refresh tokens. byoa writes the lease `ailoginlease/<user>/<harness>` with compare-and-set. By default, the jobs of one user and harness share the lease while the login is not due for a refresh (see [Jobs at the same time](#jobs-at-the-same-time-the-shared-login)). When a job must wait, it waits in line, in the order the jobs came (`ailoginline/<user>/<harness>`), and `onWait` gets `{ for: 'login', ahead }`. It waits with no time limit, unless you set `storedLogin({ waitMs })`. The lease ends by itself after the job timeout + 5 minutes, so a lost backend does not lock it.
2. **Copy the login in.** byoa decrypts the entry in your backend and writes the files into the job's sandbox, `chmod 600`. It remembers which version of the entry it read, and writes a loan record for this sandbox (`ailoginloan/<user>/<harness>/<sandbox>`). It also starts a watcher in the sandbox: at the job timeout + 45 s, the watcher removes the login files, before the provider pauses the sandbox at the job timeout + 1 minute. `CLAUDE_CONFIG_DIR` or `CODEX_HOME` points the CLI at the files: a folder path, not a token.
3. **The CLI runs, and may refresh.** The unmodified CLI uses its tokens to reach the lab. When its access token is due, it refreshes it and writes its own files again. About every 60 s, byoa saves what the CLI changed (a checkpoint), as in step 4.
4. **Save back what changed.** If the files changed, byoa encrypts them and writes them over the entry, only if the entry is still the version from step 2 (compare-and-set). If the user signed in again meanwhile, the newer entry stays. byoa saves files from a sandbox only when they are the same account's login and not older than the stored one, because the agent can change any file.
5. **Remove the files.** byoa deletes the login files, Claude's backups and the loan record. If it cannot delete the files, it destroys the sandbox instead of keeping it.
6. **Give the lease back.** The next job of this user and harness can take it. This also happens when step 4 or 5 fails.
7. **Pause or destroy the sandbox.** With `sandboxPer: 'user'` (the default), byoa pauses the user's kept sandbox for the next job, with no login in it. With `'job'`, it destroys the sandbox.

With `cliLogin` there is no lease and no copy. The volume is mounted in the job's sandbox, the CLI refreshes the files in place, and byoa saves nothing back and removes nothing.

When your backend dies during step 3, `close()` never runs. The watcher, the checkpoints and the loan record then keep the login safe and up to date: [Sandbox lifecycle](sandbox-lifecycle.md#when-your-backend-dies-during-a-job) shows how.

## Jobs at the same time: the shared login

By default, the jobs of one user and harness share the login, for Claude Code, Codex and Grok Build. Each job gets its own copy in its own sandbox (a `sandboxKey` for each job, or `sandboxPer: 'job'`), and the jobs run at the same time. Jobs in one sandbox still run one after the other: see [Running agents](running-agents.md#jobs-at-the-same-time).

```flow
title: How a job takes the shared login
nodes:
  - if: Will the CLI refresh the login before this job could end?
    then: no
    text: Within the lease time, the job timeout + 5 min
    side:
      step: Hold the login alone
      label: yes, or not known
      text: The job marks that it waits, so no new job joins. When the sharing jobs end, it takes the lease alone. The CLI refreshes, step 4 saves the new login, and the jobs after it share again.
      time: "lease: { alone: { id, until } }, after want"
  - end: Share the login
    text: The job adds itself to the lease's shared list and gets its own copy of the login. More jobs can join.
    time: "lease: { shared: { job1: until, job2: until } }"
```

- To answer the question, byoa reads only the time the access token ends from the login files, and no token: `expiresAt` in Claude Code's `.credentials.json`, the token's `exp` in Codex's `auth.json`, `expires_at` in Grok Build's `auth.json`. The CLIs refresh about 5 minutes before their access token ends. Claude Code's token lasts 8 hours, Codex's 10 days, Grok Build's 6 hours. When Codex's `auth.json` has no such time, byoa uses 8 days after the last refresh. When byoa cannot tell, the answer is yes.
- If two sharing jobs both save a change, the first save wins (step 4).
- One risk stays: the CLIs also refresh when the lab answers 401 to a token that has not run out. If two sandboxes get that answer at the same time, both refresh, one refresh fails, and the user may have to sign in again.
- To hold the login one job at a time instead, pass `login: storedLogin({ parallel: false })`.

## OpenCode Go: a key, not a sign-in (beta)

**Beta.** No real OpenCode Go key has run this yet. byoa's tests use a stand-in for OpenCode's API, with the real Claude Code and Codex, locally and on E2B. The real check ([V20](../SPEC.md#verification)) has not run.

OpenCode Go is OpenCode's subscription. byoa uses it as a plan, not a harness: it does not run the `opencode` CLI. It gives open models and others, such as Kimi, GLM, DeepSeek, Qwen and MiniMax, and the job still runs the unmodified `claude` or `codex`.

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

## Sign-out

`agents.signOut(user, harness)` deletes the user's kept sandboxes for this harness, signs out with the CLI so that the lab can revoke the login, and deletes the login.

```flow
title: Sign-out, with the default storedLogin
nodes:
  - step: Destroy the user's kept sandboxes for this harness
    files: out
    text: "`signOut(user, h)` calls `deleteSandbox(user, { harness: h })`. A job in one of them ends."
  - if: Is a login stored?
    text: "`ailogin/<user>/<h>`"
    side:
      step: Skip the CLI sign-out
      label: "no"
      join: delete
  - step: Sign out with the CLI in a new sandbox
    files: in
    text: Takes the login lease alone, writes the files in, and runs `claude auth logout`, `codex logout` or `grok logout`, so that the lab can revoke the login. If this fails, byoa goes on.
    time: [5 min, not kept, waits in line for the lease]
  - step: Destroy it, give the lease back
    files: out
  - id: delete
    end: "Delete the stored login. The state is 'signed-out'."
    text: "`ailogin/<user>/<h>` is deleted."
```

With `cliLogin`, sign-out also destroys an unfinished sign-in sandbox, signs out in a sandbox that mounts the user's volume, and deletes the volume.
