# byoa

An open-source library that lets an app run its users' own Claude Code or Codex in any sandbox, with their MCP connections and skills. It runs inside the app's own backend. It is never a hosted service.

- Read `SPEC.md` before you change anything. Every change maps to a requirement (R*) and a check (V*).
- Keep `README.md` and `SPEC.md` true. When behavior changes, update both in the same commit.
- Follow the "Lab rules" in `SPEC.md`: only unmodified `claude` and `codex` binaries, the lab's own sign-in page, no client spoofing.
- Bookish (`madeyexz/ai-native-book-reader`) is the first app. Its `site/agent/` and `src/core/connectors.ts` hold the code this library replaces.
