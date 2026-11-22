# byoa

An open-source library that lets an app run its users' own Claude Code or Codex in any sandbox, with their MCP connections and skills. It runs inside the app's own backend. It is never a hosted service.

- Read `SPEC.md` before you change anything. Every change maps to a requirement (R*) and a check (V*).
- Keep `README.md` and `SPEC.md` true. When behavior changes, update both in the same commit.
- Follow the "Lab rules" in `SPEC.md`: only unmodified `claude` and `codex` binaries, the lab's own sign-in page, no client spoofing.
- Bookish (`madeyexz/ai-native-book-reader`) is the first app. Its `site/agent/` and `src/core/connectors.ts` hold the code this library replaces.
- The page at https://byoa.rippling.computer is built by `site/build.mjs`: the design (hero, diagrams, v1 scope) is in `site/template.html`, and the status line and the "The problem", "How it will look", "How we will verify it" and "Rules we follow" sections come from `README.md`. Keep facts in the template true to `SPEC.md`. The page's pixel art is in `site/art/` and its fonts (Geist, OFL) are in `site/fonts/`. After a README or template change, run `cd site && npm install && node build.mjs`, and push `site/index.html` with any changed art or fonts. The README's images in `.github/readme/` (banner, diagrams, "Why" panels, the social preview) are captured from the built page by `site/readme-art.sh`; after a template change that they show, run it after `node build.mjs`. The Cloudflare Worker `byoa-site` (`site/worker.js`, custom domain `byoa.rippling.computer`) serves `site/index.html`, `site/art/` and `site/fonts/` from `main`, so it needs no redeploy unless `site/worker.js` changes.
