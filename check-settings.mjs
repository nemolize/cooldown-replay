// Runs each package manager's cooldown setting against one package whose publish times straddle the cooldown,
// and compares the version it resolves with the version the registry's publish times say should be eligible.
// Usage: node check-settings.mjs [--out <file>]   (needs network; installs from tools/ and tools-berry/ first, see README.md)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = (dir, name) => resolve(here, dir, 'node_modules', '.bin', name);
const PKG = 'chalk';
const RANGE = '^5';
const DAY_MS = 86_400_000;

const registryRes = await fetch(`https://registry.npmjs.org/${PKG}`);
if (!registryRes.ok) throw new Error(`registry ${PKG}: HTTP ${registryRes.status}`);
const { time } = await registryRes.json();
const versions = Object.entries(time)
  .filter(([v]) => /^5\.\d+\.\d+$/.test(v))
  .map(([v, t]) => ({ v, t: Date.parse(t) }))
  .sort((a, b) => a.t - b.t);
const now = Date.now();
let hi = versions.length - 1;
while (hi > 0 && (versions[hi].t - versions[hi - 1].t) < 2 * DAY_MS) hi--;
if (hi === 0) throw new Error(`${PKG}${RANGE} has no two versions at least 2 days apart`);
const newerAge = (now - versions[hi].t) / DAY_MS;
const olderAge = (now - versions[hi - 1].t) / DAY_MS;
const days = Math.floor((newerAge + olderAge) / 2);
const eligible = versions.filter((x) => x.t <= now - days * DAY_MS).at(-1).v;
const latest = versions.at(-1).v;
console.error(`package ${PKG}${RANGE}: latest ${latest}; cooldown ${days} days -> expected ${eligible}`);

const cases = [
  { tool: 'npm', setting: `min-release-age=${days}`, unit: 'days', files: { '.npmrc': `min-release-age=${days}\n` },
    cmd: [bin('tools', 'npm'), ['install', '--package-lock-only', '--ignore-scripts']], lock: 'package-lock.json', re: /"node_modules\/chalk": \{\s*"version": "([^"]+)"/ },
  { tool: 'pnpm', setting: `minimum-release-age=${days * 1440} (.npmrc)`, unit: 'minutes', files: { '.npmrc': `minimum-release-age=${days * 1440}\n` },
    cmd: [bin('tools', 'pnpm'), ['install', '--lockfile-only', '--ignore-scripts']], lock: 'pnpm-lock.yaml', re: /chalk@(\d+\.\d+\.\d+):/ },
  { tool: 'pnpm', setting: `minimumReleaseAge: ${days * 1440} (pnpm-workspace.yaml)`, unit: 'minutes', files: { 'pnpm-workspace.yaml': `minimumReleaseAge: ${days * 1440}\n` },
    cmd: [bin('tools', 'pnpm'), ['install', '--lockfile-only', '--ignore-scripts']], lock: 'pnpm-lock.yaml', re: /chalk@(\d+\.\d+\.\d+):/ },
  { tool: 'npm', setting: `--min-release-age=${days} (flag)`, unit: 'days', files: {},
    cmd: [bin('tools', 'npm'), ['install', '--package-lock-only', '--ignore-scripts', `--min-release-age=${days}`]], lock: 'package-lock.json', re: /"node_modules\/chalk": \{\s*"version": "([^"]+)"/ },
  { tool: 'pnpm', setting: `--minimum-release-age=${days * 1440} (flag)`, unit: 'minutes', files: {},
    cmd: [bin('tools', 'pnpm'), ['install', '--lockfile-only', '--ignore-scripts', `--minimum-release-age=${days * 1440}`]], lock: 'pnpm-lock.yaml', re: /chalk@(\d+\.\d+\.\d+):/ },
  { tool: 'bun', setting: `[install] minimumReleaseAge = ${days * 86400} (bunfig.toml)`, unit: 'seconds', files: { 'bunfig.toml': `[install]\nminimumReleaseAge = ${days * 86400}\n` },
    cmd: [bin('tools', 'bun'), ['install', '--lockfile-only']], lock: 'bun.lock', re: /"chalk@(\d+\.\d+\.\d+)"/ },
  { tool: 'bun', setting: `--minimum-release-age=${days * 86400}`, unit: 'seconds', files: {},
    cmd: [bin('tools', 'bun'), ['install', '--lockfile-only', `--minimum-release-age=${days * 86400}`]], lock: 'bun.lock', re: /"chalk@(\d+\.\d+\.\d+)"/ },
  { tool: 'yarn', setting: `npmMinimalAgeGate: ${days * 1440} (.yarnrc.yml, bare number)`, unit: 'minutes', files: { '.yarnrc.yml': `npmMinimalAgeGate: ${days * 1440}\n` },
    cmd: [bin('tools-berry', 'yarn'), ['install', '--mode=update-lockfile']], lock: 'yarn.lock', re: /^"?chalk@[^\n]*:\n\s+version: (\S+)/m },
  { tool: 'yarn', setting: `npmMinimalAgeGate: "${days}d" (.yarnrc.yml, duration string)`, unit: 'duration string', files: { '.yarnrc.yml': `npmMinimalAgeGate: "${days}d"\n` },
    cmd: [bin('tools-berry', 'yarn'), ['install', '--mode=update-lockfile']], lock: 'yarn.lock', re: /^"?chalk@[^\n]*:\n\s+version: (\S+)/m },
];

const out = [];
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'cooldown-check-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const work = join(dir, 'proj');
  mkdirSync(work);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true, dependencies: { [PKG]: RANGE } }));
  for (const [f, body] of Object.entries(c.files)) writeFileSync(join(work, f), body);
  const r = spawnSync(c.cmd[0], c.cmd[1], { cwd: work, encoding: 'utf8', env: { ...process.env, HOME: home, npm_config_userconfig: join(home, '.npmrc'), CI: 'true' } });
  let resolved = null;
  if (existsSync(join(work, c.lock))) resolved = readFileSync(join(work, c.lock), 'utf8').match(c.re)?.[1] ?? null;
  const row = { tool: c.tool, setting: c.setting, unit: c.unit, cooldownDays: days, expected: eligible, latest, resolved, exit: r.status, matches: resolved === eligible, stderr: resolved === eligible ? '' : (r.stderr || '').split('\n').filter((l) => !l.startsWith('npm warn Unknown user config')).slice(0, 3).join(' | ') };
  out.push(row);
  console.log(JSON.stringify(row));
}
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], out.map((r) => JSON.stringify(r)).join('\n') + '\n');
