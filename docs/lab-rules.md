# Lab rules

byoa runs the labs' own CLIs on each user's own plan, so byoa and every app on it follow the labs' published rules. This page has the rules from [SPEC.md](../SPEC.md#lab-rules), and what each app must do.

## Rules we follow

- We run the real, unmodified `claude` and `codex` binaries. We never pretend to be another client. A test checks the hash of the installed binaries against the published packages (V11).
- The user signs in through Anthropic's or OpenAI's own sign-in page.
- One app's AI login is used only by that app.
- For OpenCode Go (beta), byoa uses only the user's own key, with OpenCode's documented API and the harness's own user agent, never OpenCode's Console CLI sign-in. OpenCode's terms do not clearly allow an app to run it for its users, so each app asks OpenCode first.
- The labs' terms restrict where an AI login may be stored. byoa keeps it in your database by default, so each app checks those terms and signs its own agreements with the labs.

## What the labs' terms say

<!-- include: ../SPEC.md#lab-rules -->

## What your app must do

<!-- include: ../skills/byoa/SKILL.md#lab-rules -->
