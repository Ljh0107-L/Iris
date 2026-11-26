// Visuals in the real app (Electron: the iris-visual pages are served by its main process), shown by a stand-in
// Codex: a page is as tall as it is, sits on the conversation with nothing around it, takes the conversation's
// colours, and fills the window above everything.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './harness.mjs';
import { FAKE_CODEX } from './fake-codex.mjs';

const dir = '/tmp/iris-visual-ui', bin = join(dir, 'bin'), work = '/tmp/iris-visual-ui-work', pageFile = join(dir, 'page.html');
rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
mkdirSync(bin, { recursive: true }); mkdirSync(work, { recursive: true });
mkdirSync(join(dir, 'cli-accounts/codex/default'), { recursive: true }); writeFileSync(join(dir, 'cli-accounts/codex/default/auth.json'), '{}');
writeFileSync(join(dir, 'fake.js'), FAKE_CODEX); writeFileSync(join(dir, 'log'), '');
// The app passes the CLI no test variables: the stand-in is started by a script that sets them.
writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexport FAKE_CODEX_LOG='${join(dir, 'log')}' FAKE_CODEX_SIGNED_OUT='${join(dir, 'signed-out')}'\nexport FAKE_CODEX_VISUAL_FILE='${pageFile}'\nexec '${process.execPath}' '${join(dir, 'fake.js')}' "$@"\n`);
chmodSync(join(bin, 'codex'), 0o755);
const PAGES = {
  // A page of its own colours, set in the middle of its body (it was set in empty space when served in quirks mode).
  dark: `<!doctype html><html><head><style>body{background:#121212;color:#fff;display:flex;align-items:center;gap:40px;padding:40px}</style></head><body><svg width="300" height="300"></svg><div>63.7%</div></body></html>`,
  // A fragment that paints no background: it sits on the conversation, in its colours.
  plain: '<h3>Plain</h3><p>No background of its own.</p>',
  // A page as tall as its frame (100vh) and a little more: it must not grow without end.
  tall: '<canvas style="display:block;width:100%;height:100vh"></canvas><p>below</p>',
};
writeFileSync(pageFile, PAGES.dark);
const { app, page } = await launch({ userData: dir, width: 1300, height: 900, env: { IRIS_TEST_CLI_DIR: bin } });
const frameHeight = () => page.evaluate(() => Math.round(document.querySelectorAll('.visual-card:not(.folded) iframe')[document.querySelectorAll('.visual-card:not(.folded) iframe').length - 1].getBoundingClientRect().height));
try {
  await page.evaluate(work => window.iris.invoke('createSession', { environmentId: 'local', cwd: work, engine: 'codex', prompt: 'Visuals', creationId: 'pending:1' }), work);
  await page.locator('.session-row').first().click();
  const box = page.locator('.dock textarea[aria-label="Message"]');
  const show = async name => {
    writeFileSync(pageFile, PAGES[name]);
    const before = await page.locator('.visual-card iframe').count();
    await box.fill('show a visual'); await box.press('Enter');
    await page.waitForFunction(n => document.querySelectorAll('.visual-card iframe').length > n, before, { timeout: 30000 });
    await page.waitForTimeout(1500);
  };
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await show('dark');
  assert.equal(await page.locator('.visual-card .visual-head').count(), 0, 'no heading or frame around the page');
  assert.ok(Math.abs(await frameHeight() - 380) <= 4, `as tall as the page (300 + 2 × 40): ${await frameHeight()}`);
  const inside = page.frameLocator('.visual-card iframe').last();
  assert.equal(await inside.locator('html').evaluate(() => document.compatMode), 'CSS1Compat', 'a standards-mode page');
  await show('plain');
  const plain = page.frameLocator('.visual-card iframe').last();
  assert.ok(await frameHeight() < 160, `a short page, a short frame: ${await frameHeight()}`);
  assert.equal(await plain.locator('html').evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'dark', 'the conversation’s colours');
  assert.equal(await plain.locator('body').evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)', 'nothing painted behind it');
  await show('tall');
  const tall = await frameHeight();
  await page.waitForTimeout(1500);
  assert.equal(await frameHeight(), tall, 'a page as tall as its frame stops growing');
  assert.ok(tall < 600, `and stays near its first height: ${tall}`);
  // Filling the window: above the sidebar, the title bar and the message box; Escape goes back.
  await page.locator('.visual-card').last().getByRole('button', { name: 'Fill the window' }).click();
  const sheet = await page.locator('.visual-sheet').evaluate(el => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 20, r.top + r.height / 2); return { left: r.left, right: innerWidth - r.right, width: innerWidth, covers: el.contains(top) }; });
  assert.ok(sheet.left <= sheet.width * 0.05 && sheet.right <= sheet.width * 0.05 && sheet.covers, JSON.stringify(sheet));
  await page.keyboard.press('Escape');
  await page.locator('.visual-overlay').waitFor({ state: 'detached' });
  console.log('PASS visuals in the app: as tall as the page, no frame, the conversation’s colours, a 100vh page that stops growing, filling the window');
} finally {
  await app.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
}
