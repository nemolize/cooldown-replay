// Finds a package whose newest version is under 20 hours old, then resolves it with each tool and no cooldown setting at all.
// Usage: node check-defaults.mjs [--out <file>]   (needs network; installs from tools/ and tools-berry/ first, see README.md)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const bin = (dir, name) => resolve(here, dir, 'node_modules', '.bin', name);
const DAY_MS = 86_400_000;
const now = Date.now();

const semverCompare = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

async function findTarget() {
  for (const text of ['cli', 'typescript', 'react', 'vite', 'plugin', 'utils', 'sdk', 'api']) {
    const res = await (await fetch(`https://registry.npmjs.org/-/v1/search?text=${text}&size=250&popularity=0&quality=0&maintenance=1`)).json();
    for (const { package: p } of res.objects) {
      if (now - Date.parse(p.date) > 20 * 3_600_000 || /^\d+\.\d+\.\d+-/.test(p.version)) continue;
      const docRes = await fetch(`https://registry.npmjs.org/${p.name.replace('/', '%2f')}`);
      if (!docRes.ok) continue;
      const doc = await docRes.json();
      const major = p.version.split('.')[0];
      const older = Object.entries(doc.time).filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && v.split('.')[0] === major && v !== p.version && now - Date.parse(t) > 2 * DAY_MS);
      const prev = older.map(([v]) => v).sort(semverCompare).at(-1);
      const between = Object.entries(doc.time).filter(([v, t]) => /^\d+\.\d+\.\d+$/.test(v) && v.split('.')[0] === major && v !== p.version && Date.parse(t) > Date.parse(doc.time[prev ?? p.version]));
      if (major !== '0' && prev && doc['dist-tags']?.latest === p.version && between.length === 0) return { name: p.name, range: `^${major}`, latest: p.version, latestAgeHours: (now - Date.parse(doc.time[p.version])) / 3_600_000, previous: prev };
    }
  }
  throw new Error('no package with a version under 20 hours old and an older release of the same major was found');
}

const target = await findTarget();
console.error(`target ${target.name}${target.range}: latest ${target.latest} (${target.latestAgeHours.toFixed(1)} h old), previous ${target.previous}`);
const esc = target.name.replace(/[/.]/g, '\\$&');
const tools = [
  { tool: 'npm', cmd: [bin('tools', 'npm'), ['install', '--package-lock-only', '--ignore-scripts']], lock: 'package-lock.json', re: new RegExp(`"node_modules/${esc}": \\{\\s*"version": "([^"]+)"`) },
  { tool: 'pnpm', cmd: [bin('tools', 'pnpm'), ['install', '--lockfile-only', '--ignore-scripts']], lock: 'pnpm-lock.yaml', re: new RegExp(`['\"]?${esc}@(\\d+\\.\\d+\\.\\d+)['\"]?:`) },
  { tool: 'bun', cmd: [bin('tools', 'bun'), ['install', '--lockfile-only']], lock: 'bun.lock', re: new RegExp(`"${esc}@(\\d+\\.\\d+\\.\\d+)"`) },
  { tool: 'yarn', cmd: [bin('tools-berry', 'yarn'), ['install', '--mode=update-lockfile']], lock: 'yarn.lock', re: new RegExp(`^"?${esc}@[^\\n]*:\\n\\s+version: (\\S+)`, 'm') },
];
const out = [];
for (const t of tools) {
  const dir = mkdtempSync(join(tmpdir(), 'cooldown-default-'));
  const home = join(dir, 'home');
  mkdirSync(home);
  const work = join(dir, 'proj');
  mkdirSync(work);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', private: true, dependencies: { [target.name]: target.range } }));
  const r = spawnSync(t.cmd[0], t.cmd[1], { cwd: work, encoding: 'utf8', env: { ...process.env, HOME: home, npm_config_userconfig: join(home, '.npmrc'), CI: 'true' } });
  const resolved = existsSync(join(work, t.lock)) ? readFileSync(join(work, t.lock), 'utf8').match(t.re)?.[1] ?? null : null;
  const row = { tool: t.tool, package: target.name, range: target.range, latest: target.latest, latestAgeHours: target.latestAgeHours, previous: target.previous, resolved, exit: r.status, appliesCooldownByDefault: resolved === target.previous };
  out.push(row);
  console.log(JSON.stringify(row));
}
const outIdx = process.argv.indexOf('--out');
if (outIdx > 0) writeFileSync(process.argv[outIdx + 1], out.map((r) => JSON.stringify(r)).join('\n') + '\n');
