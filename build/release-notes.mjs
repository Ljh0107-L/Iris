// Prints the CHANGELOG.md section of one version, for the GitHub release. Usage: node build/release-notes.mjs 0.1.0
import { readFileSync } from 'node:fs';

const version = process.argv[2];
const sections = readFileSync('CHANGELOG.md', 'utf8').split(/^## /m).slice(1);
const section = sections.find(text => text.startsWith(`${version} `) || text.startsWith(`${version}\n`));
if (!section) throw new Error(`CHANGELOG.md has no section for ${version}.`);
process.stdout.write(section.slice(section.indexOf('\n') + 1).trim() + '\n');
