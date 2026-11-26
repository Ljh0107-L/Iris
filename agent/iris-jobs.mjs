// Commands an agent left running in the background, for the CLIs that have such commands but no list of them
// of their own in Iris's protocol (Codex's background terminals, Antigravity's async commands). Plain Node: this
// runs on hosts. The list is published the way Iris's own agent and Claude Code publish theirs (a status named
// iris-background), so the conversation shows them in Background tasks and as "N running" in the title bar.
// Iris cannot stop these from outside the agent: they say so (stoppable: false), and the card offers no Stop.
import { randomUUID } from 'node:crypto';

const TAIL = 4000, KEEP_FINISHED = 20;

export class BackgroundCommands {
  constructor(emit, now = Date.now) {
    this.emit = emit; this.now = now;
    this.jobs = new Map(); // key -> job
    this.generation = randomUUID(); this.revision = 0;
    this.timer = null;
  }
  has(key) { return this.jobs.get(key)?.status === 'running'; }
  get running() { return [...this.jobs.values()].filter(job => job.status === 'running').length; }
  start(key, { command, description = null, cwd = '', startedAt = this.now(), tail = '' }) {
    if (this.jobs.has(key)) return;
    this.jobs.set(key, { id: `bg-${this.jobs.size + 1}`, key, command: String(command ?? ''), description, cwd, startedAt, endedAt: null, status: 'running', exitCode: null, tail: String(tail).slice(-TAIL) });
    this.publish(true);
  }
  output(key, text) {
    const job = this.jobs.get(key);
    if (!job || typeof text !== 'string' || !text) return;
    job.tail = (job.tail + text).slice(-TAIL);
    this.publish();
  }
  // The whole of what it has printed so far, read again (a log file): kept only when it changed.
  setTail(key, text) {
    const job = this.jobs.get(key);
    if (!job || typeof text !== 'string' || job.tail === text.slice(-TAIL)) return;
    job.tail = text.slice(-TAIL);
    this.publish();
  }
  end(key, { exitCode = null, failed = false, output = null } = {}) {
    const job = this.jobs.get(key);
    if (!job || job.status !== 'running') return null;
    Object.assign(job, { status: failed ? 'failed' : 'completed', exitCode, endedAt: this.now(), ...(typeof output === 'string' && output ? { tail: output.slice(-TAIL) } : {}) });
    const finished = [...this.jobs.values()].filter(j => j.status !== 'running');
    for (const old of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) this.jobs.delete(old.key);
    this.publish(true);
    return job;
  }
  snapshot() {
    return [...this.jobs.values()].map(job => ({ id: job.id, command: job.command, description: job.description, cwd: job.cwd, status: job.status, stopping: false, stoppable: false,
      exitCode: job.exitCode, exitSignal: null, pid: null, startedAt: job.startedAt, endedAt: job.endedAt, elapsedMs: Math.max(0, (job.endedAt ?? this.now()) - job.startedAt), escalated: false, error: null, tail: job.tail }));
  }
  // Changes come in bursts (output): published at most once a second, and at once when a job starts or ends.
  publish(now = false) {
    if (!now) { if (!this.timer) { this.timer = setTimeout(() => { this.timer = null; this.publish(true); }, 1000); this.timer.unref?.(); } return; }
    clearTimeout(this.timer); this.timer = null;
    this.revision += 1;
    this.emit({ type: 'extension_ui_request', id: randomUUID(), method: 'setStatus', statusKey: 'iris-background', statusText: JSON.stringify({ generation: this.generation, revision: this.revision, jobs: this.snapshot() }) });
  }
  close() { clearTimeout(this.timer); this.timer = null; }
}
