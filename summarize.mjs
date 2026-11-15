// Applies each cooldown to data/attacks.jsonl and to every data/replay/*.jsonl, and prints the two result tables.
// Usage: node summarize.mjs [--days 1,2,3,5,7,14,30]
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const daysArg = process.argv.indexOf('--days');
const DAYS = (daysArg > 0 ? process.argv[daysArg + 1] : '1,2,3,5,7,14,30').split(',').map(Number);
const HOUR_MS = 3_600_000;
const readJsonl = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

export const avoided = (row, days) => {
  if (!row.detectedAt || !row.publishedAt) throw new Error(`${row.package}@${row.version} has no ${row.publishedAt ? 'detection' : 'publish'} time`);
  return Date.parse(row.detectedAt) < Date.parse(row.publishedAt) + days * 24 * HOUR_MS;
};

export const delayHours = (row, days) => (row.ageHours < days * 24 ? days * 24 - row.ageHours : null);

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? null : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const attacks = readJsonl(join(here, 'data', 'attacks.jsonl'));
const incidents = [...new Set(attacks.map((r) => r.incident))];
const attackTable = DAYS.map((days) => {
  const byIncident = incidents.map((id) => {
    const rows = attacks.filter((r) => r.incident === id);
    const n = rows.filter((r) => avoided(r, days)).length;
    return n === rows.length ? 'all' : n === 0 ? 'none' : 'some';
  });
  return {
    cooldownDays: days,
    versionsAvoided: attacks.filter((r) => avoided(r, days)).length,
    versionsTotal: attacks.length,
    incidentsAllAvoided: byIncident.filter((x) => x === 'all').length,
    incidentsSomeAvoided: byIncident.filter((x) => x === 'some').length,
    incidentsNoneAvoided: byIncident.filter((x) => x === 'none').length,
    incidentsTotal: incidents.length,
    byBasis: Object.fromEntries(['removal', 'advisory'].map((basis) => {
      const rows = attacks.filter((r) => r.detectedBy === basis);
      return [basis, { versionsAvoided: rows.filter((r) => avoided(r, days)).length, versionsTotal: rows.length, incidents: new Set(rows.map((r) => r.incident)).size }];
    })),
  };
});

const replayDir = join(here, 'data', 'replay');
const datasets = readdirSync(replayDir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ name: f.replace(/\.jsonl$/, ''), rows: readJsonl(join(replayDir, f)) }));
const costTable = [];
for (const ds of datasets) {
  for (const days of DAYS) {
    const delays = ds.rows.map((r) => delayHours(r, days)).filter((x) => x !== null);
    costTable.push({
      dataset: ds.name,
      cooldownDays: days,
      adoptions: ds.rows.length,
      delayed: delays.length,
      delayedShare: ds.rows.length ? delays.length / ds.rows.length : null,
      medianDelayHours: median(delays),
      maxDelayHours: delays.length ? Math.max(...delays) : null,
      negativeAge: ds.rows.filter((r) => r.ageHours < 0).length,
    });
  }
}

mkdirSync(join(here, 'results'), { recursive: true });
writeFileSync(join(here, 'results', 'summary.json'), JSON.stringify({ attackTable, costTable }, null, 2) + '\n');
console.log('| cooldown (days) | versions avoided | incidents: all / some / none |');
console.log('|---|---|---|');
for (const r of attackTable) console.log(`| ${r.cooldownDays} | ${r.versionsAvoided} / ${r.versionsTotal} | ${r.incidentsAllAvoided} / ${r.incidentsSomeAvoided} / ${r.incidentsNoneAvoided} |`);
console.log('\n| cooldown (days) | removal-based: versions avoided | advisory-based: versions avoided |');
console.log('|---|---|---|');
for (const r of attackTable) console.log(`| ${r.cooldownDays} | ${r.byBasis.removal.versionsAvoided} / ${r.byBasis.removal.versionsTotal} | ${r.byBasis.advisory.versionsAvoided} / ${r.byBasis.advisory.versionsTotal} |`);
console.log('\n| dataset | cooldown (days) | adoptions | delayed | share | median delay (h) | max delay (h) |');
console.log('|---|---|---|---|---|---|---|');
for (const r of costTable) console.log(`| ${r.dataset} | ${r.cooldownDays} | ${r.adoptions} | ${r.delayed} | ${r.delayedShare === null ? '-' : (r.delayedShare * 100).toFixed(1) + '%'} | ${r.medianDelayHours === null ? '-' : r.medianDelayHours.toFixed(1)} | ${r.maxDelayHours === null ? '-' : r.maxDelayHours.toFixed(1)} |`);
