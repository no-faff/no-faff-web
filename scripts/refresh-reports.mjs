#!/usr/bin/env node
// Fetches the latest InstallerClean opt-in reports from the live edge
// function and rewrites the runs[] array in src/pages/installerclean/index.astro
// between the `reports-data-start` / `reports-data-end` markers.
//
// Default endpoint is production. Override during a preview-only
// window with REFRESH_URL=https://<branch>--nofaff.netlify.app/api/installerclean-runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URLS = process.env.REFRESH_URL
  ? [process.env.REFRESH_URL]
  : ['https://nofaff.netlify.app/api/installerclean-runs'];

const here = path.dirname(fileURLToPath(import.meta.url));
const targetPath = path.resolve(here, '..', 'src', 'pages', 'installerclean', 'index.astro');

const START = '// reports-data-start';
const END = '// reports-data-end';

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function friendlyDate(iso) {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

let resp;
let usedUrl;
for (const candidate of URLS) {
  try {
    // Unique query param bypasses the endpoint's 5-min cache so a
    // manual refresh always gets the current tally.
    const bust = (candidate.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
    const r = await fetch(candidate + bust, { headers: { Accept: 'application/json' } });
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
const runs = Array.isArray(payload?.runs) ? payload.runs : null;
if (!runs) {
  console.error('Response did not include a runs array.');
  process.exit(1);
}

const asOf = friendlyDate(payload.generatedAt ?? new Date().toISOString());

const lines = [
  START,
  `const reportsAsOf = '${asOf}';`,
  'const runs: Run[] = [',
  ...runs.map((r) => `  { ts: '${r.ts}', gb: ${r.gb}, missing: ${r.missing} },`),
  '];',
  END,
];

const text = await fs.readFile(targetPath, 'utf8');
const startIdx = text.indexOf(START);
const endIdx = text.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`Markers not found in ${targetPath}.`);
  process.exit(1);
}

const before = text.slice(0, startIdx);
const after = text.slice(endIdx + END.length);
const newText = before + lines.join('\n') + after;

await fs.writeFile(targetPath, newText, 'utf8');
console.log(`Updated ${path.relative(process.cwd(), targetPath)} with ${runs.length} reports (as of ${asOf}, from ${usedUrl}).`);
