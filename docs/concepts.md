# How byoa works

**Your app brings the product. Each user brings the agent.** You build the app and pick the sandbox. Each user brings their plan and their tools. byoa runs inside your backend and runs each job in that user's own sandbox.

Think of the user's AI subscription as a battery pack, and of your app as an appliance. The user brings the battery. byoa is the plug: it connects the user's plan, and the user's tools, to the agent features of your app. Your app supplies only the place where the agent runs, the sandbox.

## Who brings what

<!-- diagram: who -->
![Who brings what: you, the developer, build the app, pick the sandbox provider and own the database. The end user signs in on the lab's own page and connects each MCP tool once. byoa runs in your backend, keeps AI logins and MCP grants in your database, and runs each job in a sandbox where the user's own Claude Code, Codex or Grok Build runs.](../.github/readme/who-light.png)

- **You, the developer**, build the app, pick the sandbox provider (E2B, Daytona or Instabox, on your own account) and own the database. You import byoa into your app's backend.
- **The end user** uses your app. They have a Claude, ChatGPT or Grok plan, and accounts in tools such as Notion or Gmail. They sign in on the lab's own page one time, and connect each MCP tool one time.
- **byoa** is a library in your backend. It keeps the user's AI login and MCP grants in your database, encrypted with your key. For each job, it gets a sandbox at your provider and runs the user's own, unmodified Claude Code, Codex or Grok Build there.
- **The AI labs** (Anthropic, OpenAI) get the model calls. The user's own plan pays for them, not your API bill.
- **The MCP servers** get the real token from byoa's proxy in your backend, never from the sandbox.

## The problem

To make an app AI-native, you run a big lab's harness (Claude Code, Codex or Grok Build) in a sandbox, with the user's own AI plan. For each app, you must build the same connection layer again:

- the user's AI login, through the real CLI;
- the user's MCP connections and their OAuth tokens, with one refresh owner;
- the user's skills and AGENTS.md;
- the harness install and its updates;
- the code that connects all of this to one sandbox provider.

byoa is that layer, as a library, so you do not build it again for each app.

## What byoa is, and what it is not

- byoa **is** a library. It runs inside your app's own backend (Node, Bun or Convex). Cloudflare Workers support is planned.
- byoa **stores tokens in your own database**, through a store adapter.
- byoa **is not** a hosted service. We do not run a server, and we never see your users' tokens.

| | Version 1 | Later |
|---|---|---|
| Agents | Claude Code, Codex, Grok Build | Gemini or Antigravity, maybe |
| User plans | Claude, ChatGPT, Grok, OpenCode Go key (beta) | |
| Sandboxes | E2B, Daytona, Instabox | other providers |
| Backends | Node, Convex actions | Cloudflare Workers |
| Token stores | Convex, Postgres, or your own with get, put, delete and compare-and-set | |

## How a job runs

Your app calls `agents.run(userId, task)`. byoa takes the user's sandbox, loads the user's setup, and runs the user's own harness on the user's own plan. The [sandbox lifecycle](sandbox-lifecycle.md) has every step and every decision.

```flow
title: One job, from agents.run to the end event
nodes:
  - step: Your app calls agents.run
    text: "`agents.run(userId, { harness, task, mcp, setup })`"
  - step: Take the user's sandbox
    text: By default, resume the user's kept sandbox (a conversation has one of its own), or create it for the first job. With `sandboxPer 'job'`, create a new one.
  - step: Load the setup
    text: The pinned harness, the skills, AGENTS.md, and an MCP config that points to your proxy with a job token.
  - step: Copy the AI login in
    files: in
    text: From your database, decrypted in your backend.
  - step: Run the harness
    text: "Text, tool calls and permission requests stream back as events. MCP calls go through the proxy."
  - end: close()
    files: removed
    text: End the job token, save the login back if the CLI changed it, remove it from the sandbox, then pause or destroy the sandbox.
```

The user's AI login and MCP grants stay in your database between jobs. A kept sandbox keeps the files that the app wrote there and the installed harness, but no login. A job of a conversation also continues the harness's session of the earlier jobs, and keeps the job folder ([what carries over](sandbox-lifecycle.md#what-carries-over-between-jobs)).

## Real tokens never go into the sandbox

The agent in the sandbox gets a short-lived job token, for one job and one user. The proxy in your backend adds the real MCP token to each request.

```flow
title: How an MCP call from the sandbox gets the real token
nodes:
  - step: The harness calls an MCP tool
    text: Its MCP config points to your proxy, at `<proxyUrl>/<name>`, with the job token. It has no real MCP token.
  - if: Is the job token good for this server?
    then: "yes"
    side:
      end: Refuse the call
      label: "no"
      text: The job ended, or the job did not get this server.
  - step: Add the real token
    text: From your database, encrypted with your key. byoa refreshes it when it is due, with one refresh owner.
  - end: Send the request on to the MCP server
    text: The answer goes back to the harness. The real token does not.
```

[MCP tools and the proxy](mcp.md) has the details, and [AI login](ai-login.md) says where the user's AI login is at each step.
