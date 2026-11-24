import test from 'node:test';
import assert from 'node:assert/strict';
import { readSignInOutput } from '../app/renderer/src/sign-in-output.js';

const link = 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1-abc.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=VaE_Eq';
const prompt = `Open this link in a browser to log in with Google:\r\n\r\n  ${link}\r\n\r\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\r\n`;

test('the page to open and the wait for its code are read from what the CLI prints', () => {
  assert.deepEqual(readSignInOutput(''), { link: null, wantsCode: false, signedInAs: null, failure: null, refused: false, lastLine: '' });
  // Half of the address has arrived: not a link yet.
  assert.equal(readSignInOutput(prompt.slice(0, 120)).link, null);
  const waiting = readSignInOutput(prompt);
  assert.deepEqual([waiting.link, waiting.wantsCode, waiting.signedInAs, waiting.failure], [link, true, null, null]);
  // Colours and a window title around it change nothing.
  assert.equal(readSignInOutput(`\x1b]0;agy\x07\x1b[1m${prompt}\x1b[0m`).link, link);
});

test('how the sign-in ended is read too', () => {
  const done = readSignInOutput(`${prompt}4/0AUn6Hd9-example\r\nLogged in as dev@example.test.\r\nShared connection to host closed.\r\n`);
  assert.deepEqual([done.signedInAs, done.failure], ['dev@example.test', null]);
  const refused = readSignInOutput(`${prompt}nonsense\r\n\r\ncouldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\r\n`);
  assert.deepEqual([refused.signedInAs, refused.failure, refused.refused], [null, 'token exchange failed: oauth2: "invalid_grant" "Malformed auth code."', true]);
  // The host never reached Google: not the code's fault, and said as what it is.
  const unreachable = readSignInOutput(`${prompt}4/0Afine\r\n\r\ncouldn't log in: token exchange failed: Post "https://oauth2.googleapis.com/token": dial tcp 142.250.0.1:443: i/o timeout\r\n`);
  assert.deepEqual([unreachable.refused, /i\/o timeout/.test(unreachable.failure)], [false, true]);
  assert.equal(readSignInOutput(`${prompt}\r\nlogin cancelled: no authorization code was entered\r\n`).failure, 'login cancelled: no authorization code was entered');
  // It never got as far as a link: what it said last is what there is to show.
  const missing = readSignInOutput('sh: /home/dev/.local/bin/agy: No such file or directory\r\n');
  assert.deepEqual([missing.link, missing.wantsCode, missing.lastLine], [null, false, 'sh: /home/dev/.local/bin/agy: No such file or directory']);
});
