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

const DEFAULT_URL = 'https://nofaff.netlify.app/api/installerclean-runs';
const url = process.env.REFRESH_URL ?? DEFAULT_URL;

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
try {
  resp = await fetch(url, { headers: { Accept: 'application/json' } });
} catch (err) {
  console.error(`Could not reach ${url}: ${err.message}`);
  process.exit(1);
}

if (!resp.ok) {
  console.error(`${url} -> ${resp.status} ${resp.statusText}`);
  if (resp.status === 404) {
    console.error('Endpoint is not deployed at that URL yet. Override with REFRESH_URL=<branch-preview-url> if needed.');
  }
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
console.log(`Updated ${path.relative(process.cwd(), slicePath)} with ${runs.length} reports (as of ${asOf}).`);
