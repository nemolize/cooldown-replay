// Checks the article against the issue's validation list: frontmatter, tables, a source link for every attack record, excluded details.
// Usage: node validate.mjs <path to the article>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
if (!process.argv[2]) throw new Error('usage: node validate.mjs <path to the article>');
const articlePath = resolve(process.argv[2]);
const text = readFileSync(articlePath, 'utf8');
const problems = [];

const match = text.match(/^---\n([\s\S]*?)\n---\n/);
if (!match) problems.push('frontmatter block missing');
else {
  let fm;
  try {
    fm = parseYaml(match[1]);
  } catch (e) {
    problems.push(`frontmatter does not parse: ${e.message}`);
  }
  if (fm) {
    for (const key of ['title', 'emoji', 'type', 'topics', 'published']) if (!(key in fm)) problems.push(`frontmatter key missing: ${key}`);
    if (fm.published !== false) problems.push('published must stay false');
    if (!['tech', 'idea'].includes(fm.type)) problems.push(`type must be tech or idea, got ${fm.type}`);
    if (!Array.isArray(fm.topics) || fm.topics.length < 1 || fm.topics.length > 5) problems.push('topics must hold 1 to 5 entries');
    if (typeof fm.title === 'string' && [...fm.title].length > 70) problems.push(`title is ${[...fm.title].length} characters, Zenn allows 70`);
  }
}

const body = match ? text.slice(match[0].length) : text;
const lines = body.split('\n');
let fenced = false;
const prose = [];
for (const line of lines) {
  if (line.startsWith('```')) fenced = !fenced;
  else if (!fenced) prose.push(line);
}
if (fenced) problems.push('a code fence is never closed');

const cols = (l) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
for (let i = 0; i < prose.length; i++) {
  if (!prose[i].startsWith('|') || (i > 0 && prose[i - 1].startsWith('|'))) continue;
  let j = i;
  while (j < prose.length && prose[j].startsWith('|')) j++;
  const block = prose.slice(i, j);
  if (block.length < 3 || !/^\|[\s:|-]+\|$/.test(block[1])) problems.push(`table at body line ${i + 1} has no header separator row`);
  const width = cols(block[0]);
  block.forEach((l, k) => cols(l) !== width && problems.push(`table at body line ${i + 1}: row ${k + 1} has ${cols(l)} columns, header has ${width}`));
}

const records = readFileSync(join(here, 'data', 'attacks.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
for (const r of records) {
  if (!r.removalSource && r.advisories.length === 0) problems.push(`${r.package}@${r.version} has neither a removal source nor an advisory`);
  for (const id of r.advisories) if (!text.includes(`https://github.com/advisories/${id}`)) problems.push(`advisory ${id} is not linked in the article`);
  if (r.removalSource && !text.includes(r.removalSource)) problems.push(`removal source ${r.removalSource} is not linked in the article`);
}

const excluded = [
  [/(?<![\w/&])#\d+\b/, 'bare issue or pull request number', prose],
  [/github\.com\/(nemolize|banaris)\/[\w.-]+\/(issues|pull)\/\d+/, 'link to an issue or pull request of the owner', lines],
  [/\/Users\/|\/home\/\w+|\b[\w-]+\.(local|internal|corp)\b/, 'local path or internal hostname', lines],
  [/\bghp_\w{20,}|\bgho_\w{20,}|\bnpm_\w{30,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'secret-shaped string', lines],
];
for (const [re, label, where] of excluded) {
  const hit = where.find((l) => re.test(l));
  if (hit) problems.push(`${label}: ${hit.trim().slice(0, 100)}`);
}

const ownRepos = new Set([...body.matchAll(/github\.com\/(nemolize|banaris)\/([\w.-]+)/g)].map((m) => `${m[1]}/${m[2]}`));
for (const repo of ownRepos) {
  const res = spawnSync('gh', ['api', `repos/${repo}`, '--jq', '.private'], { encoding: 'utf8' });
  if (res.status !== 0) problems.push(`could not read the visibility of ${repo}: ${res.stderr.trim().slice(0, 80)}`);
  else if (res.stdout.trim() !== 'false') problems.push(`${repo} is not a public repository`);
}

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`ok: ${articlePath} (${records.length} attack records, all linked)`);
