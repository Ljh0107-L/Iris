# Security

Iris stores API keys and starts agents that run commands on your machines, so security reports are taken seriously.

**Please do not open a public issue for a vulnerability.** Report it privately through [GitHub's private vulnerability reporting](https://github.com/Ljh0107-L/Iris/security/advisories/new). Say what is affected, how to reproduce it and what an attacker gains. You will get an answer as soon as a maintainer has read it.

Only the latest release receives fixes.

## What to keep in mind

- Agents in Iris run commands and edit files without approval prompts, on this Mac or on the SSH host you chose. Run them only in folders and on machines where that is acceptable.
- API keys are encrypted on this Mac with a key held in the macOS Keychain. They are passed to an agent over a pipe when it starts, and are not written to an SSH host's disk.
- Codex and Antigravity keep their own credentials; Iris never reads them.
