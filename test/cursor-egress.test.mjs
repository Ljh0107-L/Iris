// Cursor on an SSH host sends its requests through the Mac (Cursor offers the models of the region it is asked
// from): the adapter's proxy on the host sends Cursor's domains to the port the SSH connection carries to the
// Mac's egress proxy, and everything else as it went before. Offline: stand-ins for the Mac's proxy, the
// host's own proxy and the far end.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { routeThroughMac } from '../agent/iris-cursor.mjs';
import { startEgressProxy } from '../core/egress-proxy.mjs';
import { cliAccountStatus, cliEngine } from '../app/main/cli-engines.mjs';

// The far end: echoes what it is sent.
async function echoServer(t) {
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.pipe(socket); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); for (const socket of sockets) socket.destroy(); });
  return server.address().port;
}
// A proxy that notes where it was asked to go, and goes to the echo server whatever the name.
async function recordingProxy(t, echoPort) {
  const asked = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => res.writeHead(405).end());
  server.on('connect', (req, client, head) => {
    asked.push(req.url); sockets.add(client);
    const up = net.connect(echoPort, '127.0.0.1', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head?.length) up.write(head); up.pipe(client); client.pipe(up); });
    sockets.add(up);
    up.on('error', () => client.destroy()); client.on('error', () => up.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const close = () => new Promise(resolve => { server.close(resolve); for (const s of sockets) s.destroy(); });
  t.after(close);
  return { port: server.address().port, asked, close };
}
// CONNECT through proxyUrl to target, then send a line and read it back (statusOnly: just the proxy's answer).
function through(proxyUrl, target, { statusOnly = false } = {}) {
  const { port } = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let got = '', open = false;
    socket.on('data', data => {
      got += data;
      if (!open) {
        const end = got.indexOf('\r\n\r\n');
        if (end < 0) return;
        const status = got.slice(0, got.indexOf('\r\n'));
        if (statusOnly || !/ 200 /.test(status)) { socket.destroy(); resolve(status); return; }
        open = true; got = got.slice(end + 4); socket.write('ping\n');
      }
      if (got.includes('ping\n')) { socket.destroy(); resolve('echoed'); }
    });
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error(`no answer for ${target}`)); }, 5000);
  });
}

test('without a port to the Mac, nothing changes', async () => {
  const env = { HTTPS_PROXY: 'http://proxy.example:3128' };
  assert.equal(await routeThroughMac(env), null);
  assert.equal(env.HTTPS_PROXY, 'http://proxy.example:3128');
});

test('Cursor’s domains go to the Mac, the rest straight out, and the CLI and its commands get the proxy', async t => {
  const echo = await echoServer(t), mac = await recordingProxy(t, echo);
  const env = { IRIS_CURSOR_EGRESS: `127.0.0.1:${mac.port}` };
  const route = await routeThroughMac(env);
  t.after(() => route.close());
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) assert.equal(env[key], route.proxy);
  assert.equal(await through(route.proxy, 'api2.cursor.sh:443'), 'echoed');
  assert.equal(await through(route.proxy, 'agentn.us.api5.cursor.sh:443'), 'echoed');
  assert.equal(await through(route.proxy, `127.0.0.1:${echo}`), 'echoed', 'another address: straight out');
  assert.deepEqual(mac.asked, ['api2.cursor.sh:443', 'agentn.us.api5.cursor.sh:443']);
});

test('with the Mac out of reach, and on a host with its own proxy, Cursor goes the way it went before', async t => {
  const echo = await echoServer(t), mac = await recordingProxy(t, echo), own = await recordingProxy(t, echo);
  const env = { IRIS_CURSOR_EGRESS: `127.0.0.1:${mac.port}`, https_proxy: `http://127.0.0.1:${own.port}`, NO_PROXY: '.corp.example,127.0.0.1' };
  const route = await routeThroughMac(env);
  t.after(() => route.close());
  assert.equal(await through(route.proxy, 'api2.cursor.sh:443'), 'echoed');
  assert.equal(await through(route.proxy, 'pypi.org:443'), 'echoed');
  assert.equal(await through(route.proxy, `127.0.0.1:${echo}`), 'echoed', 'NO_PROXY: straight out');
  assert.deepEqual(mac.asked, ['api2.cursor.sh:443']);
  assert.deepEqual(own.asked, ['pypi.org:443'], 'the host’s proxy carries what it carried, not what NO_PROXY names');
  await mac.close();
  assert.equal(await through(route.proxy, 'api2.cursor.sh:443'), 'echoed');
  assert.deepEqual(own.asked, ['pypi.org:443', 'api2.cursor.sh:443'], 'the Mac gone: through the host’s own proxy');
});

test('a host proxy it cannot speak to is left alone', async () => {
  const env = { IRIS_CURSOR_EGRESS: '127.0.0.1:40000', HTTPS_PROXY: 'socks5://127.0.0.1:1080' };
  assert.equal(await routeThroughMac(env), null);
  assert.equal(env.HTTPS_PROXY, 'socks5://127.0.0.1:1080');
});

test('the Mac’s egress proxy lets through a domain with its subdomains, and nothing that only resembles it', async t => {
  const proxy = await startEgressProxy({ allow: ['.b.invalid:9'] });
  t.after(() => proxy.close());
  const url = `http://127.0.0.1:${proxy.port}`;
  const status = target => through(url, target, { statusOnly: true });
  assert.match(await status('x.cursor.sh:443'), / 403 /);
  assert.match(await status('b.invalid.evil.example:9'), / 403 /);
  assert.match(await status('xb.invalid:9'), / 403 /);
  assert.match(await status('a.b.invalid:9'), / 200 | 502 /, 'allowed (whether or not it can be reached)');
  assert.ok(cliEngine('cursor').egress.includes('.cursor.sh:443'));
});

test('Settings checks Cursor on a host through the Mac: the port goes with the command', async () => {
  const runs = [];
  const run = async (env, script, options) => { runs.push({ script, options }); return JSON.stringify({ cliAccountStatus: { signedIn: true, canSignIn: true } }); };
  const facts = { node: '/n/node', root: '/r', adapter: '/r/ext/iris-antigravity.mjs' };
  await cliAccountStatus({ kind: 'ssh', host: 'h' }, { bin: '/b/cursor-agent', facts, engine: 'cursor', forward: { remotePort: 41000, localPort: 5000 }, run });
  assert.match(runs[0].script, /IRIS_CURSOR_EGRESS=127\.0\.0\.1:41000 exec /);
  assert.deepEqual(runs[0].options.forward, { remotePort: 41000, localPort: 5000 });
  await cliAccountStatus({ kind: 'ssh', host: 'h' }, { bin: '/b/codex', facts, engine: 'codex', run });
  assert.doesNotMatch(runs[1].script, /IRIS_CURSOR_EGRESS/);
  assert.equal(runs[1].options.forward, undefined);
});
