# Contributing to byoa

Thank you for your help. This file tells you how to make a change that we can accept.

byoa is at an early stage. The requirements are in [SPEC.md](SPEC.md). The library code is new, so some steps here will change.

## Before you start

1. Read [SPEC.md](SPEC.md). It says what version 1 must do (R1 to R7) and how we check it (V1 to V11).
2. Read the [lab rules](SPEC.md#lab-rules). We cannot accept a change that breaks them.
3. For a large change, open an issue first. Tell us the problem and the requirement it is about. This prevents work that we cannot accept.

## Each change maps to the spec

- Each change must map to a requirement (R*) and a check (V*) in SPEC.md. Write both in the pull request.
- If no requirement covers your change, change SPEC.md first, in a separate pull request. Tell us why version 1 needs it.
- Keep [README.md](README.md) and SPEC.md true. When behavior changes, update both in the same commit.

## Rules that you must not break

These rules come from the labs' terms and from SPEC.md. A pull request that breaks one is closed.

- Run only the real, unmodified `claude` and `codex` binaries. Do not patch them, change their requests to the labs, or pretend to be another client.
- Send the user to the lab's own sign-in page. Do not collect a user's Claude or ChatGPT password or session token.
- Do not share one user's AI login between apps.
- Do not put a real MCP token in the sandbox. The sandbox gets only a short-lived job token for the proxy (R3).
- Do not add a hosted service. byoa runs only inside the app's own backend.

## Scope of version 1

Version 1 supports only these:

- Harnesses: Claude Code and Codex.
- Sandbox providers: E2B and Daytona.
- Backends: Node and Convex. Cloudflare Workers support is planned.
- Store adapters: Convex and Postgres.

We will add other sandbox providers (for example Modal or Vercel) after version 1. Until then, open an issue before you start a new provider adapter.

## Adapters

- A sandbox provider is one adapter with one interface: create, resume, run a command, write a file, mount a volume, pause, destroy (R5.3). An adapter must not change the code outside it.
- A store adapter is a small interface: get, put, delete, compare-and-set (R6). Compare-and-set must be atomic, because the single refresh owner (R2.3) needs it.
- With each adapter, add the tests that show it passes the checks for its part of the spec.

## Tests

- V10, V11 and the fake-harness tests run on every commit. They must pass before we merge.
- V1 to V9 use real sandbox providers and real AI plans, so they cost money. Maintainers run them before each release. You do not have to run them, but tell us if your change can affect them.
- `npm run bench` (`scripts/bench.ts`) times each step of a job on real E2B or Daytona: the sandbox, the harness install, the login copy, the setup, the harness and the teardown. It uses the fake harness, or the real CLIs with no model, so it needs no plan, but it costs a little at the provider. Maintainers run it before each release, next to V4. If your change can make a job slower, run it before and after, and put both tables in the pull request.
- Use the fake harness (R7.2) for your own tests. Your tests must not need a real plan or a real sandbox.
- Do not put real tokens, keys or logins in tests, fixtures or logs.

## Docs and the website

- The page at https://byoa.rippling.computer is built from README.md. If you change README.md, rebuild the page as the files in `site/` describe.
- Write docs in short, simple sentences, as README.md and SPEC.md do.

## Pull requests

- Keep each pull request to one change.
- In the description, write the requirement and the check that your change is about, and how you tested it.
- Do not mix a refactor with a behavior change.

## Security problems

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

byoa uses the [Apache License 2.0](LICENSE). When you send a contribution, it is under the same license (section 5 of the license).
