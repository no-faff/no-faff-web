#!/usr/bin/env node
// Fetches the latest InstallerClean opt-in reports from the live edge
// function and rewrites the runs[] array in slice.astro between the
// `reports-data-start` / `reports-data-end` markers.
//
// Default endpoint is production. Override during a preview-only
// window with REFRESH_URL=https://<branch>--nofaff.netlify.app/api/installerclean-runs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Production once the chart branch lands on main. The branch preview is
// listed as a fallback so the script works during the unmerged window;
// remove it whenever the branch goes away.
const URLS = process.env.REFRESH_URL
  ? [process.env.REFRESH_URL]
  : [
      'https://nofaff.netlify.app/api/installerclean-runs',
      'https://installerclean-chart--nofaff.netlify.app/api/installerclean-runs',
    ];

const here = path.dirname(fileURLToPath(import.meta.url));
const slicePath = path.resolve(here, '..', 'src', 'pages', 'installerclean', 'slice.astro');

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
    const r = await fetch(candidate, { headers: { Accept: 'application/json' } });
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

const text = await fs.readFile(slicePath, 'utf8');
const startIdx = text.indexOf(START);
const endIdx = text.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  console.error(`Markers not found in ${slicePath}.`);
  process.exit(1);
}

const before = text.slice(0, startIdx);
const after = text.slice(endIdx + END.length);
const newText = before + lines.join('\n') + after;

await fs.writeFile(slicePath, newText, 'utf8');
console.log(`Updated ${path.relative(process.cwd(), slicePath)} with ${runs.length} reports (as of ${asOf}, from ${usedUrl}).`);
