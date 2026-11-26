# AI-native mail: an example app on byoa

A simple Notion Mail: the user's own Claude Code, Codex or Grok Build triages their Gmail inbox in a sandbox and drafts replies. **Try it live at [byoa.rippling.computer/demo](https://byoa.rippling.computer/demo)**, on a sample inbox (below). Each message gets one label: `AI/Sign-in` (codes, magic links, password resets, login alerts, with the code shown in the app), `AI/Spam` (including phishing, from the SPF, DKIM and DMARC results), `AI/Needs reply`, `AI/Receipt`, `AI/Newsletter` or `AI/FYI`, and also `AI/Triaged`, so the next job skips it. For each `AI/Needs reply` message, the agent saves a reply in the user's own style (from their last sent mail) as a Gmail draft in that thread. It never sends: the user reviews and sends the draft in Gmail.

The agent gets five tools of this app (byoa's `tools` option, R2.7) and `access: 'read-only'` (R5.6): `list_inbox`, `read_message`, `label_message`, `my_sent_mail` and `save_draft`. It cannot delete, send or forward mail, and it never gets a Google token: the backend holds the user's Google refresh token, encrypted in its own SQLite, and calls the Gmail API. **Undo labels and drafts** removes every `AI/` label and every draft the app saved. With `ARCHIVE_SPAM=1`, spam also leaves the inbox (it stays in All Mail), and undo puts it back.

## The files

| File | What it does |
|---|---|
| [app.ts](app.ts) | The backend as one fetch handler: `createAgents` with the mail tools, the triage job, undo, and the routes. |
| [triage.ts](triage.ts) | What the app and the hosted demo share: the agent's instructions, the categories, and the mail tools' names, descriptions and inputs. |
| [gmail.ts](gmail.ts) | The Google sign-in (scope `gmail.modify`) and the Gmail API calls. Knows nothing about byoa. |
| [store.ts](store.ts) | byoa's store adapter for SQLite (the same as in `examples/todo`). |
| [main.ts](main.ts) | Starts the server on Node, an optional Cloudflare tunnel for the proxy, and an optional timer that triages with no one at the page. |
| [page.html](page.html) | The page: connect Gmail, sign in to the AI plan, triage, undo, and the decisions. |
| [mail.test.ts](mail.test.ts) | Tests with byoa's fake harness and a fake Gmail. |
| [demo.html](demo.html), [convex/](convex) | The hosted demo: a static page and its Convex backend (below). |
| [demo.test.ts](demo.test.ts) | The demo's limits, mail tools, sign-out and Delete my data on convex-test. |

## Google setup (once per app)

1. In Google Cloud, create a project and enable the Gmail API.
2. OAuth consent screen: user type **External**, publishing status **Testing**, and add each user's Gmail address as a test user. Add the scope `https://www.googleapis.com/auth/gmail.modify`. In testing mode Google needs no app verification, and a refresh token lasts 7 days; after that the app shows `expired` and the user connects Gmail again.
3. Credentials: create an **OAuth client ID** of type **Web application**, with the redirect URI `<PUBLIC_URL>/google/callback`.

## Run it

You need Node 22.18 or later. From the root of this repository:

```sh
npm ci
cd examples/mail && npm install
BYOA_KEY=$(openssl rand -base64 32) GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm start
```

| Variable | Default | What it is |
|---|---|---|
| `BYOA_KEY` | (required) | 32 random bytes as base64. Encrypts byoa's state and the Google refresh tokens. Keep it the same between restarts. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | (required) | The OAuth client of the Google setup. |
| `SANDBOX` | `local` | `local`, `e2b` (needs `E2B_API_KEY`), `daytona` (needs `DAYTONA_API_KEY`) or `instabox` (needs `INSTABOX_API_KEY`; `INSTABOX_SNAPSHOT` optional). |
| `PUBLIC_URL` | `http://127.0.0.1:$PORT` | Where the browser reaches the app; Google's redirect URI is under it. |
| `PROXY_URL`, `TUNNEL` | | Where a remote sandbox reaches byoa's proxy. `TUNNEL=1` starts a Cloudflare quick tunnel (needs `cloudflared`). |
| `ARCHIVE_SPAM` | off | `1`: spam also leaves the inbox. |
| `MAX` | `25` | Messages one job looks at, at most. |
| `TRIAGE_EVERY_MIN`, `HARNESS` | off, `codex` | Triage each connected user's new mail on a timer, with no one at the page. |
| `GMAIL_REFRESH_TOKEN`, `GMAIL_USER` | | A refresh token from elsewhere (such as Google's OAuth Playground) for the user `GMAIL_USER` (default `me`). |

## The hosted demo

[byoa.rippling.computer/demo](https://byoa.rippling.computer/demo) is this app for strangers, as a mail client on a sample inbox of 12 made-up messages ([convex/sample.ts](convex/sample.ts)), with no Google account. A visitor signs in with their own Claude, ChatGPT or Grok plan, on the lab's own page, and their own, unmodified Claude Code, Codex or Grok Build labels each message and drafts replies with the same tools and instructions as the app ([triage.ts](triage.ts)). The visitor picks the agent, not the task.

The page, [demo.html](demo.html), is static: `site/build.mjs` copies it to the site, and it talks to a Convex deployment with Convex's browser client. The backend is in [convex/](convex):

| File | What it does |
|---|---|
| [demo.ts](convex/demo.ts) | What the page reads and starts, and the limits (below). Jobs wait in a line in the database. |
| [agents.ts](convex/agents.ts) | byoa's calls that need a sandbox, as Node actions: the sign-in, the job (its events go to a table that the page reads live), sign-out, and forgetting a visitor. |
| [lib.ts](convex/lib.ts) | `createAgents` with `convexStore` and the mail tools on the visitor's copy of the inbox ([mail.ts](convex/mail.ts)). |
| [http.ts](convex/http.ts) | byoa's proxy as an HTTP action, at `<deployment>.convex.site/byoa/mcp`: the job's agent calls the mail tools there. |
| [crons.ts](convex/crons.ts) | Every minute: ends sign-ins the page left, fails jobs whose action died, forgets visitors, starts jobs in line. |
| [track.ts](convex/track.ts) | Usage events to PostHog. |

Each visitor is a random id that the page keeps (128 bits): it is the only key to that visitor's AI login and inbox. The limits, as the deployment's environment variables:

| Variable | Default | What it is |
|---|---|---|
| `BYOA_KEY` | (required) | 32 random bytes as base64. Encrypts the visitors' AI logins in the deployment. |
| `SANDBOX` | `e2b` | `e2b` (needs `E2B_API_KEY`) or `instabox` (needs `INSTABOX_API_KEY`). Instabox's free plan allows one sandbox in all; E2B's free plan runs 10 at a time. |
| `MAX_SANDBOXES` | `10` | Sandboxes at the same time, sign-ins and jobs together. The live demo uses 5, because it shares its E2B account (10 at a time on the free plan) with another demo. |
| `SIGNIN_PLACES` | `2` | Of those, the places only sign-ins may use, because the lab's sign-in code expires. Jobs wait in line, and the page shows how many are ahead. |
| `BUDGET_HOURS` | `5` | Sandbox hours each day (UTC). Then no new sign-in or job until the next day. |
| `PER_HOUR` | `6` | Jobs, and sign-ins, for each visitor each hour. A visitor has one job at a time. A job has at most 5 minutes. |
| `POSTHOG_KEY` | | A PostHog project's public key: `demo_signin_started`, `demo_signin_finished`, `demo_job` (harness, ok, labels, seconds waited and run) and `demo_refused`. The page itself counts its views with the site's PostHog snippet, and sends `demo_signin_clicked` (harness) and `demo_job_finished` (harness, ok) from the browser with the same visitor id as its page views, so that a funnel joins them. |
| `FAKE` | off | `1` also offers byoa's fake harness (no model), to check the deployment end to end with no AI plan. Not for the public demo. |

The demo keeps a visitor's AI logins (byoa's default `storedLogin()`), encrypted, until one of these, and the labs' terms restrict this; see the [Lab rules](../../SPEC.md#lab-rules):

- **Sign out** (in Accounts, for each connected lab; `agents.signOut`): byoa's `signOut` for that visitor and lab. It signs out with the lab's CLI, so the lab can revoke the login, and deletes the stored login and that lab's sandbox.
- **Delete my data** (in the sidebar; `agents.deleteData`): signs out of each lab the same way, ends a sign-in that has not finished, and deletes the visitor's sandboxes, labels, drafts, jobs, the agent's events and the visitor row at once. The page then forgets its visitor id and starts again.
- One hour after the visitor's last request, the sweep does the same as Delete my data.

Sign out and Delete my data refuse while the visitor's job waits in line or runs (for Sign out, a job of that lab), because they end its sandbox; a job ends within 5 minutes.

To deploy your own: create a Convex project, set the variables (`npx convex env set`), run `npm run deploy` with its `CONVEX_DEPLOY_KEY`, and put its URLs in `CONVEX` and `SITE` at the top of demo.html's script.

**What it costs** (E2B, $0.1656 an hour for 2 vCPU and 4 GiB, from the [cost FAQ](../../docs/faq.md#what-does-an-ai-job-cost-with-byoa-and-with-an-api-key)): a sign-in takes about 1 to 3 minutes of sandbox time, and a job on 12 messages about 2 to 5 minutes. 200 sign-ins and 450 jobs a month are about 25 to 45 hours, about $4 to $7.50 a month, which E2B's one-time $100 free credit pays for more than a year. `BUDGET_HOURS=5` limits the worst month to 150 hours, about $25. Convex's free plan covers the backend.

## Test it

```sh
npm test         # the fake harness, the local sandbox and a fake Gmail; the demo's rules on convex-test
npm run typecheck   # the app and convex/
```

As in `examples/todo`, the page sends the user's name in an `x-user` header: a stand-in, not a sign-in.
