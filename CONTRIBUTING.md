# Contributing to byoa

Thank you for your help. This file tells you how to make a change that we can accept.

byoa is at an early stage. The requirements are in [SPEC.md](SPEC.md). The library code is new, so some steps here will change.

## Before you start

1. Read [SPEC.md](SPEC.md). It says what version 1 must do (R1 to R7) and how we check it (V1 to V16).
2. Read the [lab rules](SPEC.md#lab-rules). We cannot accept a change that breaks them.
3. For a large change, open an issue first. Tell us the problem and the requirement it is about. This prevents work that we cannot accept.

## Each change maps to the spec

- Each change must map to a requirement (R*) and a check (V*) in SPEC.md. Write both in the pull request.
- If no requirement covers your change, change SPEC.md first, in a separate pull request. Tell us why version 1 needs it.
- Keep [README.md](README.md) and SPEC.md true. When behavior changes, update both in the same commit.

## Rules that you must not break

These rules come from the labs' terms and from SPEC.md. A pull request that breaks one is closed.

- Run only the real, unmodified `claude`, `codex` and `grok` binaries. Do not patch them, change their requests to the labs, or pretend to be another client.
- Send the user to the lab's own sign-in page. Do not collect a user's Claude, ChatGPT or Grok password or session token.
- Do not share one user's AI login between apps.
- Do not put a real MCP token in the sandbox. The sandbox gets only a short-lived job token for the proxy (R3).
- Do not add a hosted service. byoa runs only inside the app's own backend.

## Scope of version 1

Version 1 supports only these:

- Harnesses: Claude Code, Codex and Grok Build.
- Sandbox providers: E2B, Daytona and Instabox.
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

- The docs are the Markdown files in `docs/`. https://byoa.rippling.computer/docs shows them; `docs/README.md` is the docs home, and its list of pages is the site's menu. A new page goes in that list.
- README.md has only the pitch, the install, a short example and links into the docs. Put details in a docs page, not in the README.
- A fact has one source. A docs page puts in the text of another file with `<!-- include: ../FILE.md -->` or `<!-- include: ../FILE.md#section -->`: the API reference is `skills/byoa/reference/api.md`, and the lab rules are in SPEC.md.
- After a change to `docs/`, README.md, SPEC.md, `skills/byoa` or `site/`, run `cd site && npm install && node build.mjs`, and commit what it writes. `node preview.mjs` then serves the site as the Cloudflare Worker will.
- Write docs in short, simple sentences, as README.md and SPEC.md do.

### Flow diagrams

The lifecycle diagrams in the docs are ```` ```flow ```` blocks of YAML in the Markdown, so a change in behavior is a change of a few lines of text. `site/build.mjs` draws each one on the site (and as a numbered list on a phone), and writes it as text for LLMs. For example:

```yaml
title: what the diagram shows, for screen readers and LLMs
nodes:
  - step: Copy the login in          # step, if (a question), end or warn
    files: in                        # in, out or removed: the line is blue while the login files are in the sandbox
    text: more words, with `code`
    time: [job + 1 min]              # time limits
  - if: Did byoa remove the files?
    then: "yes"                      # the label of the way down (default yes)
    side: { end: Destroy it, label: "no", text: ... }   # a node to the right; back: <id> or join: <id> to draw a line on
```

A flow can also have `tabs:`, each `{ tab, text, nodes }`, as in `docs/sandbox-lifecycle.md`. The comment "flow diagrams" in `site/build.mjs` lists every key.

## Pull requests

- Keep each pull request to one change.
- In the description, write the requirement and the check that your change is about, and how you tested it.
- Do not mix a refactor with a behavior change.

## Releases

Maintainers release byoa. A tag `v<version>` that matches `version` in package.json starts `.github/workflows/release.yml`. It runs the tests and publishes `@madeyexz/byoa` to npm after a maintainer approves the run in the `npm` environment. A version that is on npm already is not published again.

- A normal version, such as `1.1.0`, goes to the npm dist-tag `latest`. `npm install @madeyexz/byoa` gets it.
- A prerelease version, such as `1.1.0-beta.1`, goes to the dist-tag `next`. `npm install @madeyexz/byoa` does not get it; `npm install @madeyexz/byoa@next` does.

To release a beta:

1. On `main`, set the version without a tag: `npm version 1.1.0-beta.1 --no-git-tag-version`. Commit package.json and package-lock.json, and merge.
2. Tag that commit and push the tag: `git tag -a v1.1.0-beta.1 -m "byoa 1.1.0-beta.1" && git push origin v1.1.0-beta.1`.
3. Approve the `release` run in GitHub Actions. Then check it: `npm view @madeyexz/byoa dist-tags` shows the beta at `next` and the last normal version at `latest`.

The next beta is `1.1.0-beta.2`. For the normal release, set `1.1.0` and tag `v1.1.0` in the same way. After it, `next` still points to the last beta; to point it to the release too, run `npm dist-tag add @madeyexz/byoa@1.1.0 next`.

## Security problems

Do not open a public issue for a security problem. See [SECURITY.md](SECURITY.md).

## License

byoa uses the [Apache License 2.0](LICENSE). When you send a contribution, it is under the same license (section 5 of the license).
