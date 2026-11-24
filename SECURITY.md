# Security

byoa handles your users' AI logins and their MCP tokens. A bug in byoa can give an attacker access to a user's Notion, Gmail or AI plan. Please tell us about each security problem that you find.

## Report a problem

- Do not open a public issue, pull request or discussion.
- Use GitHub's private report: go to the **Security** tab of this repository and click **Report a vulnerability**.
- Tell us what the problem is, how to make it occur, and what an attacker can get.
- Do not put a real user's tokens or data in the report. Use test accounts.

We will reply within 7 days. We will tell you when we fix the problem, and we will give you credit if you want it.

## Supported versions

We fix security problems in the latest release on npm (`@madeyexz/byoa`).

## Where secrets are kept

This is how byoa must keep each secret (see [SPEC.md](SPEC.md)). If byoa does not do this, it is a security problem.

| Secret | Where it is | Where it must never be |
|---|---|---|
| The user's Claude or ChatGPT login | By default in the app's own database, encrypted with a key that the app gives (R1.4), or as an option in a volume of that one user (R1.5); in a sandbox only while a sign-in, a job or a sign-out runs | In a sandbox between jobs, in another app, or with us |
| MCP grants (access and refresh tokens) | In the app's own database, encrypted with a key that the app gives (R2.4) | In the sandbox (R3.3), in logs, or with us |
| Job token | In the sandbox's `mcp.json`, for one job and one user (R3.1) | Valid after the job ends (R3.4) |

The real MCP token goes only from the app's backend to the MCP server, through the proxy (R3.2). byoa is not a hosted service, so we never get your users' tokens.

## What we count as a security problem

For example:

- A real MCP token is in the sandbox's environment, files or processes (V5).
- The proxy accepts a job token after its job ends (V6), or for a different user.
- byoa keeps a copy of a user's AI login in a sandbox between jobs, stores it without encryption, or one app can use another app's login.
- Two refreshes at the same time revoke a grant, or byoa sends a refresh request from a place other than the app's backend (R2.3).
- byoa stores a grant without encryption, or writes a token to a log.
- byoa runs a `claude` or `codex` binary that is not the published one (V11).

## What is not ours

Report these to their owners:

- Bugs in a sandbox provider (E2B, Daytona, Instabox), in Claude Code or Codex, or in an MCP server.
- Bugs in an app that uses byoa, for example a leaked encryption key or a database that is open to the internet. The app must keep its encryption key secret and keep the proxy in its own backend.
