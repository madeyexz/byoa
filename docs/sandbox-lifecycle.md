# Sandbox lifecycle

This page shows every sandbox byoa creates, from creation to removal, with the default `storedLogin()`. A sandbox has the user's login files only while a sign-in, a job or a sign-out runs, unless your backend dies during a job.

byoa creates three kinds of sandbox:

- a **sign-in sandbox** for each sign-in, which byoa never keeps ([AI login](ai-login.md#sign-in) shows its steps);
- a **job sandbox**: by default one kept sandbox for each user, harness and `sandboxKey`, paused between jobs; or, with `sandboxPer: 'job'`, a new one for each job;
- a **sign-out sandbox**, for 5 minutes, where the CLI signs out ([AI login](ai-login.md#sign-out)).

## The job sandbox

```flow
title: A job sandbox, from the start of a job to its end
tabs:
  - tab: Kept for the user (default)
    text: "`sandboxPer: 'user'`: byoa keeps one sandbox for each slot, pauses it after a job and resumes it for the next."
    nodes:
      - step: Pick the user's slot
        files: out
        text: "One for each user, harness and `sandboxKey` (an empty key when none). `usersandbox/<user>/<provider>/<h>/<key>`"
      - if: Does another job run in this slot?
        then: "no"
        side:
          step: Wait, then try again
          label: "yes"
          time: max 10 min (waitMs), then an error
      - if: Does the slot have a sandbox?
        goto: { to: create, label: "no" }
      - step: Resume it
        time: job + 1 min
      - if: Does the provider still have it?
        side:
          id: create
          step: Create a new kept sandbox
          label: "no"
          text: Also when it was gone (SandboxGoneError).
          time: job + 1 min
          join: work
      - id: work
        step: Empty the work folder
        text: "`~/work`: nothing of an earlier job stays"
      - if: Is the user signed in?
        text: a stored login exists
        side:
          end: Stop with LoginError
          label: "no"
          text: "The state becomes 'signed-out'. close() still runs."
      - step: Check the MCP servers, install the pinned harness
      - step: Copy the login in
        files: in
        text: Takes the login lease, decrypts the files, writes them, chmod 600.
        time: ["waits for the lease, max 10 min", "lease: job + 5 min"]
      - step: The harness runs
        files: in
        text: The CLI may refresh its login and write its files again.
        side:
          warn: If your backend dies here
          label: backend dies
          text: close() never runs. The files stay in the kept sandbox. See below.
      - step: "close(): save back, remove the files, give the lease back"
        files: removed
        text: Ends the job token. Saves the files only if they changed, with compare-and-set.
      - if: Did byoa remove the files?
        text: any error here counts as no
        side:
          end: Destroy it, forget its id
          label: "no"
          text: The next job of this slot creates a new one.
      - end: Pause it for the next job
        text: "E2B: pause. Daytona, Instabox: stop."
  - tab: New for each job
    text: "`sandboxPer: 'job'`: byoa creates a sandbox for one job and destroys it after."
    nodes:
      - step: Create a new sandbox, not kept
        files: out
        text: A new work folder.
        time: job + 1 min
      - if: Is the user signed in?
        text: a stored login exists
        side:
          end: Stop with LoginError
          label: "no"
          text: "The state becomes 'signed-out'. close() still runs."
      - step: Check the MCP servers, install the pinned harness
      - step: Copy the login in
        files: in
        text: Takes the login lease, decrypts the files, writes them, chmod 600.
        time: ["waits for the lease, max 10 min", "lease: job + 5 min"]
      - step: The harness runs
        files: in
        text: The CLI may refresh its login and write its files again.
        side:
          warn: If your backend dies here
          label: backend dies
          text: close() never runs. The provider deletes the sandbox at job + 1 min, with the files.
      - step: "close(): save back, remove the files, give the lease back"
        files: removed
        text: Ends the job token. Saves the files only if they changed, with compare-and-set.
      - end: Destroy the sandbox
```

"Job" is `jobTimeoutMs`, 30 minutes by default. byoa gives each job sandbox job + 1 minute.

- **One kept sandbox per user (the default).** The first job of a user and harness creates it. After each job, byoa pauses it, and the next job resumes it, so files that the app wrote there and the installed harness stay. Each job gets a new job folder (`s.work`) with its own setup. One job of a slot runs at a time; another job waits for it (`waitMs`, default 10 minutes). When the provider no longer has the sandbox, the next job creates a new one.
- **Many kept sandboxes per user.** Give each job a `sandboxKey`, such as a project or a conversation. Each key has its own kept sandbox and its own lease. See [Running agents](running-agents.md#jobs-at-the-same-time) for what still runs one at a time.
- **A new sandbox for each job.** Set `sandboxPer: 'job'` in `createAgents`. Use it when nothing may stay between jobs.

In all three, the user's AI login and MCP grants stay in your database. No real MCP token goes into the sandbox, a job token is refused after its job, and no copy of the AI login stays in the sandbox between jobs.

## When your backend dies during a job

- `close()` never runs, so byoa does not save the login back or remove the files.
- **Kept sandbox:** the login files stay inside until the next job of the same slot resumes it. The provider pauses or stops it later; on Instabox, it runs until 30 minutes with no activity. See the table below.
- If the CLI refreshed its login during that job, the new login is lost. The next job writes the older stored copy over the files. Because both CLIs rotate their refresh tokens, the next refresh may then fail.
- **New sandbox for each job:** the provider deletes the sandbox at job + 1 minute, with the files.
- The slot and the login lease end by themselves after job + 5 minutes, so the user's next job does not wait forever.

## How each provider pauses and times out

| | E2B | Daytona | Instabox |
|---|---|---|---|
| After a job, a kept sandbox is | paused, with no process of the job kept | stopped | stopped (not Instabox's pause) |
| A kept sandbox whose time ends (your backend died) | pauses at job + 1 min | stops after job + 1 min with no activity | has no time limit; pauses itself after 30 min with no activity (default) |
| A sandbox that is not kept (sign-in, sign-out, new for each job) | killed at its time | deleted when it stops, at the latest after its time | deleted after its time, whatever its state |
| Resume after it paused itself | byoa ends any old process first | started again; no old process runs | byoa resumes, stops and starts it, so no old process runs |
| A paused kept sandbox stays | with no time limit | until archived, after 7 days stopped | with no time limit |
| Volumes for `cliLogin` | yes, when volumes are on for your team | one shared volume, a subpath for each login | none: use `storedLogin()` |

## Removal

- `agents.signOut(user, h)` deletes the user's kept sandboxes for that harness, then signs out ([AI login](ai-login.md#sign-out)).
- `agents.deleteSandbox(user, { harness?, sandboxKey? })` on its own destroys each matching kept sandbox. A job in it ends. The login and the MCP grants stay. When you delete a user, call `agents.deleteSandbox(userId)`; when you delete a project that had a key, `agents.deleteSandbox(userId, { sandboxKey: projectId })`.
- Nothing else removes a paused kept sandbox.
