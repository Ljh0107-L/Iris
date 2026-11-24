// Engines that are someone else's CLI, signed in with the user's own account on each machine (Antigravity,
// Codex), as opposed to Pi and Claude Code, which run on API keys from Settings → Models. They share one
// adapter contract: `session.cli` holds the CLI's state for either.
export const CLI_ENGINES = {
  antigravity: { id: 'antigravity', label: 'Antigravity', cli: 'Antigravity CLI', bin: 'agy' },
  codex: { id: 'codex', label: 'Codex', cli: 'Codex CLI', bin: 'codex' },
};
export const isCliEngine = engine => typeof engine === 'string' && Object.hasOwn(CLI_ENGINES, engine);
export const engineLabel = engine => CLI_ENGINES[engine]?.label ?? (engine === 'claude-code' ? 'Claude Code' : 'Pi');
export const engineCli = engine => CLI_ENGINES[engine]?.cli ?? engineLabel(engine);
// Whether a machine has the CLI installed and signed in is remembered per engine and machine.
export const readinessKey = (engine, environmentId) => engine === 'antigravity' || !isCliEngine(engine) ? environmentId : `${engine}:${environmentId}`;
// More than one sign-in per machine (each its own home directory): Codex only.
export const hasAccounts = engine => engine === 'codex';
