// Writes release/latest-mac.yml: the version and the SHA-512 and size of each zip. The app's updater reads
// this file from the latest GitHub release (app/main/updater.mjs) and verifies what it downloads against it.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const files = readdirSync('release').filter(name => name.endsWith('.zip')).map(name => {
  const data = readFileSync(`release/${name}`);
  return `  - url: ${name}\n    sha512: ${createHash('sha512').update(data).digest('base64')}\n    size: ${data.length}`;
});
if (!files.length) throw new Error('No zip in release/: package the app first.');
const manifest = `version: ${version}\nfiles:\n${files.join('\n')}\nreleaseDate: ${new Date().toISOString()}\n`;
writeFileSync('release/latest-mac.yml', manifest);
process.stdout.write(manifest);
