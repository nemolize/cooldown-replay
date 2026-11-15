// Walks the git history of one lockfile and records, for every (package, version) that first appears in it,
// how old that version was on the registry at the commit time. Versions already in the window's first snapshot are the baseline.
// Usage: node replay-lockfile.mjs --repo <owner/name> --path <lockfile> [--since <iso>] [--until <iso>] --out <file.jsonl>
// Needs network and a GitHub token (GH_TOKEN, else `gh auth token`).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const repo = arg('repo');
const path = arg('path');
const outFile = arg('out');
if (!repo || !path || !outFile) throw new Error('usage: --repo <owner/name> --path <lockfile> --out <file>');
const since = arg('since');
const until = arg('until');
const token = process.env.GH_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

async function gh(url, accept = 'application/vnd.github+json') {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' } });
    if (res.ok) return res;
    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  throw new Error(`${url}: gave up`);
}

async function commitsTouching() {
  const all = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ path, per_page: '100', page: String(page) });
    if (since) q.set('since', since);
    if (until) q.set('until', until);
    const rows = await (await gh(`https://api.github.com/repos/${repo}/commits?${q}`)).json();
    all.push(...rows.map((c) => ({ sha: c.sha, time: c.commit.committer.date })));
    if (rows.length < 100) break;
  }
  return all.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function entriesOf(text) {
  const out = new Map();
  let unparsed = 0;
  if (path.endsWith('pnpm-lock.yaml')) {
    const projectDocs = parseAllDocuments(text).map((d) => d.toJS()).filter((d) => !d.importers?.['.']?.packageManagerDependencies && !d.importers?.['.']?.configDependencies);
    const packages = Object.assign({}, ...projectDocs.map((d) => d.packages ?? {}));
    for (const [key, val] of Object.entries(packages)) {
      const bare = key.replace(/^\//, '').replace(/\(.*$/, '');
      const at = bare.lastIndexOf('@');
      if (at <= 0 || !val?.resolution?.integrity || val.resolution.tarball || val.resolution.type) { unparsed++; continue; }
      out.set(`${bare.slice(0, at)}@${bare.slice(at + 1)}`, { name: bare.slice(0, at), version: bare.slice(at + 1) });
    }
  } else if (path.endsWith('package-lock.json')) {
    const doc = JSON.parse(text);
    for (const [key, val] of Object.entries(doc.packages ?? {})) {
      if (key === '') continue;
      const name = val.name ?? key.split('node_modules/').pop();
      if (!val.version || val.link || !val.integrity || (val.resolved && !val.resolved.startsWith('https://registry.npmjs.org/'))) { unparsed++; continue; }
      out.set(`${name}@${val.version}`, { name, version: val.version });
    }
  } else throw new Error(`unsupported lockfile: ${path}`);
  return { out, unparsed };
}

const registry = new Map();
async function publishTimes(name) {
  if (!registry.has(name)) {
    registry.set(name, (async () => {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
          if (res.ok) return (await res.json()).time ?? {};
          if (res.status === 404) return null;
        } catch {}
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
      return undefined;
    })());
  }
  return registry.get(name);
}

const commits = await commitsTouching();
const snapshots = [];
for (const c of commits) {
  const text = await (await gh(`https://api.github.com/repos/${repo}/contents/${path}?ref=${c.sha}`, 'application/vnd.github.raw+json')).text();
  snapshots.push({ ...c, ...entriesOf(text) });
}

const events = [];
const seen = new Set(snapshots[0]?.out.keys());
let repeated = 0;
for (let i = 1; i < snapshots.length; i++) {
  const prev = snapshots[i - 1].out;
  const prevNames = new Set([...prev.values()].map((e) => e.name));
  for (const [id, e] of snapshots[i].out) {
    if (prev.has(id)) continue;
    if (seen.has(id)) {
      repeated++;
      continue;
    }
    seen.add(id);
    events.push({ commit: snapshots[i].sha, commitTime: snapshots[i].time, ...e, kind: prevNames.has(e.name) ? 'update' : 'new' });
  }
}

const names = [...new Set(events.map((e) => e.name))];
const queue = [...names];
await Promise.all(Array.from({ length: 8 }, async () => {
  for (let n = queue.pop(); n; n = queue.pop()) await publishTimes(n);
}));

const rows = [];
const lookup = { ok: 0, 'no-publish-time': 0, 'registry-unreadable': 0 };
for (const e of events) {
  const time = await publishTimes(e.name);
  const published = time?.[e.version];
  if (!published) {
    lookup[time === undefined || time === null ? 'registry-unreadable' : 'no-publish-time']++;
    continue;
  }
  lookup.ok++;
  rows.push({ repo, path, ...e, publishedAt: published, ageHours: (Date.parse(e.commitTime) - Date.parse(published)) / 3_600_000 });
}
writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
const meta = {
  repo, path, since, until,
  commits: commits.length,
  adoptions: events.length,
  reappearedSkipped: repeated,
  unparsedInLastSnapshot: snapshots.at(-1)?.unparsed ?? 0,
  unparsedMaxInASnapshot: Math.max(0, ...snapshots.map((x) => x.unparsed)),
  lookup,
};
writeFileSync(outFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta));
