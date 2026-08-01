#!/usr/bin/env node
// Refreshes the runs[] array in src/pages/installerclean/index.astro (between
// the `reports-data-start` / `reports-data-end` markers) from the live
// InstallerClean opt-in reports endpoint.
//
// Incremental by default. The store is immutable and append-only, so the rows
// already baked into the page never change; this reads them back as the cache,
// asks the endpoint only for reports newer than the newest baked one, and
// merges. That keeps each refresh O(new reports) rather than re-walking the
// whole history (the O(all) walk is what eventually timed the endpoint out).
// REFRESH_FULL=1 forces a from-scratch rebuild that re-reads everything.
//
// Default endpoint is production. Override during a preview-only window with
// REFRESH_URL=https://<branch>--nofaff.netlify.app/api/installerclean-runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URLS = process.env.REFRESH_URL
  ? [process.env.REFRESH_URL]
  : ['https://nofaff.netlify.app/api/installerclean-runs'];

const FULL = process.env.REFRESH_FULL === '1' || process.argv.includes('--full');

const here = path.dirname(fileURLToPath(import.meta.url));
const targetPath = path.resolve(here, '..', 'src', 'pages', 'installerclean', 'index.astro');

const START = '// reports-data-start';
const END = '// reports-data-end';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function friendlyDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// Read the page first: the baked block is this script's persistent cache, so
// it has to be parsed before the fetch to know how far back to ask.
const text = await fs.readFile(targetPath, 'utf8');
const startIdx = text.indexOf(START);
const endIdx = text.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`Markers not found in ${targetPath}.`);
  process.exit(1);
}

// Recover the currently-baked rows. Each is `{ ts: '...', gb: N, missing: N },`.
const ROW_RE = /\{\s*ts:\s*'([^']+)',\s*gb:\s*(-?[\d.]+),\s*missing:\s*(-?\d+)\s*\}/g;
const existing = FULL
  ? []
  : [...text.slice(startIdx, endIdx).matchAll(ROW_RE)].map((m) => ({
      ts: m[1],
      gb: Number(m[2]),
      missing: Number(m[3]),
    }));

// Re-list the last hour before the newest baked report, not just strictly
// after it, so a write whose receiving edge node's clock lagged is never
// skipped; the merge dedupes by timestamp, so the small overlap is harmless.
const OVERLAP_MS = 60 * 60 * 1000;
let since;
if (existing.length) {
  const maxTs = existing.reduce((m, r) => (r.ts > m ? r.ts : m), '');
  if (maxTs) since = new Date(new Date(maxTs).getTime() - OVERLAP_MS).toISOString();
}

let resp;
let usedUrl;
for (const candidate of URLS) {
  try {
    // `since` limits the fetch to new reports; the unique nocache param
    // bypasses any cache so a manual refresh always gets the current tally.
    const url = new URL(candidate);
    if (since) url.searchParams.set('since', since);
    url.searchParams.set('nocache', String(Date.now()));
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (r.ok) {
      resp = r;
      usedUrl = candidate;
      break;
    }
    if (r.status !== 404) {
      console.error(`${candidate} -> ${r.status} ${r.statusText}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`Could not reach ${candidate}: ${err.message}`);
  }
}

if (!resp) {
  console.error('No URL returned data. Override with REFRESH_URL=<url> if needed.');
  process.exit(1);
}

const payload = await resp.json();
const fetched = Array.isArray(payload?.runs) ? payload.runs : null;
if (!fetched) {
  console.error('Response did not include a runs array.');
  process.exit(1);
}

// Merge the fetched slice into the baked rows, keyed by timestamp so the
// overlap window's re-read replaces rather than duplicates.
const byTs = new Map(existing.map((r) => [r.ts, r]));
for (const r of fetched) byTs.set(r.ts, r);
const runs = [...byTs.values()].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

const asOf = friendlyDate(payload.generatedAt ?? new Date().toISOString());

const lines = [
  START,
  'const runs: Run[] = [',
  ...runs.map((r) => `  { ts: '${r.ts}', gb: ${r.gb}, missing: ${r.missing} },`),
  '];',
  END,
];

const before = text.slice(0, startIdx);
const after = text.slice(endIdx + END.length);
const newText = before + lines.join('\n') + after;

await fs.writeFile(targetPath, newText, 'utf8');
const newCount = since ? ` (+${runs.length - existing.length} new)` : '';
console.log(
  `Updated ${path.relative(process.cwd(), targetPath)} with ${runs.length} reports${newCount} (as of ${asOf}, from ${usedUrl}).`,
);
