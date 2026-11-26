# Changelog

The section for a version becomes the notes of its GitHub release.

## 0.2.5

**Fixed**

- **A stopped turn's task list no longer turns for ever, and is shown again where you are.** The step it was on is at rest (only the plan an agent is carrying out moves, while it works), and the plan as it stands, with steps of it left, stands at the end of the latest turn, under your next message, as Claude Code shows its list again; once the agent writes a new list or finishes every step, that is what is shown.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.2.4

**New**

- **An agent opens in the conversation's place, as a conversation.** Choose it in the title bar's Agents (or **Open** on its card): what it was asked, what it thought, each step with what it returned, what it wrote and reported, drawn as the conversation itself is. The title bar names it (conversation › agent); its ✕, **Back to conversation**, or Esc go back. Iris's own agents can be stopped and written to from there.
- **Antigravity's agents show what each step returned** (a command's output, a file read, an error), and what they thought.

**Fixed**

- **A Codex command left running in the background no longer reads "still running" for ever** once Iris was restarted without it: its step says its end was not seen. And when Iris attaches again to a Codex or Antigravity conversation still running on a host, its background commands are listed again.
- **Streaming in a long conversation works out only its own turn again** for each frame; the turns before it are kept (about 12% less script time while a reply streams).

- **A long command no longer spreads over the line under the turn.** What is being done is one line, cut where it does not fit, with its time and tokens beside it; and a command is named the way it reads: "OMP_NUM_THREADS=4 PYTHONPATH=… /home/me/env/bin/python -m pytest" is "python -m pytest" (all of it in the tooltip, and in the step).

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.2.3

**Fixed**

- **Iris no longer works the GPU while an agent works.** The marks of something under way (the dots, the breathing text, the pulsing dot in the sidebar) made the window be drawn anew at every refresh of the screen, 60 or 120 times a second: on a large screen, while an agent worked, about a quarter of a core in the window and a third of one in the GPU process. They now move on fifteen times a second, with nothing drawn in between: about 3% and 6%. The text of something under way breathes instead of a moving gradient.
- **Long conversations stream and scroll with less work**: where the conversation was is found from what is on screen, not by measuring every entry; a line of text is measured when it changes, not on every render; an edit's diff is worked out once; usage is not worked out again for every word. About a third less script time while a reply streams and while scrolling.

**Changed**

- **A task list goes once every step of it is done** (Antigravity's plan, Codex's, Claude Code's): a plan carried out is no longer left on screen.
- **One button in the message box while the agent works**: Stop, and Send in its place once something is written (sending stops the turn and starts the message's own; Option+Enter adds it after the step under way).

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.2.2

**New**

- **Background commands of Codex and Antigravity are background tasks.** A command the agent leaves running (Codex's background terminals, Antigravity's commands moved to the background) shows in Background tasks and as "N running" in the title bar, with its output as it comes; when it ends, its step in the conversation gets its output and exit code. (Before, Codex's read "Codex did not report the result", and Antigravity's were not listed at all.) Iris cannot stop these from outside the agent, and says so.
- **Hand off to the same agent**: the dialog lists the conversation's own agent first, for a new conversation of it (another account or model, say), told where the earlier one is saved.

**Changed**

- **A step still running after the agent wrote on** reads "Ran 2 commands, 1 still running · View live output", without its moving mark; the line under the turn names it ("Running the 64-card benchmark") instead of "Writing", and is not taken for a stuck turn. A task list of a turn that is over no longer turns.
- **Background tasks** are one line each (what, how long, Stop), opening to the command and its output, with the ones that ended summed up under them ("2 finished · 1 failed").
- The line under a working turn says what it is doing, then for how long; "no output for 37s" is gone.
- **A turn's task list stands at the end of the turn**, under what was done and said, once (as it stands now), instead of where it was first made, screens above; while agents still work, its step in progress says how many.
- **Steps say what was made**: "Created and edited notes.md", "Created x.js", "Edited 2 files".
- **The line under a working turn says what is being done now**: a command's own description, "Reading app.js", "Editing notes.md"; while the model writes, how long and how many tokens so far.
- **A thought is one quiet line**, how it began, opening to all of it (its length and tokens in its tooltip). A reply's newest words fade in as they are written.
- **The message box says what a message does now**: while the agent works, "↵ to send now · ⌥↵ to add after this step"; a CLI's, "Message Codex · / for commands".
- **Slash commands:** Enter on a command that takes an argument (`/goal`) writes it out for the argument instead of sending it, also in a new conversation's first message.
- **A conversation handed off from No folder** shows No folder in the new conversation's folder picker.

**Fixed**

- **Antigravity's speed no longer jumps when its turn ends.** Antigravity counts a turn's tokens only at its end, and shows only a summary of the model's thinking; the speed while the turn went on was worked out from what was shown, and rose when the count came. It is now scaled by what the conversation's earlier turns were counted at.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.2.1

**New**

- **Agents in the title bar.** Beside a conversation's title, a pill says how many agents it started and how many are working ("2 agents running"). It opens the list, and from it one agent: what it was asked, each step it took (files open with a click), and what it reported. Every agent's agents are there: Iris's own (as before, with Stop and Message), and those of Claude Code, Codex, Cursor and Antigravity. The right panel no longer has an Agents card.
- **Antigravity's agents show what they do.** Antigravity starts an agent and gets on with its turn; the agent works on in a conversation of its own. Iris now follows it in Antigravity's files: its steps while it works, its report when it sends one, its tokens, and whether it finished or was stopped, including after the turn that started it has ended and after Iris restarts. (Before, every one read "Completed" at once and could not be opened.)
- **Switching models while a request is being retried takes effect at once.** Iris's own agent waits longer between each try of a failed request (a minute and more); a model picked during the wait was used only once the wait was over, so the conversation looked stuck on the old model. Now the wait stops and the request is made again right away on the new model.

**Changed**

- **Visuals sit in the conversation like a paragraph:** no frame or heading, as tall as the page itself (no more empty space under it, or a page cut off), on the conversation's own background and in its light or dark colours. A faint caption under it holds its title and Save, Start again and Fill the window. Filling the window now covers the whole window, sidebar and message box included, and Esc comes back. Pages are no longer put in quirks mode (which centred some in empty space).
- **Hand off and Review open where the conversation was**: the same folder, and under No folder when it was there. The first message no longer pastes a summary: it tells the agent where the earlier conversation is saved, for it to read.
- **The Hand off dialog** shows who hands to whom, the two kinds of hand-off as cards, and the agents as tiles.
- Iris's own mark (>_) replaces the sparkle on visuals and in Settings.

**Fixed**

- **An update no longer cuts off a conversation in the middle of its turn.** After an update Iris restarts running conversations so they use the new version; one that was working (on an SSH host, say) was stopped mid-turn and ended as Interrupted. Now it keeps going and is restarted once its turn is over. **Restart agent** on a conversation that is working asks first.

**For developers**

- `npm run test:ui` also drives visuals in the real app (`test/visual-ui.mjs`): page height, colours, a 100vh page, filling the window.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.2.0

**New**

- **Visuals.** Ask any agent to show you something (an algorithm stepping through its data, a protocol in motion, a chart of what it computed) and it can draw an animated or interactive page right in the conversation. Every agent gets the same `show_visual` tool: Iris's own built in, Claude Code, Codex, Cursor and Antigravity as an MCP server Iris gives each conversation, on this Mac and on SSH hosts. The page runs in a sandbox that may load libraries from cdnjs, jsDelivr and unpkg and reach nothing else. A visual can start again, fill the window and be saved as a web page; shown again under the same id it is kept current (earlier versions fold away); and a button in it can put a message in your message box (`iris.send`), for you to send.
- **Hand off to another agent.** From a conversation's menu, **Hand off to another agent…** or **Review with another agent…** opens a new conversation in the same folder, on the same machine, with a first message written: what was asked, what the agent last reported, and the files it changed. Read it, change it, send it.
- **Restart agent**, in a conversation's menu: its agent's process (and what it was doing) ends and starts again from the conversation's history.
- **A turn that goes quiet says so.** The line under a turn says how long nothing has come from the agent ("Waiting for the model · no output for 25s"); after three minutes with no step running it says the agent may be stuck, with **Stop** and **Restart**.

**Changed**

- **Pi is now Iris.** Iris's own agent is called Iris everywhere: in the agent picker, with the app's icon, in messages and errors, and to the model itself (its prompt opens with Iris, not "inside pi"). It is built on [Pi](https://github.com/earendil-works/pi) by Mario Zechner, under the MIT License: see THIRD_PARTY_NOTICES.md (also in the app, and in About Iris). Conversations keep working as they were.
- **A message handed to Codex's turn under way (Option+Enter) shows where you sent it**, inside the reply, not above it.

**For developers**

- `npm run test:real` drives the app against your real, signed-in Codex (and Cursor with `-- --cursor`): questions, long commands, agents, stopping and steering a turn, visuals, restarting. It spends real model calls and never runs in CI.
- Iris's own agent's engine id is `iris` (was `pi`); `PiSession` is `AgentSession`; the runtime variable given to commands is `IRIS_NODE` (was `PI_NODE`).

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.17

**Fixed**

- **A Codex agent no longer brings the conversation down.** An event of an agent Codex had started (its reasoning, which is no step of its own) stopped Iris's Codex adapter: the turn under way was lost, Context read "Not reported", and the next message started again from nothing. A single event that cannot be handled is now noted and passed over.
- **Stopping a Codex turn keeps it.** Codex confirms a stop only once its commands and agents have stopped, which can take several seconds; meanwhile Iris gave up and ended the process, and the turn was lost. The turn is now saved as it stands at once (marked Interrupted), and the next one starts once Codex has stopped.
- **Commands with both kinds of quote show as written**, without a stray `'` or `"` at the start.

**Changed**

- **A step that is still running is named on its group's line** ("Running make check", and how many others are running), and listed after the steps that have finished, where the latest step is read: a long command no longer looks like the agent having stopped.
- **Opening a file shows the file only.** The folder tree beside it shows when asked for (the choice is kept), and no longer opens folders to reveal the file.
- **Diffs in the dark theme have more contrast**: stronger tints for added and removed lines, brighter text and +/− marks.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.16

**Changed**

- **A message sent while Codex works stops the turn and starts one on it**, as with the other agents: it shows as a row of its own after that turn, instead of joining the turn and showing above its reply. Option+Enter still hands it to the turn under way, which reads it before its next model call.
- **The Usage card shows what matters**: the speed, and under it the wait for the first token (**TTFT**), the **Cache hit** of the last request and the **Total** tokens of the conversation. The table of input, cached, output and reasoning tokens is gone; hovering a figure says more.
- **Thinking is translated into plain words**, as an engineer would say it to a colleague, rather than word for word; technical terms engineers say in English stay in English.

**Fixed**

- **Questions Codex asks without stopping are question cards.** Codex can ask something and go on working (its answer is whatever you send next); the question showed as text with its options as a list. It now shows as the question in the reply and a card with its options. Choosing one sends it as your message (stopping the turn under way, as above); the card stays after the turn ends, and a message you type instead answers it.
- **Finished steps no longer show as running again.** Opening a conversation again while its CLI was still on a turn (or a reconnect) forgot which of that turn's steps had finished, so every earlier group of steps spun until the turn ended.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

## 0.1.15

**Fixed**

- **A host's Cursor models are read again through the Mac without being asked.** After 0.1.13, Settings → Cursor and the model menu went on showing the models a host was offered before (a few, where the server's region offers few) until Subscriptions was opened or the list refreshed. Any check of Cursor on that host now reads them again, through the Mac, once; Settings → Cursor shows them when it is done.

**Install:** download the `.dmg` for your Mac (`arm64` for Apple Silicon, `x64` for Intel), drag Iris to Applications, then right-click → Open the first time (the app is signed ad hoc, not notarized). From an earlier version, **Iris → Check for Updates…** installs it.

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
