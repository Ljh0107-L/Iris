# Changelog

The section for a version becomes the notes of its GitHub release.

## 0.1.4

**Fixed**

- **Signing Antigravity in on an SSH host works.** The sign-in was made in the CLI's default data directory while Iris's conversations use their own, so a host said "Logged in" and Iris still said "Not signed in". The sign-in, the check and the conversations now use the same directory. A host you signed in before needs one more sign-in from Iris.
- **Reading Antigravity's quota never starts a sign-in.** It is read only for an account that is signed in, and a CLI found waiting for a sign-in is left at once.
- **A CLI started to read the quota no longer stays behind** when the app quits while it is being read.

**New and changed**

- **Antigravity on a host signs in without a terminal.** Sign in with Google opens the sign-in page in your browser; the code that page shows goes into a field on the Subscriptions card. A code that is refused says so and offers to try again.
- **Nothing to confirm after an update.** The "Updated to …" button is gone: running conversations are restarted and the app carries on. If a conversation could not be restarted, a notice says so once, with the details behind it; **Iris → Update Report…** still shows what was restarted.

**Known limits:** Antigravity's sign-in cannot be copied from this Mac to a host the way Codex's can: the CLI keeps it in the keychain here and offers no way to hand it over. Antigravity's quota is still read on this Mac only.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.3

**Fixed**

- **A reply can be selected while it is being written.** Only the part being written is redrawn as text arrives; before, the whole reply was replaced on every frame, which dropped any selection in it, made long replies stutter and left a lot of memory in use after one.
- **Moving the pointer down the sidebar no longer starts an agent for every conversation it passes.** An agent is started ahead of the click only when the pointer rests on a row.
- **Only one Iris runs per profile.** Starting it again brings the running one forward, instead of a second copy writing the same conversation list and settings.
- **With the window closed, Settings… and a click on a notification open a window again.** Before, they did nothing.
- **Archive takes effect at once**, like Delete, and says why if it fails.
- **The Git review pane keeps itself current quietly.** Its refresh button no longer turns into a spinner, and Commit is no longer disabled, every five seconds. Nothing is read while the window is hidden, and an SSH host is asked less often.
- **Antigravity's input tokens** are no longer under-counted in turns that read from the cache.
- **Search finds text that contains quotes or backslashes.**
- Check boxes in the model editor show clearly when they are on; code in your own messages is shown as code; the terminal follows the light appearance; notices no longer cover the toolbar in a narrow window.

**New and changed**

- **Codex and Antigravity show their plan and their sub-agents**: the steps of a plan as a task list that is kept current, and each sub-agent as a card with what it was asked and what it answered.
- **Subscriptions open with what was last read**: accounts and quota are remembered between starts and read again shortly after the app opens. Reading Antigravity's quota takes about two seconds instead of several.
- **The window remembers its size and place**, opens in the appearance you chose (no flash of the other one), is named after the open conversation, and in full screen gives the traffic lights' room back to the title bar.
- **A File menu**: New Conversation (⌘N), Search (⌘K), Find in Conversation (⌘F) and Close Window (⌘W); Show or Hide Sidebar (⌘\\) is in View.
- **Unsent text is kept** across a restart, for each conversation and for the new-conversation box. Attachments are not.
- **Search reads conversations on connected SSH hosts** as well as on this Mac, and says when some could not be searched.
- **The first screen says how to start** when nothing is set up: sign in with a ChatGPT or Google plan, or add an API key.
- **The rainbow is used less**: the marker beside the open conversation and the coloured bar beside the speed are gone. A progress bar is one spectrum across its whole length, uncovered as the work advances.
- The Subagents card appears only when a conversation has sub-agents. The interface says "conversation" throughout.

**Known limits:** Search reaches an SSH host only once Iris has connected to it since it was started. Antigravity's quota is still read on this Mac only.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.2

**Fixed**

- **Speeds follow the account.** Fast and Ultrafast are offered per Codex account: a model shows only the speeds that account's plan has. Before, every account showed the first account's.
- **The first Codex message starts sooner.** Codex is started when the new-conversation screen opens, and its account, limits and models are read together, so the first message no longer waits two to three seconds for them.
- **Subscriptions no longer flash "Checking"** each time the page opens: the last result is shown and updated quietly. Sign-in buttons wait for the first check.

**New and changed**

- **Antigravity shows its quota**: the account, and for each group of models how much of the weekly and the five-hour limit is used and when it refreshes. Iris reads this from the CLI's own `/usage` screen, in the background.
- **Antigravity turns show real token counts** (input, cached, output, thinking) when the CLI reports them, and their speed is computed from those.
- **Accounts are named by their e-mail address** in the account menu under the message box.
- **Signing a host in to Codex:** "Use this Mac's sign-in" copies this Mac's Codex sign-in to the host over SSH, so no browser or code is needed there. Signing in on the host itself is still available, and the page to open is offered as a button beside the terminal.
- **Adding an SSH host says what it is doing**, with sizes while it uploads ("Uploading Pi from this Mac… 21 / 91 MB").

**Known limits:** Antigravity does not stream its thinking, so a long think shows only the timer. Antigravity's quota is read on this Mac only, not yet on SSH hosts. A Codex sign-in copied to a host is the same sign-in as this Mac's: if OpenAI ends it on one, sign in again and copy it once more.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

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
