# Sandbox lifecycle

This page shows every sandbox byoa creates, from creation to removal, with the default `storedLogin()`. A sandbox has the user's login files only while a sign-in, a job or a sign-out runs, unless your backend dies during a job.

byoa creates three kinds of sandbox:

- a **sign-in sandbox** for each sign-in, which byoa never keeps ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-in) shows its steps);
- a **job sandbox**: by default one kept sandbox for each user, harness and `sandboxKey`, paused between jobs; or, with `sandboxPer: 'job'`, a new one for each job;
- a **sign-out sandbox**, for 5 minutes, where the CLI signs out ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-out)).

## The job sandbox

Diagram: A job sandbox, from the start of a job to its end

Kept for the user (default): `sandboxPer: 'user'`: byoa keeps one sandbox for each slot, pauses it after a job and resumes it for the next.

1. Pick the user's slot. One for each user, harness and `sandboxKey` (an empty key when none). `usersandbox/<user>/<provider>/<h>/<key>`. Login files: no login files.
2. Question: Does another job run in this slot? If no: go on to step 3.
   - If yes: Wait, then try again. Time limit: max 10 min (waitMs), then an error.
3. Question: Does the slot have a sandbox? If yes: go on to step 4. If no: see "Create a new kept sandbox" below.
4. Resume it. Time limit: job + 1 min.
5. Question: Does the provider still have it? If yes: go on to step 6.
   - If no: Create a new kept sandbox. Also when it was gone (SandboxGoneError). Time limit: job + 1 min. Then go on to step 6.
6. Empty the work folder. `~/work`: nothing of an earlier job stays.
7. Question: Is the user signed in? a stored login exists. If yes: go on to step 8.
   - If no: Stop with LoginError. This is the end. The state becomes 'signed-out'. close() still runs.
8. Check the MCP servers, install the pinned harness.
9. Copy the login in. Takes the login lease, decrypts the files, writes them, chmod 600. Time limit: waits for the lease, max 10 min; lease: job + 5 min. Login files: login files in.
10. The harness runs. The CLI may refresh its login and write its files again. Login files: login files in.
   - If backend dies: Warning: If your backend dies here. close() never runs. The files stay in the kept sandbox. See below.
11. close(): save back, remove the files, give the lease back. Ends the job token. Saves the files only if they changed, with compare-and-set. Login files: files removed.
12. Question: Did byoa remove the files? any error here counts as no. If yes: go on to step 13.
   - If no: Destroy it, forget its id. This is the end. The next job of this slot creates a new one.
13. Pause it for the next job. This is the end. E2B: pause. Daytona, Instabox: stop.

New for each job: `sandboxPer: 'job'`: byoa creates a sandbox for one job and destroys it after.

1. Create a new sandbox, not kept. A new work folder. Time limit: job + 1 min. Login files: no login files.
2. Question: Is the user signed in? a stored login exists. If yes: go on to step 3.
   - If no: Stop with LoginError. This is the end. The state becomes 'signed-out'. close() still runs.
3. Check the MCP servers, install the pinned harness.
4. Copy the login in. Takes the login lease, decrypts the files, writes them, chmod 600. Time limit: waits for the lease, max 10 min; lease: job + 5 min. Login files: login files in.
5. The harness runs. The CLI may refresh its login and write its files again. Login files: login files in.
   - If backend dies: Warning: If your backend dies here. close() never runs. The provider deletes the sandbox at job + 1 min, with the files.
6. close(): save back, remove the files, give the lease back. Ends the job token. Saves the files only if they changed, with compare-and-set. Login files: files removed.
7. Destroy the sandbox. This is the end.

"Job" is `jobTimeoutMs`, 30 minutes by default. byoa gives each job sandbox job + 1 minute.

- **One kept sandbox per user (the default).** The first job of a user and harness creates it. After each job, byoa pauses it, and the next job resumes it, so files that the app wrote there and the installed harness stay. Each job gets a new job folder (`s.work`) with its own setup. One job of a slot runs at a time; another job waits for it (`waitMs`, default 10 minutes). When the provider no longer has the sandbox, the next job creates a new one.
- **Many kept sandboxes per user.** Give each job a `sandboxKey`, such as a project or a conversation. Each key has its own kept sandbox and its own lease. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#jobs-at-the-same-time) for what still runs one at a time.
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

- `agents.signOut(user, h)` deletes the user's kept sandboxes for that harness, then signs out ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-out)).
- `agents.deleteSandbox(user, { harness?, sandboxKey? })` on its own destroys each matching kept sandbox. A job in it ends. The login and the MCP grants stay. When you delete a user, call `agents.deleteSandbox(userId)`; when you delete a project that had a key, `agents.deleteSandbox(userId, { sandboxKey: projectId })`.
- Nothing else removes a paused kept sandbox.
