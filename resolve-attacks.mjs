// Joins each advisory record in data/ghsa-exact-versions.json with the registry's publish time for that version
// and marks whether the package already had a version published at least ESTABLISHED_DAYS earlier.
// Usage: node resolve-attacks.mjs [--out data/attacks-resolved.jsonl]   (needs network)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ESTABLISHED_DAYS = 30;
const DAY_MS = 86_400_000;
const CONCURRENCY = 12;

const records = JSON.parse(readFileSync(join(here, 'data', 'ghsa-exact-versions.json'), 'utf8'));
const byPackage = new Map();
for (const r of records) byPackage.set(r.package, [...(byPackage.get(r.package) ?? []), r]);

async function registryDoc(name) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`);
      if (res.status === 404) return { status: 404 };
      if (res.ok) return { status: 200, doc: await res.json() };
      if (res.status < 500 && res.status !== 429) return { status: res.status };
    } catch {}
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return { status: 'failed' };
}

const out = [];
const queue = [...byPackage.entries()];
async function worker() {
  for (let item = queue.pop(); item; item = queue.pop()) {
    const [name, recs] = item;
    const res = await registryDoc(name);
    for (const r of recs) {
      const row = { ...r, registry: res.status, publishedAtRegistry: null, versionStillListed: null, establishedBefore: false, lookup: 'ok' };
      if (res.status === 200) {
        const t = res.doc.time?.[r.version];
        row.versionStillListed = Boolean(res.doc.versions?.[r.version]);
        if (t) {
          row.publishedAtRegistry = t;
          const cutoff = Date.parse(t) - ESTABLISHED_DAYS * DAY_MS;
          row.establishedBefore = Object.entries(res.doc.time).some(([v, vt]) => v !== 'created' && v !== 'modified' && Date.parse(vt) <= cutoff);
        } else row.lookup = 'no-publish-time';
      } else row.lookup = res.status === 404 ? 'package-gone' : `registry-${res.status}`;
      out.push(row);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
out.sort((a, b) => a.published_at.localeCompare(b.published_at) || a.package.localeCompare(b.package));

const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : join(here, 'data', 'attacks-resolved.jsonl');
writeFileSync(outFile, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
const tally = {};
for (const r of out) tally[r.lookup] = (tally[r.lookup] ?? 0) + 1;
const established = out.filter((r) => r.establishedBefore && r.publishedAtRegistry);
const lagDays = established.map((r) => (Date.parse(r.published_at) - Date.parse(r.publishedAtRegistry)) / 86_400_000).sort((a, b) => a - b);
const median = lagDays.length % 2 ? lagDays[lagDays.length >> 1] : (lagDays[lagDays.length / 2 - 1] + lagDays[lagDays.length / 2]) / 2;
console.log(JSON.stringify({ records: out.length, packages: byPackage.size, lookup: tally, established: established.length, establishedPackages: new Set(established.map((r) => r.package)).size, advisoryLagDays: { median, max: lagDays.at(-1), negative: lagDays.filter((x) => x < 0).length } }));
