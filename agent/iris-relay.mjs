#!/usr/bin/env node
// Iris relay: keeps Pi sessions running on a host while the desktop is disconnected.
//
//   node iris-relay.mjs attach   stdin/stdout bridge for one desktop connection (run over SSH)
//   node iris-relay.mjs daemon   the long-lived owner of Pi processes (started on demand, detached)
//   node iris-relay.mjs list     JSON summary of sessions
//   node iris-relay.mjs stop ID  terminate a session's Pi process and its tools
//   node iris-relay.mjs stop-for-update ID  stop a session so an updated app can start it again
//   node iris-relay.mjs stop-compatible ID  stop a session; succeeds when no daemon is running
//   node iris-relay.mjs shutdown terminate every session and the daemon (local app quit only)
//
// The daemon listens on ~/.iris/run/relay.sock (directory 0700, socket 0600). Every line Pi writes
// is numbered and kept in a bounded log; a re-attaching client sends the last number it saw and gets
// everything after it, plus any extension dialogs (approvals) still waiting for an answer.
//
// Secrets: the attach handshake carries the session's boot record (provider keys). The daemon writes it
// to Pi on an extra pipe (descriptor 3, named by IRIS_BOOT_FD) and does not keep it. It is never put in
// the environment, which stays readable to the same user for the life of the process.
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const RUN_DIR = process.env.IRIS_RUN_DIR ?? join(homedir(), '.iris', 'run');
const SOCKET = join(RUN_DIR, 'relay.sock');
const LOG_LIMIT_BYTES = 16 * 1024 * 1024;
const CLIENT_CHUNK_BYTES = 64 * 1024;
const CLIENT_DRAIN_MS = 30000;
const STOP_TERM_MS = 500;
const STOP_KILL_MS = 2000;
const STOP_TIMEOUT_MS = 5000;
const CONTROL_TIMEOUT_MS = STOP_TIMEOUT_MS + 3000;
const EXITED_RETENTION_MS = 30 * 60 * 1000;
const IDLE_EXIT_MS = 15 * 60 * 1000;
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);

function lineReader(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  });
}
const reply = (socket, value) => {
  if (!socket.destroyed && !socket.writableEnded) socket.end(JSON.stringify(value) + '\n');
};

// Pi's bash tool and background jobs create their own groups. Capture those groups by
// ancestry before sending EOF, then keep following them even after the leader exits.
const exec = promisify(execFile);
async function readProcesses(verify = false) {
  if (process.platform === 'linux') {
    // Works on minimal Linux hosts too (BusyBox ps may not expose process group IDs).
    const rows = [];
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const [state, parent, group] = fields;
        // starttime is field 22; fields here start at field 3 (state).
        if (verify && (!state || ![parent, group, fields[19]].every(n => /^\d+$/.test(n)))) throw new Error('Unexpected process table format');
        rows.push({ pid: Number(entry), parent: Number(parent), group: Number(group), state, started: fields[19] });
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
        if (verify || !['EACCES', 'EPERM'].includes(error.code)) throw error;
      }
    }
    return rows;
  }
  const { stdout } = await exec('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='], {
    timeout: 1000, maxBuffer: 4 * 1024 * 1024,
    ...(verify ? { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } } : {}),
  });
  return stdout.trim().split('\n').map(line => {
    const [pid, parent, group, state, ...started] = line.trim().split(/\s+/);
    if (!state || !started.length || ![pid, parent, group].every(n => /^\d+$/.test(n))) throw new Error('Unexpected process table format');
    return { pid: Number(pid), parent: Number(parent), group: Number(group), state, started: started.join(' ') };
  });
}

function updateGroups(groups, processes, child) {
  const children = new Map(), members = new Map(), live = new Set(), owned = [], seen = new Set();
  const previous = new Map();
  for (const group of groups.values()) if (group) for (const [pid, started] of group) previous.set(pid, started);
  const initial = groups.get(child.pid) === null && child.exitCode === null && child.signalCode === null;
  for (const p of processes) {
    if (!children.has(p.parent)) children.set(p.parent, []);
    children.get(p.parent).push(p);
    if (!members.has(p.group)) members.set(p.group, []);
    members.get(p.group).push(p);
    // Zombies cannot run or write files, and an orphaned zombie may linger on Linux.
    if (!/^[ZXx]/.test(p.state)) live.add(p.group);
    if ((p.started && previous.get(p.pid) === p.started) ||
        (initial && p.pid === child.pid && p.group === child.pid && p.parent === process.pid)) owned.push(p);
  }
  // A PGID alone is not proof of ownership, even during escalation. Seed each scan
  // from the original child or a process seen in an earlier scan with the same birth time.
  const confirmed = new Set();
  while (owned.length) {
    const p = owned.pop();
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    if (p.group <= 1) continue;
    if (!confirmed.has(p.group)) {
      confirmed.add(p.group);
      for (const member of members.get(p.group)) if (!seen.has(member.pid)) owned.push(member);
    }
    for (const descendant of children.get(p.pid) ?? []) owned.push(descendant);
  }
  for (const group of groups.keys()) {
    if ((live.has(group) && !confirmed.has(group)) || (!members.has(group) && signalGroup(group, 0))) {
      throw new Error(`Could not verify ownership of process group ${group}`);
    }
  }
  groups.clear();
  for (const group of confirmed) if (live.has(group)) {
    groups.set(group, new Map(members.get(group).map(p => [p.pid, p.started])));
  }
}

function signalGroup(group, signal) {
  try { process.kill(-group, signal); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// ------------------------------------------------------------------ daemon
function runDaemon() {
  const sessions = new Map();
  let idleTimer = null, processScan = null;
  let shuttingDown = false;
  const snapshot = () => processScan ??= readProcesses().finally(() => { processScan = null; });
  const touch = () => {
    clearTimeout(idleTimer);
    const busy = [...sessions.values()].some(s => !s.exit || s.clients.size);
    if (!busy) idleTimer = setTimeout(() => process.exit(0), IDLE_EXIT_MS);
  };

  const firstSeq = session => session.seq - session.log.length + session.logHead + 1;

  function writeFrame(client, frame) {
    while (client.offset < frame.length && !client.drainTimer) {
      const end = Math.min(client.offset + CLIENT_CHUNK_BYTES, frame.length);
      // Don't pin a large, possibly evicted frame behind a single queued slice.
      const chunk = frame.length <= CLIENT_CHUNK_BYTES ? frame : Buffer.from(frame.subarray(client.offset, end));
      const more = client.socket.write(chunk);
      client.offset = end;
      if (!more) client.drainTimer = setTimeout(() => client.socket.destroy(), CLIENT_DRAIN_MS);
    }
    if (client.offset < frame.length) return false;
    client.offset = 0;
    return true;
  }

  function pump(session, client) {
    const { socket } = client;
    if (socket.destroyed || socket.writableEnded) return;
    const first = firstSeq(session);
    // Live output and replay share one bounded log. Never queue a private copy for a
    // lagging client. If it gets too far behind, a new attach can replay or report a gap.
    if (client.nextSeq < first) { socket.destroy(); return; }
    while (!client.drainTimer) {
      if (client.nextSeq > client.replayThrough && client.pending) {
        if (!client.pendingFrame) {
          const { value, done } = client.pending.next();
          if (done) { client.pending = null; continue; }
          if (value.seq > client.replayThrough) continue; // this request will arrive live
          if (!value.pendingFrame) {
            const line = value.frame.toString('utf8', 0, value.frame.length - 1);
            value.pendingFrame = Buffer.from(JSON.stringify({ relay: 'pending', lines: [line] }) + '\n');
          }
          client.pendingFrame = value.pendingFrame;
        }
        if (writeFrame(client, client.pendingFrame)) client.pendingFrame = null;
      } else if (client.nextSeq <= session.seq) {
        const frame = session.log[session.logHead + client.nextSeq - first];
        if (writeFrame(client, frame)) client.nextSeq++;
      } else {
        if (session.exit) reply(socket, { relay: 'exit', code: session.exit.code, signal: session.exit.signal, stderr: session.exit.stderr });
        break;
      }
    }
  }

  function finishSession(session) {
    session.exit = session.childExit;
    session.pendingUi.clear();
    for (const client of session.clients) pump(session, client);
    setTimeout(() => { if (sessions.get(session.id) === session) sessions.delete(session.id); touch(); }, EXITED_RETENTION_MS).unref();
    touch();
  }

  function spawnSession(id, spec, boot) {
    const env = { ...process.env, ...spec.env, IRIS_BOOT_FD: '3' };
    delete env.IRIS_BOOT;
    // On supported POSIX hosts detached starts a new session and process group (not a new tty).
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    child.stdio[3].on('error', () => {}); // a process that never reads its boot record
    child.stdio[3].end(JSON.stringify(boot ?? {}));
    const groups = new Map(child.pid > 1 ? [[child.pid, null]] : []);
    const session = { id, child, groups, cwd: spec.cwd, seq: 0, log: [], logHead: 0, logBytes: 0, pendingUi: new Map(), clients: new Set(), exit: null, startedAt: Date.now(), stderr: '' };
    sessions.set(id, session);
    let stdoutYield = null;
    lineReader(child.stdout, line => {
      if (!line.startsWith('{') || line.length < 3) return; // Pi's stdout carries only JSON records
      session.seq += 1;
      const frame = Buffer.from('{"_seq":' + session.seq + ',' + line.slice(1) + '\n');
      session.log.push(frame);
      session.logBytes += frame.length;
      // Keep one oversize record (e.g. a large get_messages reply); writes still use bounded chunks.
      while (session.logBytes > LOG_LIMIT_BYTES && session.log.length > session.logHead + 1) {
        session.logBytes -= session.log[session.logHead].length;
        session.log[session.logHead++] = null;
      }
      if (session.logHead >= 4096 && session.logHead * 2 >= session.log.length) {
        session.log = session.log.slice(session.logHead);
        session.logHead = 0;
      }
      try {
        const record = JSON.parse(line);
        if (record.type === 'extension_ui_request' && DIALOGS.has(record.method)) session.pendingUi.set(record.id, { seq: session.seq, frame });
        if (record.type === 'extension_ui_dismiss') session.pendingUi.delete(record.id);
      } catch { /* non-JSON output is still forwarded */ }
      let blocked = false;
      for (const client of session.clients) {
        pump(session, client);
        if (client.drainTimer && !client.socket.destroyed) blocked = true;
      }
      // A busy Pi pipe can monopolize the I/O loop. Give socket drains a turn, but
      // never make Pi wait for a particular reader: unattended sessions must run on.
      if (blocked && !stdoutYield) {
        child.stdout.pause();
        stdoutYield = setTimeout(() => { stdoutYield = null; child.stdout.resume(); }, 1);
      }
    });
    child.stderr.on('data', d => { session.stderr = (session.stderr + d).slice(-8000); });
    child.on('close', (code, signal) => {
      session.childExit = { code, signal, at: Date.now(), stderr: session.stderr.slice(-2000) };
      if (session.stopRequested) return;
      // A group can outlive Pi even when none of its members hold Pi's pipes open.
      // Check immediately, not later when the ID could have been reused.
      try {
        if (!groups.size || !signalGroup(child.pid, 0)) { finishSession(session); return; }
      } catch { /* try cleanup and keep the session available for retry if it fails */ }
      stopSession(session).catch(error => process.stderr.write(`iris-relay: ${error.message}\n`));
    });
    child.on('error', error => { session.stderr += `\nspawn failed: ${error.message}`; });
    child.stdin.on('error', () => {});
    return session;
  }

  function stopSession(session) {
    if (session.stopping) return session.stopping;
    if (session.exit) return Promise.resolve();
    session.stopRequested = true;
    session.stopping = (async () => {
      const start = performance.now();
      const terminated = new Set();
      for (;;) {
        if (session.groups.size) updateGroups(session.groups, await snapshot(), session.child);
        if (session.childExit && !session.groups.size) { finishSession(session); return; }
        // Keep polling through escalation: the leader closing its stdio is not proof
        // that independently reparented tools are gone.
        const elapsed = performance.now() - start;
        if (elapsed >= STOP_TIMEOUT_MS) throw new Error(`Timed out stopping session ${session.id}`);
        if (!session.child.stdin.writableEnded) session.child.stdin.end();
        for (const group of session.groups.keys()) {
          if (elapsed >= STOP_KILL_MS) signalGroup(group, 'SIGKILL');
          else if (elapsed >= STOP_TERM_MS && !terminated.has(group)) {
            signalGroup(group, 'SIGTERM');
            terminated.add(group);
          }
        }
        await sleep(75);
      }
    })().finally(() => { session.stopping = null; });
    return session.stopping;
  }

  function attach(socket, message) {
    if (shuttingDown) throw new Error('Relay is shutting down');
    let session = sessions.get(message.sessionId);
    let created = false;
    if (!session || session.exit) {
      if (!message.spawn) throw new Error('Session is not running');
      const spec = message.spawn;
      if (!Array.isArray(spec.argv) || !spec.argv.length || spec.argv.some(a => typeof a !== 'string') || typeof spec.cwd !== 'string') throw new Error('Invalid spawn specification');
      session = spawnSession(message.sessionId, spec, message.boot);
      created = true;
    }
    if (session.stopRequested) throw new Error('Session is stopping; retry after stop completes');
    delete message.boot;
    const first = firstSeq(session);
    const replayThrough = session.seq;
    const since = !created && Number.isSafeInteger(message.sinceSeq) ? Math.min(message.sinceSeq, replayThrough) : replayThrough;
    const client = { socket, replayThrough, nextSeq: Math.max(first, since + 1), offset: 0, pending: session.pendingUi.values() };
    session.clients.add(client);
    socket.on('drain', () => { clearTimeout(client.drainTimer); client.drainTimer = null; pump(session, client); });
    socket.on('close', () => { clearTimeout(client.drainTimer); session.clients.delete(client); touch(); });
    socket.write(JSON.stringify({ relay: 'attached', created, lastSeq: replayThrough, pid: session.child.pid, startedAt: session.startedAt }) + '\n');
    if (since + 1 < first) socket.write(JSON.stringify({ relay: 'gap', from: since, firstSeq: first }) + '\n');
    pump(session, client);
    touch();
    return session;
  }

  const server = net.createServer({ highWaterMark: CLIENT_CHUNK_BYTES }, socket => {
    socket.on('error', () => {});
    let session = null;
    let first = true;
    lineReader(socket, line => {
      if (first) {
        first = false;
        let message;
        try { message = JSON.parse(line); } catch { socket.end(); return; }
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.end(); return; }
        if (message.op === 'list') {
          reply(socket, { relay: 'list', sessions: [...sessions.values()].map(s => ({ id: s.id, pid: s.child.pid, cwd: s.cwd, alive: !s.exit, exit: s.exit, startedAt: s.startedAt, lastSeq: s.seq, clients: s.clients.size, pendingUi: s.pendingUi.size })) });
          return;
        }
        if (message.op === 'stop-tree') {
          if (typeof message.sessionId !== 'string' || !message.sessionId) {
            reply(socket, { relay: 'error', error: 'Invalid session id' });
            return;
          }
          const s = sessions.get(message.sessionId);
          // Acknowledgement means neither Pi nor its tools can still write the session.
          const stopped = s ? stopSession(s) : Promise.resolve();
          stopped.then(() => reply(socket, { relay: 'stopped', found: !!s }), error => reply(socket, { relay: 'error', error: error.message }));
          return;
        }
        if (message.op === 'shutdown') {
          // Sessions here need not outlive the desktop: stop them all, answer, then exit.
          if (shuttingDown) { reply(socket, { relay: 'error', error: 'Relay is already shutting down' }); return; }
          shuttingDown = true;
          Promise.allSettled([...sessions.values()].filter(s => !s.exit).map(stopSession)).then(results => {
            const failure = results.find(result => result.status === 'rejected');
            if (failure) {
              shuttingDown = false;
              reply(socket, { relay: 'error', error: failure.reason.message });
              return;
            }
            reply(socket, { relay: 'shutdown', stopped: sessions.size });
            server.close();
            setTimeout(() => process.exit(0), 50);
          });
          return;
        }
        if (message.op === 'attach') {
          try {
            if (typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('Invalid session id');
            session = attach(socket, message);
          } catch (error) { reply(socket, { relay: 'error', error: error.message }); }
          return;
        }
        socket.end(); return;
      }
      if (!session || session.stopRequested || session.exit) return;
      // Answering a dialog clears it from the pending set.
      if (line.includes('"extension_ui_response"')) {
        try { const r = JSON.parse(line); if (r.type === 'extension_ui_response') session.pendingUi.delete(r.id); } catch { /* forward anyway */ }
      }
      session.child.stdin.write(line + '\n');
    });
  });

  const listen = () => server.listen(SOCKET, () => { chmodSync(SOCKET, 0o600); touch(); });
  server.on('error', error => {
    if (!['EADDRINUSE', 'EEXIST'].includes(error.code)) throw error;
    // Another daemon may own the socket; if nobody answers it is stale.
    const probe = net.connect(SOCKET);
    probe.on('connect', () => { probe.destroy(); process.exit(0); });
    probe.on('error', () => { try { unlinkSync(SOCKET); } catch { /* raced */ } listen(); });
  });
  process.on('SIGHUP', () => {}); // belt and braces: we run in our own session anyway
  listen();
}

// ------------------------------------------------------------------ client side
function connect(address = SOCKET) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function connectOrStart() {
  try { return await connect(); } catch { /* start below */ }
  mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
  chmodSync(RUN_DIR, 0o700);
  const lock = join(RUN_DIR, 'startup2.lock');
  // Multiple pre-warms/reconnects can arrive together. Only one launcher may probe,
  // replace a stale socket and start a daemon; never unlink another starter's socket.
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await connect(); } catch { /* start or wait for its owner below */ }
    let fd;
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (e) { if (e.code === 'ESRCH') unlinkSync(lock); }
        }
      } catch { /* the owner just released it */ }
      await new Promise(r => setTimeout(r, 100));
      continue;
    }
    try {
      writeFileSync(fd, String(process.pid));
      closeSync(fd); fd = undefined;
      try { return await connect(); } catch { /* still no daemon */ }
      const log = openSync(join(RUN_DIR, 'relay.log'), 'a', 0o600);
      let launchError;
      try {
        const daemon = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon'], { detached: true, stdio: ['ignore', log, log], cwd: homedir() });
        daemon.on('error', error => { launchError = error; });
        daemon.unref();
      } finally { closeSync(log); }
      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (launchError) throw launchError;
        try { return await connect(); } catch { /* not ready yet */ }
      }
      throw new Error(`relay daemon did not start; see ${join(RUN_DIR, 'relay.log')}`);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(lock); } catch { /* already removed */ }
    }
  }
  throw new Error(`relay startup timed out; see ${join(RUN_DIR, 'relay.log')}`);
}

const OFFLINE = ['ENOENT', 'ECONNREFUSED'];
async function request(address, message, expected, absent = []) {
  const out = await new Promise((resolve, reject) => {
    const socket = net.connect(address);
    let out = '', connected = false;
    const timer = setTimeout(() => socket.destroy(new Error('Timed out waiting for relay acknowledgement')), CONTROL_TIMEOUT_MS);
    socket.on('connect', () => {
      connected = true;
      socket.write(JSON.stringify(message) + '\n');
    });
    socket.setEncoding('utf8');
    socket.on('data', chunk => { out += chunk; });
    socket.on('error', error => {
      if (!connected && absent.includes(error.code)) resolve(null);
      else reject(error);
    });
    socket.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
  if (out === null) return null;
  let response;
  try { response = JSON.parse(out); } catch { /* incomplete or unsupported reply */ }
  if (response?.relay === 'error') throw new Error(response.error);
  if (response?.relay !== expected) throw new Error(`No relay ${message.op} acknowledgement`);
  return response;
}

async function listOn(address) {
  const response = await request(address, { op: 'list' }, 'list', OFFLINE);
  if (response && (!Array.isArray(response.sessions) || response.sessions.some(s =>
    typeof s?.id !== 'string' || !s.id || typeof s.alive !== 'boolean'))) throw new Error('Invalid relay session list');
  return response;
}

async function listSessions() {
  const current = await listOn(SOCKET);
  return { relay: 'list', sessions: current?.sessions ?? [], ...(!current ? { daemon: false } : {}) };
}

// `stop` needs a running daemon to acknowledge the process-tree stop. `stop-compatible` (cleanup of a
// saved conversation) also succeeds when no daemon is running.
async function stopForCli(sessionId, compatible) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id');
  return stopTree(sessionId, compatible ? OFFLINE : []);
}

async function stopTree(sessionId, absent = []) {
  const reply = await request(SOCKET, { op: 'stop-tree', sessionId }, 'stopped', absent);
  if (!reply) return { relay: 'stopped', found: false, daemon: false };
  if (typeof reply.found !== 'boolean') throw new Error('Invalid process-tree stop acknowledgement');
  return reply;
}

// Before an app update replaces a session's process: nothing to do when it is not running; otherwise the
// daemon must acknowledge that the whole process tree stopped.
async function stopForUpdate(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session id');
  const list = await listOn(SOCKET);
  const matches = list?.sessions.filter(s => s.id === sessionId) ?? [];
  if (matches.length > 1) throw new Error('Relay listed duplicate session identities; refusing an ambiguous stop');
  if (!matches[0]?.alive) return { relay: 'stopped', found: false, ...(!list ? { daemon: false } : {}) };
  const ack = await stopTree(sessionId);
  if (!ack.found) throw new Error('Relay did not acknowledge stopping the listed session');
  return ack;
}

async function shutdownDaemon() {
  const reply = await request(SOCKET, { op: 'shutdown' }, 'shutdown', OFFLINE);
  return { relay: 'shutdown', stopped: Number.isSafeInteger(reply?.stopped) ? reply.stopped : 0, ...(!reply ? { daemon: false } : {}) };
}

async function runControl(command, sessionId) {
  try {
    const response = command === 'list' ? await listSessions() : command === 'shutdown' ? await shutdownDaemon()
      : command === 'stop-for-update' ? await stopForUpdate(sessionId) : await stopForCli(sessionId, command === 'stop-compatible');
    process.stdout.write(JSON.stringify(response) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ relay: 'error', error: error.message }) + '\n');
    process.stderr.write(`iris-relay: ${error.message}\n`);
    process.exitCode = 1;
  }
}

async function runAttach() {
  // Read exactly the handshake line from stdin, then bridge the rest.
  const handshake = await new Promise((resolve, reject) => {
    let buffer = '';
    const onData = chunk => {
      buffer += chunk;
      const i = buffer.indexOf('\n');
      if (i === -1) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      const rest = buffer.slice(i + 1);
      if (rest) process.stdin.unshift(rest);
      resolve(buffer.slice(0, i));
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onData);
    process.stdin.once('end', () => reject(new Error('no handshake')));
  });
  let message;
  try { message = JSON.parse(handshake); } catch { /* do not log the boot record */ }
  if (message?.op !== 'attach' || typeof message.sessionId !== 'string' || !message.sessionId) throw new Error('Invalid attach handshake');
  const socket = await connectOrStart();
  socket.write(handshake + '\n');
  process.stdin.resume();
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  // Do not process.exit() on socket close: stdout may still contain relay:exit or
  // replay records. Let pipe flush before the process exits naturally.
  socket.on('close', () => { process.stdin.unpipe(socket); process.stdin.pause(); });
  socket.on('error', error => { process.stderr.write(`iris-relay: ${error.message}\n`); process.exitCode = 1; });
  process.stdout.on('error', () => { socket.destroy(); process.stdin.destroy(); });
  process.stdin.on('end', () => socket.end());
}

const [command, arg] = process.argv.slice(2);
if (command === 'daemon') runDaemon();
else if (command === 'attach') runAttach().catch(error => { process.stderr.write(`iris-relay: ${error.message}\n`); process.exit(1); });
else if (['list', 'stop', 'stop-for-update', 'stop-compatible', 'shutdown'].includes(command)) runControl(command, arg);
else { process.stderr.write('usage: iris-relay.mjs attach|daemon|list|stop <id>|stop-for-update <id>|stop-compatible <id>|shutdown\n'); process.exit(2); }
