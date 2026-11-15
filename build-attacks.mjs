// Joins data/incidents.json with the registry's publish times and the GitHub advisories' publish times.
// Usage: node build-attacks.mjs [--out data/attacks.jsonl]   (needs network and a GitHub token: GH_TOKEN, else `gh auth token`)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const incidents = JSON.parse(readFileSync(join(here, 'data', 'incidents.json'), 'utf8'));
const token = process.env.GH_TOKEN ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();

const advisoryTime = new Map();
async function advisoryAt(id) {
  if (!advisoryTime.has(id)) {
    const res = await fetch(`https://api.github.com/advisories/${id}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`advisory ${id}: HTTP ${res.status}`);
    advisoryTime.set(id, (await res.json()).published_at);
  }
  return advisoryTime.get(id);
}

const earliest = (times) => times.filter(Boolean).sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null;
const rows = [];
for (const inc of incidents) {
  for (const pkg of inc.packages) {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name.replace('/', '%2f')}`);
    if (!res.ok && res.status !== 404) throw new Error(`registry ${pkg.name}: HTTP ${res.status}`);
    const time = res.ok ? (await res.json()).time ?? {} : {};
    const ids = pkg.advisories ?? inc.advisories ?? [];
    const advisory = earliest(await Promise.all(ids.map(advisoryAt)));
    const removedAt = pkg.removedAt ?? inc.removedAt ?? null;
    for (const version of pkg.versions) {
      const publishedAt = pkg.publishedAtOverride ?? time[version] ?? null;
      const detectedAt = earliest([removedAt, advisory]);
      rows.push({
        incident: inc.id,
        package: pkg.name,
        version,
        publishedAt,
        publishedFrom: pkg.publishedAtOverride ? pkg.publishedSource : 'registry',
        removedAt,
        removalSource: pkg.removalSource ?? inc.removalSource ?? null,
        removedBy: pkg.removedBy ?? inc.removedBy ?? null,
        advisoryAt: advisory,
        advisories: ids,
        detectedAt,
        detectedBy: detectedAt === null ? null : detectedAt === removedAt ? 'removal' : 'advisory',
        lagHours: publishedAt && detectedAt ? (Date.parse(detectedAt) - Date.parse(publishedAt)) / 3_600_000 : null,
      });
    }
  }
}
const outIdx = process.argv.indexOf('--out');
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : join(here, 'data', 'attacks.jsonl');
writeFileSync(outFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(JSON.stringify({ versions: rows.length, incidents: incidents.length, unresolved: rows.filter((r) => r.lagHours === null).map((r) => `${r.package}@${r.version}`) }));
