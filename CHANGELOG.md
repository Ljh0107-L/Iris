# Changelog

The section for a version becomes the notes of its GitHub release.

## 0.1.1

**Fixed**

- **Codex sign-in from an app opened in Finder** no longer fails with `env: node: No such file or directory`: the sign-in gets your login shell's PATH and the CLI's own directory.
- **Antigravity offers its models before the first conversation.** Iris asks the CLI for its model and thinking-level menus as soon as it is signed in.
- **No-folder conversations live in `~/Iris`** (`~/iris` on an SSH host), not `~/Pi`. Existing folders in `~/Pi` are left where they are.
- Messages that named the wrong agent ("Pi is waiting…" for a Codex conversation, "Antigravity CLI stopped" for Codex) name the right one.

**New and changed**

- **The agent is chosen beside the folder and the machine**, above the message box. The model, effort and modes below it are that agent's own.
- **Subscriptions have their own Settings page**, apart from API keys. Each plan is a card: who is signed in, the plan, and how much of each limit is used.
- **Codex signs in through your browser** from the app, without a terminal, and can have **several accounts**: Add account signs another one in, and each conversation keeps the account it started with.
- **Right panel:** context as a bar, the speed of the last reply with recent replies beside it, and background tasks and subagents as rows. Agents started by Claude Code and by Codex are listed there too.
- **Every conversation shows its agent's icon** before its title, in the sidebar and in the header.
- **Check for Updates** says where things stand ("You’re up to date", or Restart to Update), and the sidebar shows a check or a download while it runs.
- The first screen no longer shows a "Connect a model" card, and an empty Connections page has one Add button.
- A new look: neutral surfaces, ink controls, and the rainbow of the app's mark where something is live (the focused message box, the open conversation, the working cursor).

**Not in this release:** Antigravity's quota is not shown, because its CLI does not report it to other programs. Codex on an SSH host still signs in from a terminal there.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From 0.1.0, **Iris → Check for Updates…** installs it.

## 0.1.0

The first release of Iris.

- **Four coding agents in one app:** Pi, Claude Code, Codex and Antigravity. Choose a model for a new conversation and the agent follows from it.
- **This Mac and SSH hosts.** Hosts come from `~/.ssh/config`; Iris sets them up on first use. Agents on a host keep working through disconnects and after the app quits.
- **Models.** API keys for any provider or compatible endpoint (Pi), Anthropic Messages endpoints (Claude Code), your ChatGPT plan (Codex) and your Google account (Antigravity). Iris keeps Codex and Antigravity data separate from the CLIs you use in a terminal.
- **Workspace.** File tree and previews, Git review with staging and commit, a terminal per conversation, search across conversations, attachments and image thumbnails.
- **Pi extras.** Agents with their own context and worktrees, Ultra for long unattended tasks, `/goal`, and speed tiers where a provider sells them.
- **Usage, notifications and self-update.**

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized).
