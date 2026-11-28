# Sandbox lifecycle

This page shows every sandbox byoa creates, from creation to removal, with the default `storedLogin()`. A sandbox has the user's login files only while a sign-in, a job or a sign-out runs. When your backend dies during a job, a watcher in the sandbox removes them.

byoa creates four kinds of sandbox:

- a **sign-in sandbox** for each sign-in, which byoa never keeps. It ends at `cancelLogin`, or 2 minutes after your app's last `finishLogin` check-in, 15 minutes at most ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-in) shows its steps);
- a **job sandbox**: by default one kept sandbox for each user, harness and `sandboxKey` (a conversation is a key of its own), paused between jobs; or, with `sandboxPer: 'job'`, a new one for each job;
- a **sign-out sandbox**, for 5 minutes, where the CLI signs out ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-out));
- a **models sandbox** for each `agents.listModels` call, where the CLI lists the models of the user's plan. byoa destroys it after the list, 10 minutes at most.

## The job sandbox

Diagram: A job sandbox, from the start of a job to its end

Kept for the user (default): `sandboxPer: 'user'`: byoa keeps one sandbox for each slot, pauses it after a job and resumes it for the next.

1. Pick the user's slot. One for each user, harness and `sandboxKey` (an empty key when none; a conversation's id is its key). `usersandbox/<user>/<provider>/<h>/<key>`. Login files: no login files.
2. Question: Does another job run in this slot? If no: go on to step 3.
   - If yes: Wait in line. The jobs run in the order they came. `onWait` gets `{ for: 'sandbox', ahead }`. Time limit: no limit, unless waitMs.
3. Question: Does the slot have a sandbox? If yes: go on to step 4. If no: see "Create a new kept sandbox" below.
4. Resume it. Time limit: job + 1 min.
5. Question: Does the provider still have it? If yes: go on to step 6.
   - If no: Create a new kept sandbox. Also when it was gone (SandboxGoneError). Time limit: job + 1 min. Then go on to step 6.
6. Prepare the work folder. `~/work`: nothing of an earlier job stays. In a conversation, the agent's files stay and only byoa's own files are new; in a new sandbox, byoa writes the conversation's stored transcript back.
7. Question: Is the user signed in? a stored login exists. If yes: go on to step 8.
   - If no: Stop with LoginError. This is the end. The state becomes 'signed-out'. close() still runs.
8. Check the MCP servers, install the pinned harness.
9. Copy the login in. Takes the login lease, decrypts the files, writes them, chmod 600, and writes a loan record. If a dead job's loan record is there, it first saves what that job's CLI left. Starts the watcher. Time limit: waits in line for the lease; lease: job + 5 min; watcher: job + 45 s. Login files: login files in.
10. The harness runs. The CLI may refresh its login and write its files again. byoa saves a change about every 60 s. Login files: login files in.
   - If backend dies: Warning: If your backend dies here. close() never runs. The watcher removes the files at job + 45 s. See below.
11. close(): save back, remove the files, give the lease back. Ends the job token. Saves the files only if they changed, with compare-and-set. Removes the loan record. In a conversation, keeps the session id and a copy of its transcript, encrypted. Login files: files removed.
12. Question: Did byoa remove the files? any error here counts as no. If yes: go on to step 13.
   - If no: Destroy it, forget its id. This is the end. The next job of this slot creates a new one.
13. Pause it for the next job. This is the end. E2B: pause. Daytona, Instabox: stop. Sprites: sleep.

New for each job: `sandboxPer: 'job'`: byoa creates a sandbox for one job and destroys it after.

1. Create a new sandbox, not kept. A new work folder. Time limit: job + 1 min. Login files: no login files.
2. Question: Is the user signed in? a stored login exists. If yes: go on to step 3.
   - If no: Stop with LoginError. This is the end. The state becomes 'signed-out'. close() still runs.
3. Check the MCP servers, install the pinned harness.
4. Copy the login in. Takes the login lease, decrypts the files, writes them, chmod 600. Starts the watcher. Time limit: waits in line for the lease; lease: job + 5 min; watcher: job + 45 s. Login files: login files in.
5. The harness runs. The CLI may refresh its login and write its files again. byoa saves a change about every 60 s. Login files: login files in.
   - If backend dies: Warning: If your backend dies here. close() never runs. The watcher removes the files at job + 45 s, and the provider deletes the sandbox at job + 1 min.
6. close(): save back, remove the files, give the lease back. Ends the job token. Saves the files only if they changed, with compare-and-set. Removes the loan record. Login files: files removed.
7. Destroy the sandbox. This is the end.

"Job" is `jobTimeoutMs`, 30 minutes by default. byoa gives each job sandbox job + 1 minute.

- **One kept sandbox per user (the default).** The first job of a user and harness creates it. After each job, byoa pauses it, and the next job resumes it, so files that the app wrote there and the installed harness stay. Each job gets a new job folder (`s.work`) with its own setup. One job of a slot runs at a time; the others wait in line and run in the order they came, with no time limit unless you set `waitMs`. When the provider no longer has the sandbox, the next job creates a new one.
- **Many kept sandboxes per user.** Give each job a `sandboxKey`, such as a project or a conversation. Each key has its own kept sandbox and its own lease. See [Running agents](https://byoa.rippling.computer/docs/running-agents.md#jobs-at-the-same-time) for the ways to run one user's jobs at the same time.
- **A conversation.** Give each job of a chat the same `conversation` id. The conversation has its own kept sandbox, and the agent continues its own session there. See [What carries over between jobs](#what-carries-over-between-jobs).
- **A new sandbox for each job.** Set `sandboxPer: 'job'` in `createAgents`. Use it when nothing may stay between jobs.

In all three, the user's AI login and MCP grants stay in your database. No real MCP token goes into the sandbox, a job token is refused after its job, and no copy of the AI login stays in the sandbox between jobs.

## What carries over between jobs

"Resume" can mean two things. byoa does both:

- **Resume the sandbox.** byoa starts the user's paused sandbox again for the next job. The files outside `~/work` and the installed harness are still there. This happens in every kept sandbox.
- **Resume the conversation.** Only for a job that names a `conversation`. The harness continues its own session, so the agent knows the earlier messages and what it did. Each CLI does this its own way: Claude Code `--session-id`, then `--resume`; Codex's app server keeps the thread, then resumes it (`thread/resume`); Grok Build's agent mode names a session, then resumes it (`session/resume`). While a job runs, it also takes more messages (`job.send`, see [Running agents](https://byoa.rippling.computer/docs/running-agents.md#more-messages-while-a-job-runs-steering)).

| | A job with no `conversation` | A job of a `conversation` |
|---|---|---|
| The agent's memory of earlier jobs | none: each job is a new session | the harness's session of the earlier jobs |
| `~/work` (the job folder) | emptied at the start of each job | kept; only byoa's files (skills, AGENTS.md, the MCP config, the task) are new |
| Files outside `~/work`, the installed harness | kept in a kept sandbox | kept: the conversation has its own kept sandbox |
| The AI login | never kept in the sandbox: a copy for each job | the same |
| When the provider lost the sandbox | a new sandbox | a new sandbox, with the stored copy of the transcript, so the agent still remembers; `~/work` and the other files are gone |

After each job of a conversation, byoa keeps the harness's session id and a copy of its session files (the transcript), encrypted in your store, when they are at most `transcriptBytes` (default 700 000 bytes). A longer transcript lives only in the sandbox: when the provider loses that sandbox, the next job says so (an `error` with code `conversation`) and starts a new session. With `sandboxPer: 'job'`, each job of a conversation gets a new sandbox and resumes only from the stored copy.

## When your backend dies during a job

`close()` never runs. byoa still loses little, and no login stays in the sandbox:

Diagram: A job whose backend dies, with the default storedLogin

1. The job runs. About every 60 s, byoa saves what the CLI changed in its login (a checkpoint), with compare-and-set. The loan record `ailoginloan/<user>/<h>/<sandbox>` names the stored version this sandbox has. Login files: login files in.
2. Warning: Your backend dies. The checkpoints stop. The CLI may still refresh its login in the sandbox.
3. The watcher removes the login files. The watcher started when the login was copied in. It removes the files only if no later job replaced its marker. Time limit: job + 45 s. Login files: files removed.
4. The provider pauses or ends the sandbox. Kept: E2B pauses it at job + 1 min; Daytona stops it. New for each job: the provider deletes it. See the table below. Time limit: job + 1 min.
5. The slot and the login lease run out. So the user's next job does not wait forever. Time limit: job + 5 min.
6. Question: Does the next job in this kept sandbox find the dead job's loan record? Only with `sandboxPer: 'user'`. If yes: go on to step 7.
   - If no: Copy the stored login in, as for any job. This is the end.
7. Save what the dead job's CLI left, then copy the login in. This is the end. Only when the stored login has not changed since the loan, and the files are the same account's login and not older. Else the stored login stays. Login files: login files in.

- A refresh that the CLI made more than about a minute before your backend died is already saved. Only a refresh in the last minute before the watcher ran can be lost; then the user may have to sign in again.
- byoa saves files from a sandbox only when they are the same account's login and not older than the stored one, because the agent of a job can change any file.
- A job's waiting place in line also runs out about 30 s after its backend dies, so the jobs after it go on.
- The slot's lease: until its harness starts, a job renews it every minute, so a job that waits long for the login keeps its sandbox; from the harness's start it lasts the job timeout + 5 minutes. So the lease of a dead job runs out at most the job timeout + 5 minutes after its backend died.
- The job's time starts when it has the login, not when it resumed the sandbox: then byoa sets the sandbox's time again (E2B, Sprites, and Daytona for a sandbox of one job) and starts the watcher. So a job that waited in line for the login still gets its whole time, and the watcher still runs before the provider pauses the sandbox.

## How each provider pauses and times out

| | E2B | Daytona | Instabox | Sprites |
|---|---|---|---|---|
| After a job, a kept sandbox is | paused, with no process of the job kept | stopped | stopped (not Instabox's pause) | asleep, with no process of the job kept |
| A kept sandbox whose time ends (your backend died) | pauses at job + 1 min | stops after job + 1 min with no activity | has no time limit; pauses itself after 30 min with no activity (default) | held awake until job + 1 min, then sleeps |
| A sandbox that is not kept (sign-in, sign-out, models, new for each job) | killed at its time | deleted when it stops, at the latest after its time | deleted after its time, whatever its state | at its time, ends its processes and deletes its files; the next `create` deletes it |
| A sign-in with no check-in | ends 2 min after the last `finishLogin` | ends 2 min after the last `finishLogin` (whole minutes) | ends after 15 min: Instabox cannot change a sandbox's time after it starts | ends 2 min after the last `finishLogin` |
| Resume after it paused itself | byoa ends any old process first | started again; no old process runs | byoa resumes, stops and starts it, so no old process runs | byoa ends any old process first |
| A paused kept sandbox stays | with no time limit | until archived, after 7 days stopped | with no time limit | with no time limit |
| Volumes for `cliLogin` | yes, when volumes are on for your team | one shared volume, a subpath for each login | none: use `storedLogin()` | none: use `storedLogin()` |

## Removal

- `agents.signOut(user, h)` deletes the user's kept sandboxes for that harness, then signs out ([AI login](https://byoa.rippling.computer/docs/ai-login.md#sign-out)).
- `agents.deleteSandbox(user, { harness?, sandboxKey? })` on its own destroys each matching kept sandbox. A job in it ends. The login, the MCP grants and the conversations' stored transcripts stay.
- `agents.deleteConversation(user, conversation?)` deletes a conversation (or all of the user's): its stored session and transcript, and its kept sandbox. Call it when the user deletes a chat, and with no id when you delete the user. When you delete a user, call `agents.deleteSandbox(userId)`; when you delete a project that had a key, `agents.deleteSandbox(userId, { sandboxKey: projectId })`.
- Nothing else removes a paused kept sandbox.
