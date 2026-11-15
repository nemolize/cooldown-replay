// Runs replay-lockfile.mjs for every window in windows.json, two at a time, into data/replay/<name>.jsonl.
// Usage: node replay-all.mjs [name ...]   (no names: all windows; needs network and a GitHub token)
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const only = process.argv.slice(2);
const windows = JSON.parse(readFileSync(join(here, 'windows.json'), 'utf8')).filter((w) => only.length === 0 || only.includes(w.name));
mkdirSync(join(here, 'data', 'replay'), { recursive: true });

const run = (w) =>
  new Promise((resolve) => {
    const args = ['replay-lockfile.mjs', '--repo', w.repo, '--path', w.path, '--out', join('data', 'replay', `${w.name}.jsonl`)];
    if (w.since) args.push('--since', w.since);
    if (w.until) args.push('--until', w.until);
    const child = spawn('node', args, { cwd: here, stdio: 'inherit' });
    child.on('exit', (code) => resolve([w.name, code]));
  });

const queue = [...windows];
const failed = [];
await Promise.all(Array.from({ length: 2 }, async () => {
  for (let w = queue.shift(); w; w = queue.shift()) {
    const [name, code] = await run(w);
    if (code !== 0) failed.push(name);
  }
}));
if (failed.length) {
  console.error(`failed: ${failed.join(', ')}`);
  process.exit(1);
}
