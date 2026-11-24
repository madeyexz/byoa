# AI login

A user's AI login stays encrypted in your app's database, and is in a sandbox only while a sign-in, a job or a sign-out runs. This page shows how byoa signs a user in to Claude Code and Codex, keeps the CLI's own login files, and uses them for each job.

| The login tokens are in | They are never in |
|---|---|
| the sign-in sandbox, until byoa destroys it | what byoa returns to your app |
| your app's database, encrypted | the job's environment variables |
| a job's sandbox, only while the job runs | a kept sandbox between jobs |
| | the state, lease and pending entries in the store |

This is for the default login, `storedLogin()`. With `cliLogin`, the tokens stay in the user's volume instead of the database. byoa never uses the tokens itself and never calls the labs' token endpoints. The unmodified CLI is the only client that sends them to the lab.

## Sign-in

Your app calls `agents.connectLogin(user, harness)`. byoa starts a new sandbox for up to 20 minutes, installs the pinned CLI and runs its own sign-in. The user signs in on the lab's page. byoa gives your app only that page's address and, for Codex, a code.

| | Claude Code | Codex |
|---|---|---|
| The CLI's sign-in | `claude auth login` | `codex login --device-auth` |
| What your app shows | a link on claude.com | a link on auth.openai.com, and a one-time code |
| What the user does | signs in; Anthropic's page shows a code | enters the code on OpenAI's page |
| How your app finishes | `finishLogin(user, 'claude', { code })` with that code; byoa types it into the CLI and waits up to 60 s | `finishLogin(user, 'codex', { waitMs })`, again until the state is no longer `pending` |
| The files the CLI writes | in `~/.claude` (`CLAUDE_CONFIG_DIR`): `.credentials.json` (the tokens) and `.claude.json` (the account: email, organization, plan) | in `~/.codex` (`CODEX_HOME`): `auth.json` (access token, refresh token, last refresh time) |

Claude Code also writes a copy of `.claude.json` in `backups/` at each start. byoa removes it and does not store it.

```flow
title: The sign-in sandbox, from connectLogin to the signed-in state
nodes:
  - step: Remove an unfinished earlier sign-in
    files: out
    text: "`connectLogin(user, h)` destroys this user's earlier sign-in sandbox for the harness, if one waits."
  - step: Create the sign-in sandbox
    text: "storedLogin: no volume. cliLogin: the user's volume at `~/.claude` or `~/.codex`."
    time: 20 min, then the provider deletes it
  - step: Install the pinned CLI and start its sign-in
    text: "`claude auth login` or `codex login --device-auth`, in the background"
  - if: Is the lab's page shown within 30 s?
    side:
      end: Destroy it, and throw an error
      label: "no"
      text: Also when the CLI exits at once.
  - step: The user signs in on the lab's page
    text: Your app shows the link, and Codex's code. The sandbox waits.
  - id: finish
    step: Your app calls finishLogin
    text: "Claude Code: byoa types in the code from Anthropic's page."
    time: "waits: Claude 60 s, Codex 0"
  - if: Has the CLI ended?
    side:
      step: Answer 'pending'
      label: "no"
      text: The sandbox keeps running.
      time: until 20 min
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

- If the user leaves, or your app stops calling `finishLogin`, the sandbox runs until its 20 minutes end. Then the provider deletes it, with any login files in it. This is also what happens when your backend dies.
- A new `connectLogin` for the same user and harness destroys an unfinished sign-in sooner. With the default `storedLogin()`, `signOut` does not.
- `finishLogin` after the sandbox is gone answers "the sign-in ran out; start it again".
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

1. **Take the lease.** Only one sandbox may hold a user's login at a time, because both CLIs rotate their refresh tokens. byoa writes the lease `ailoginlease/<user>/<harness>` with compare-and-set. If another job holds it, this job waits up to 10 minutes (`storedLogin({ waitMs })`), then fails. The lease ends by itself after the job timeout + 5 minutes, so a lost backend does not lock it.
2. **Copy the login in.** byoa decrypts the entry in your backend and writes the files into the job's sandbox, `chmod 600`. It remembers which version of the entry it read. `CLAUDE_CONFIG_DIR` or `CODEX_HOME` points the CLI at them: a folder path, not a token.
3. **The CLI runs, and may refresh.** The unmodified CLI uses its tokens to reach the lab. When its access token is due, it refreshes it and writes its own files again.
4. **Save back what changed.** If the files changed, byoa encrypts them and writes them over the entry, only if the entry is still the version from step 2 (compare-and-set). If the user signed in again meanwhile, the newer entry stays.
5. **Remove the files.** byoa deletes the login files and Claude's backups from the sandbox. If it cannot delete them, it destroys the sandbox instead of keeping it.
6. **Give the lease back.** The next job of this user and harness can take it. This also happens when step 4 or 5 fails.
7. **Pause or destroy the sandbox.** With `sandboxPer: 'user'` (the default), byoa pauses the user's kept sandbox for the next job, with no login in it. With `'job'`, it destroys the sandbox.

With `cliLogin` there is no lease and no copy. The volume is mounted in the job's sandbox, the CLI refreshes the files in place, and byoa saves nothing back and removes nothing.

When your backend dies during step 3, `close()` never runs. [Sandbox lifecycle](sandbox-lifecycle.md#when-your-backend-dies-during-a-job) says what then stays where.

## Codex jobs at the same time: the shared login

With `login: storedLogin({ parallel: true })`, the Codex jobs of one user can run at the same time, each in its own sandbox: a `sandboxKey` for each job, or `sandboxPer: 'job'`. Claude Code jobs still run one at a time, because when Claude Code refreshes is not checked yet.

```flow
title: How a Codex job takes the shared login
nodes:
  - if: Will Codex refresh the login before this job could end?
    then: no
    text: Within the lease time, the job timeout + 5 min
    side:
      step: Hold the login alone
      label: yes, or not known
      text: The job marks that it waits, so no new job joins. When the sharing jobs end, it takes the lease alone. Codex refreshes, step 4 saves the new login, and the jobs after it share again.
      time: "lease: { alone: { id, until } }, after want"
  - end: Share the login
    text: The job adds itself to the lease's shared list and gets its own copy of the login. More jobs can join.
    time: "lease: { shared: { job1: until, job2: until } }"
```

- To answer the question, byoa reads only the time the access token ends in `auth.json`, and no token. Codex refreshes 5 minutes before its access token ends, and that token lasts 10 days. When `auth.json` has no such time, byoa uses 8 days after the last refresh. When byoa cannot tell, the answer is yes.
- If two sharing jobs both save a change, the first save wins (step 4).
- One risk stays: Codex also refreshes when OpenAI answers 401 to a token that has not run out. If two sandboxes get that answer at the same time, both refresh, one refresh fails, and the user may have to sign in again. So sharing is your app's choice.

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
    text: Takes the login lease alone, writes the files in, and runs `claude auth logout` or `codex logout`, so that the lab can revoke the login. If this fails, byoa goes on.
    time: [5 min, not kept, "waits for the lease, max 10 min"]
  - step: Destroy it, give the lease back
    files: out
  - id: delete
    end: "Delete the stored login. The state is 'signed-out'."
    text: "`ailogin/<user>/<h>` is deleted."
```

With `cliLogin`, sign-out also destroys an unfinished sign-in sandbox, signs out in a sandbox that mounts the user's volume, and deletes the volume.
