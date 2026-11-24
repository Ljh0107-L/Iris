# Contributing to Iris

Thanks for helping. Bug reports, fixes and focused features are all welcome. For a larger change, open an issue first so we can agree on the shape before you write it.

## Set up

You need macOS, Node.js 22 or later (CI uses 24) and npm.

```sh
npm install
npm start        # builds the interface and opens the app
npm run dev      # Vite dev server for the interface alone
```

To try the app without touching your own conversations and keys, give it a separate profile, and a separate
folder for conversations started without one (the default is `~/Iris`):

```sh
IRIS_USER_DATA=/tmp/iris-dev IRIS_DEFAULT_WORKSPACE=/tmp/iris-dev/workspace npm start
```

## Where things are

| Path | What is there |
| --- | --- |
| `app/main/` | Electron main process. `session-manager.mjs` owns conversations; `remote-setup.mjs` prepares SSH hosts; `store.mjs` holds settings and keys. |
| `app/renderer/src/` | The React interface. `store.js` is the state; `transcript.js` turns agent events into what the conversation shows. |
| `agent/` | Code that runs next to an agent, on this Mac or copied to a host. It must run on plain Node with no dependencies. |
| `core/` | The agent protocol client, transports and the egress proxy. Shared by the app and the tests. |
| `test/` | `*.test.mjs` are unit tests. The other `.mjs` files are drivers for the UI and SSH suites. |

All four agents reach the app through one event protocol (Pi's RPC). When you add something for one agent, check what the other three should do.

## Tests

```sh
npm test                   # unit tests; must pass before a pull request
npm run test:ui            # the built app driven with Playwright, and the Git review pane in headless Chrome
npm run test:integration   # SSH and end-to-end suites against a throwaway sshd on 127.0.0.1
node --test test/codex-adapter.test.mjs   # one file
```

- Tests never call a real model or a real account. Use the mocks in `test/` (`mock-llm.mjs`, `mock-anthropic.mjs`, `fake-codex.mjs`, `fixtures/`).
- Tests use their own profile directory (`test/harness.mjs`), so they do not read or change your settings.
- `test:ui` needs Google Chrome or Chromium for the Git review pane (set `IRIS_CHROMIUM` to point at another build).
- `test:integration` starts an unprivileged `sshd` with its own keys under `/tmp/iris-sshd`. It never touches `~/.ssh`.
- A bug fix comes with a test that fails without it.

## Code style

- Plain JavaScript (ES modules), no TypeScript and no build step outside the interface.
- Comments say why, not what. Text shown to the user is plain and specific: say what happened and what to do next.
- Keep changes small and in the style of the file you are editing. No new dependency without a reason in the pull request.

## Pull requests

- One topic per pull request, with a description of what changes for the user and how you tested it.
- CI builds the interface and runs `npm test` on macOS. The **Integration** workflow can be run by hand from the Actions tab for changes to SSH, the relay or the interface.

## Releasing (maintainers)

1. Set the version in `package.json` and add its section to `CHANGELOG.md`.
2. Commit, then push `main` and the tag `vX.Y.Z`.
3. The **Release** workflow tests, packages, smoke-tests the packaged app and publishes the GitHub release with that changelog section. Installed apps pick it up from the release's `latest-mac.yml`.
