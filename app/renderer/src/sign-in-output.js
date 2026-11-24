// What a CLI's terminal sign-in has printed so far, read so the page can present it as steps instead of a
// terminal: the page to open, whether it is waiting for the code that page shows, and how it ended.
// (Antigravity: `agy acp --login` prints a Google link, takes the authorization code, and says
// "Logged in as …" or "couldn't log in: …".)
const plain = text => String(text ?? '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');

export function readSignInOutput(output) {
  const text = plain(output);
  // Complete once something follows it: the address is printed in one piece, then a new line.
  const link = /(https:\/\/[^\s"'<>]+)\s/.exec(text)?.[1] ?? null;
  const signedInAs = /Logged in as (\S+?)\.?(?:\s|$)/.exec(text)?.[1] ?? null;
  const failed = /couldn['’]t log in: *(.*)/i.exec(text) ?? /(login cancelled[^\n]*)/i.exec(text);
  return {
    link,
    wantsCode: !!link && /paste the authorization code/i.test(text),
    signedInAs,
    failure: signedInAs ? null : failed?.[1].trim() || null,
    // The last thing it said, for when it stops before offering a link (the CLI is missing, the host is away).
    lastLine: text.split('\n').map(line => line.trim()).filter(Boolean).at(-1) ?? '',
  };
}
