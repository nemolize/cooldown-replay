# Dependency cooldown replay

Scripts and data behind the Zenn article on dependency cooldowns: how many past malicious npm versions a cooldown would have avoided, how many ordinary lockfile updates it would have delayed, and whether each package manager's setting does what its name says.

```sh
npm install                                      # yaml, the only dependency of the scripts
npm install --prefix tools                       # pinned npm, pnpm, bun (allowScripts in tools/package.json lets pnpm and bun finish installing)
npm install --prefix tools-berry                 # yarn Berry, kept apart: yarn classic and Berry both install a `yarn` command

node build-attacks.mjs                           # data/incidents.json + registry + GitHub advisories -> data/attacks.jsonl
node resolve-attacks.mjs [--out <file>]          # the abandoned whole-feed attempt: its figures, and data/attacks-resolved.jsonl
node replay-all.mjs [name ...]                   # the windows in windows.json -> data/replay/<name>.jsonl and <name>.meta.json (one window: replay-lockfile.mjs --repo <owner/name> --path <lockfile> [--since <iso>] [--until <iso>] --out <file>)
node summarize.mjs                               # the result tables -> stdout and results/summary.json
node check-settings.mjs --out data/settings-check.jsonl   # each tool's cooldown setting against one package
node check-defaults.mjs --out data/defaults-check.jsonl   # each tool with no setting, against a version under 20 hours old
node validate.mjs                                # the article's frontmatter, tables, source links and excluded details
```

Every script that reads the registry or GitHub needs network. `replay-lockfile.mjs` and `build-attacks.mjs` read a token from `GH_TOKEN`, else `gh auth token`.

- `data/incidents.json` is the curated attack list: each incident's versions, the removal time and its source where one is published, and the GitHub advisories. `build-attacks.mjs` adds the registry publish time of every version and keeps the earlier of the removal time and the advisory time as the detection time.
- `summarize.mjs` holds the two predicates the article quotes: `avoided` (detection earlier than publish time plus the cooldown) and `delayHours` (the cooldown minus the version's age at the commit).
- `replay-lockfile.mjs` walks the commits that touched one lockfile (`package-lock.json` or `pnpm-lock.yaml`), takes every `(package, version)` that first appears in the window after its first snapshot, and records its age on the registry at the commit time. Entries without a registry version (links, git, tarballs) are counted as unparsed. The first commit of a window is the baseline and produces no adoptions.
- `windows.json` lists the 11 lockfile windows (repository, lockfile, since, until). `data/replay/<name>.jsonl` holds one row per adoption; `<name>.meta.json` holds the window's commit count, adoptions, versions that reappeared and were not counted again, unparsed entries and lookup failures.
- `data/ghsa-exact-versions.json` and `data/attacks-resolved.jsonl` record the attempt to mine the whole GitHub malware feed, which the article explains and sets aside. The first file holds the advisories naming one exact version, taken from `gh api --paginate "/advisories?type=malware&ecosystem=npm&per_page=100"` (newest first, stopped after 43,400 advisories, back to 2026-09-06). `resolve-attacks.mjs` joins it with the registry.
