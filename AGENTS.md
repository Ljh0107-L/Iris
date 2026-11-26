# Iris

Notes for coding agents working in this repository. People should start with [README.md](README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## Commands

- `npm test`: unit tests (`node --test "test/*.test.mjs"`). Run the files for the code you changed while you work, and the whole suite before you finish.
- `npm run test:ui`: builds the interface, then drives the real app (`test/conversation-ui.mjs`) and the Git review pane (`test/git-review-ui.mjs`). Run it after a change to `app/renderer`.
- `npm run test:integration`: SSH and end-to-end suites. Slow; run it for changes to the relay, transports, host setup or session lifecycle.
- `npm run build`: builds the interface into `dist/renderer`.
- `npm run test:real`: drives the app against the real Codex (and, with `-- --cursor`, Cursor) with the user's own sign-in, for what stand-ins cannot show. It spends real model calls: run it only when the user asks for it.

## Rules

- Tests and manual checks use an isolated profile (`IRIS_USER_DATA`, or `launch()` in `test/harness.mjs`). Never start a real Codex, Antigravity, Cursor or model session against the user's own accounts to test something (unless the user asks for it).
- `agent/` runs on remote hosts with plain Node: no dependencies, and no imports from `app/`.
- The five agents share one event protocol. A change to events or session state must keep Iris (its own agent, built on Pi), Claude Code, Codex, Antigravity and Cursor working; the adapters' tests are `test/claude-code.test.mjs`, `test/codex-*.test.mjs`, `test/antigravity-*.test.mjs` and `test/cursor.test.mjs`. Antigravity and Cursor share one adapter (`agent/iris-antigravity.mjs`, with a profile per CLI). Every agent gets the visual tool (`agent/iris-visual.mjs`): Iris's agent built in, the others as an MCP server.
- Text shown in the interface is English, plain and specific.

## Releases

- A release is a commit on `main` with the version set in `package.json`, a section in `CHANGELOG.md`, and the tag `vX.Y.Z`. Pushing the tag runs the **Release** workflow, which tests, packages and publishes.
- Push, tag or publish only when the user asks for it.
