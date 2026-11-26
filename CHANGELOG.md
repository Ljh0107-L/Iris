# Changelog

The section for a version becomes the notes of its GitHub release.

## 0.1.14

**Changed**

- **Codex conversations have 800K of context.** Codex gives each model a window of its own (500K for GPT-6.2-Sol, 272K for most others, less the 5% it keeps back) and a larger size it may be given. A conversation now asks for 800K that can be used, or as much as the model may be given when that is less; Codex compacts later accordingly. On this Mac and on SSH hosts alike. A conversation already open gets it when it is opened again.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.13

**New**

- **Cursor on an SSH host asks Cursor through this Mac.** Cursor offers the models of the region it is asked from, and a server's region can offer few of them. Requests to Cursor's own domains now go over the SSH connection and out through the Mac, so the host is offered the same models as the Mac; everything else the agent does on the host (its commands, the host's own network and proxy) goes out as before. When the Mac cannot be reached, Cursor goes straight out from the host. The host's model list is read again once after updating; a Cursor conversation already running keeps its old route until a new one is started.
- **Settings → Translation chooses how much the translation model thinks** (Off unless you choose otherwise), from the levels the model offers in a conversation.

**Changed**

- **A translation is sent as a conversation with that model sends it** (Pi's own request, with the model's API, headers and thinking settings), and a refusal shows the provider's own message.
- **Thinking is translated a few paragraphs at a time** rather than one request a paragraph: the paragraphs finished since the last request go together once there are enough of them, once the first has waited a second and a half (a slow model is not kept waiting), or when the thought ends. While two requests are out, what follows piles up for the next one.
- **Try it in Settings → Translation** shows a sample of thinking, which you can edit, beside its translation as the Thinking card shows it, with the time it took, the model and its thinking, or why it was not translated.
- **The Usage card says when its speed is from an earlier request** ("3 requests ago"). A request that only calls a tool gives no first token to time from (Codex shows nothing of it until it ends), so the figure stays on the last request that could be timed.

**Known limits:** Cursor through the Mac was tried with a local SSH server and Cursor's real CLI, not yet on a remote host.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.12

**Fixed**

- **Cursor answers sooner.** Each message waited two to four seconds while Iris set the conversation's model again; a Cursor conversation keeps its own model while it runs, so it is set only when it differs (when a conversation opens again, for example). A new conversation signs Cursor in while you type, before the first message.
- **Images Cursor generates show in its reply**, and in the step when you open it, instead of "Tool completed.". Its task-list and agent updates are answered too.
- **Checking an account in Settings → Subscriptions is quicker.** Cursor's check took about twelve seconds and now takes about three: it asks for the account and the plan side by side, and reads the model list only when Iris has none for that machine or you refresh it. A check after you sign in shows **Checking** instead of staying on "Not signed in".
- **Cursor's speed on coarse streams.** A model that sends most of a reply in its first piece read as a few tokens a second; that reply is now timed as a whole.
- Thought titles written as `**Title**` show as headings, without the asterisks.
- **Translation is quicker with a reasoning model**: its requests ask the model not to think first (and are sent again without that when the provider does not take it).

**Changed**

- **Installing Cursor's CLI runs in the background.** Close Settings and it goes on; open it again to see how far it is.
- **Settings → Cursor chooses the machine** whose models it lists and refreshes, an SSH host as well as this Mac. Which models the menu shows applies to every machine.
- **Signing Cursor in on an SSH host opens its page in your browser** on this Mac by itself; when you confirm there, the host is signed in. Each machine keeps its own sign-in: Cursor's refreshed sign-in replaces the one before it, so a copied one would sign one of them out.

**Known limits:** Cursor on SSH hosts and its background install were tested with a stand-in for Cursor.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.11

**New**

- **Cursor joins as a fifth agent.** It runs on your Cursor plan through Cursor's own CLI (`cursor-agent`), on this Mac and on SSH hosts, with its commands, file reads and edits, task list, agents and questions shown as the other agents' are. **Settings → Subscriptions** installs the CLI (as `cursor-agent` only, leaving an `agent` command of another tool alone) and signs it in: Iris opens Cursor's page in your browser. Conversations you start in Iris stay in Iris's own Cursor directory, apart from your own Cursor CLI.
- **Settings → Cursor** chooses which of Cursor's models its model menu lists (it offers dozens). Each model keeps its own settings, effort, context and Fast, as menus beside it, and a long menu can be searched.
- **Each Cursor conversation keeps its own model.** Cursor holds one model choice for all of its conversations; Iris sets a conversation's own again before each message, so changing it in one conversation does not change another.

**Changed**

- **Speed no longer counts the wait for the first token.** The Usage card shows output tokens over the time from the first token to the last (**Output TPS**), for every agent: Pi, Claude Code, Codex (from when a request begins to write), Antigravity (less a thought that arrives whole) and Cursor. Reasoning the provider did not stream is left out with the time it took. A reply too short to measure that way is timed as a whole request and says so (**Request TPS**). Cursor counts no tokens, so its speed is estimated from what it wrote.
- **Speed shows while a Codex, Antigravity or Cursor turn is still going**, one model request at a time, instead of only when the turn ends.
- **Settings → Translation looks like the rest of Settings**: rows with the app's own menus for the language and the model (the same model menu as a conversation's), and no coloured border.

**Fixed**

- **Translating thinking no longer falls behind a fast model.** Paragraphs were translated one after another, so with a model writing thousands of tokens a second the thought on screen waited behind ones long gone. Only the thought on screen is translated now, a few paragraphs at a time; paragraphs of a thought that has left are dropped.
- Escape closes an open menu in Settings without closing Settings.

**Removed**

- **From Codex** (continuing a conversation of the Codex app or terminal in Iris) is gone.

**Known limits:** Cursor was tried with a signed-in CLI on a Mac; on SSH hosts and for its questions (its ask-question tool, which the models tried did not use) it was tested with a stand-in for Cursor.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.10

**Fixed**

- **Translated thinking shows while the thought is still on screen.** With Antigravity a thought arrives whole and counts as "still being written" until the next step begins, so its translation started only when the thought was about to leave the panel. A paragraph that has stood still for a moment is now translated at once.

**New and changed**

- **Translation uses a model from Settings → Models.** There is no separate address and key to enter: choose the language and one of your models. A translation API entered in 0.1.9 is no longer used; choose a model in its place.
- **Settings → Translation says where things stand.** A line states whether translation is on, into which language and by which model; every change is saved as it is made and says "Saved"; **Translate a sentence** shows what the model returned and how long it took, or why it returned nothing.
- **The Thinking card says what the translation is doing**: translating, done (with the language and the model, and **Original** to see what the model wrote), or not translated and why, with the way to Settings.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.9

**New and changed**

- **Codex has `/goal`.** `/goal <objective>` gives Codex its own long-running goal: Codex keeps working toward it turn after turn and marks it achieved itself. The goal shows above the message box with Pause, Resume and Clear; `/goal pause`, `/goal resume` and `/goal clear` do the same. Stopping the work pauses the goal.
- **An earlier message in a Codex conversation can be edited.** Codex goes back to before the turn that message began, and continues from the edited one. (The Antigravity CLI has no way to go back, so its conversations cannot do this.)
- **Conversations from Codex itself can be continued in Iris.** With Codex chosen on the new-conversation screen, **From Codex** lists the conversations of the Codex app, the terminal and editors on that machine; picking one opens it here with what was said in it. It is forked into Iris's own Codex home: the original stays as it is.
- **The right panel shows the agent's thinking as it arrives**: the thought being written, or the last one of the turn. When the next begins, the one before leaves; the conversation keeps them all, folded.
- **Thinking can be shown in your language.** Off unless turned on in **Settings → Translation**, where you give the API to use for it (address, key, model) and the language. Only that API is asked; with it off, thinking is shown as the model wrote it.
- **You choose what the right panel shows.** The button at its top turns each card on or off: Environment, Context, Usage, Thinking, Background tasks, Agents.
- **One mark for work in progress, and it says what is going on.** Four dots changing places: a step is under way (a command, a file read or written, a search). Three dots turning in space: the model is thinking. The same three circling in a row: it is writing. The mark is on the step while one is under way and under the conversation otherwise, never both. (These replace the dot grid of 0.1.8 and the blinking prompt.)
- **A long run of steps opens to its last eight**, with the earlier ones one press away, and a long thought opens to its first part: opening either no longer pushes the rest of the conversation off the screen.
- **Antigravity's checks on background commands read as that** ("Checked a background task") and are counted as such, in place of rows saying "Run manage_task".

**Known limits:** `/goal`, editing a message and **From Codex** were built against Codex's published protocol and tested with a stand-in for Codex, not yet with a signed-in Codex.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.8

**Fixed**

- **A long Codex or Antigravity conversation opens again as it was.** Reopened, its steps were a column of "Command result", "Read" and "Wrote" with nothing after them, the answer was missing until you scrolled to the top of the turn, and the speed said "unavailable". These agents save a whole turn as one reply, and a reply of more than 32 parts was left out of the first read. Every part is now read in outline, so each step has its command or file and the answer is where it was; the rest of a step is read when you open it.
- **Speed is measured per model request with every agent.** Codex and Antigravity were measured over the whole turn, including the time their commands ran, so a turn with a long command looked slow, and the figure changed only once a turn. Each model request now has its own speed, as with Pi and Claude Code, and the time tools ran is in none of them. Antigravity counts tokens for a turn only, so its per-request figure is an estimate and says so.

**New and changed**

- **Quieter marks for work in progress.** The step under way has a small cluster of dots; a command that is running has the app's `>_` with its cursor blinking; a finished step has no mark. In the sidebar a conversation that is working has one dot, in place of a spinner.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.7

**Fixed**

- **File links in an answer open the file.** Antigravity names the files it touched as `file:///…` links, and those were stripped when the answer was drawn, so a click did nothing, on this Mac and on a host alike. They now open in the file pane. A link to a line (`#L12`, or `path:12` as Codex writes it) opens the file at that line and marks it.
- **Antigravity's edits show what changed.** A change to part of a file was listed as `+0 −0` with an empty diff; it now shows the text replaced and its replacement.
- **The list of a turn's changes shows every diff in full.** Cards were squeezed to fit the pane, some down to one line. Paths in it are relative to the conversation's folder instead of a long absolute path.
- **A question from Antigravity or Codex is a card with its choices**, answered with a click or in your own words. It used to show as a tool that failed, with the choices written out as text. Antigravity's own copy of the question as a paragraph is left out.
- **Quit quits.** After ⌘Q the window leaves at once, everything on this Mac is stopped, and Iris no longer waits on SSH hosts before going: a slow or unreachable host could keep it open in the background. Conversations on hosts keep running there, as before. When something is still working on this Mac, Iris asks first (**Quit Anyway** / Cancel).
- **Subscriptions and the agent menu show what they know at once.** They said "Checking" beside a spinner for the five seconds the CLI takes to confirm a sign-in, every time. The last result is now shown straight away and checked again quietly; the Refresh button spins only when you press it.
- **A connection message of several lines no longer spills over the message box**, and a plain text file is no longer coloured as if it were code.
- **The folder shown for a No-folder conversation is its own folder**, not the day's folder above it.

**New and changed**

- **HTML pages open as pages.** A `.html` file in the file pane is drawn, with its styles, scripts and images loaded from its folder, on this Mac or on an SSH host, so a page an agent built on a server can be looked at without starting a web server there. The page runs in a frame of its own and can read nothing outside its folder. Reload, the source, and (on this Mac) Open in your browser are beside it.
- **A message appears the moment you send it**, with every agent, including one sent while the agent is working.
- **Pasted and attached images are sized for the model before they are sent.** A photo of 8 MB became 10 MB of text in the message and made the window stutter; it is now about 0.7 MB, in a fraction of a second. Small screenshots are sent as they are.
- **Steps are laid out as in Claude Desktop**: a quiet line with room around it, opening into one card whose rows are divided by hairlines, a command in an inset box and its output as plain text. Counts such as "(1 failed)" stay on one line.
- **The spinner is a thin arc.**
- **Conversations in a folder are listed by when they were last written to**, newest first. (A conversation keeps its old place until its next message.)

**Known limits:** Codex asks questions only in its plan mode, which Iris does not offer yet. A page previewed from a host loads each of its files over SSH, so a page with many files takes a moment to appear.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.6

**Fixed**

- **The first message to Antigravity starts sooner.** The CLI that waits on the new-conversation screen now signs in and reads the account and its models while it waits, instead of when the first message arrives: that step took about two seconds on a Mac and longer on a host behind a proxy. The waiting CLI is kept for ten minutes, not ninety seconds, so a first message that takes a while to write does not fall back to a full start.
- **Antigravity's finished thoughts no longer keep a spinner.** Only the step that is running now has one.
- **Antigravity's tools read as what they are**: a command, a file read or written, a web search, as with the other agents, instead of a title followed by `{}` or the tool's input as JSON. A command's output no longer carries the lines the CLI wraps around it.
- **A command you stopped says "Interrupted"** and is not counted as failed.

**New and changed**

- **Sending a message opens the conversation at once.** Its title, machine and message box are there from the moment you send, and the wait is shown as Thinking, timed from when you sent it. Setting up a host or uploading to it still says what it is doing.
- **A message sent while Antigravity works stops what it is doing and starts on the message**, as with Pi. (Codex still reads it before its next step.)
- **A model or effort can be chosen while the agent works**; it is used from the next message on.
- **Steps are quieter.** Nothing is filled in when a step is hovered or open, a command and what it printed are plain text under a thin rule, and a file is its name rather than a chip. A group with one step opens to what that step did, without repeating its line.
- **The working indicator is the app's own mark**, a prompt with a blinking cursor, in place of the small bar.

**Known limits:** Antigravity does not send its thinking until it has finished thinking, so the first step of a turn can take ten seconds or more to appear; that time shows as Thinking. After a turn is interrupted, its task list still shows the task that was under way as in progress.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.5

**Fixed**

- **Antigravity works on a host that reaches Google through a proxy.** Iris starts the CLI with only part of the environment, so that no API key in it replaces the Google sign-in, and the proxy settings were left out with the rest. A sign-in on such a host succeeded, and then every check and conversation waited for Google until it timed out ("timed out waiting for session/list"). The proxy and certificate settings (`HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE` and the like) are now passed on; keys still are not. Commands the agent runs there get them too.
- **Signing in on a host is the same start as a conversation.** The sign-in runs through Iris's adapter on the host, with the environment and data directory a conversation's CLI gets, so a sign-in that succeeds is one the conversations have.
- **Clearer messages when a host sign-in goes wrong:** a refused code, a host that cannot reach Google, and a CLI that signed in but finds no sign-in at its next start are each said as what they are. A CLI that does not answer says so in words, and that it may not be reaching Google.

A host you already signed in with 0.1.4 does not need another sign-in.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

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
