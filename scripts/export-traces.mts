/**
 * Convert a RunTrace JSONL file into ShareGPT and Alpaca training sets.
 *
 *   tsx scripts/export-traces.mts <traces.jsonl> <out-dir>
 *
 * A script rather than `tsx -e "..."` in the Makefile: the inline form could not
 * resolve `./training/index.js` at all and died with MODULE_NOT_FOUND, so the
 * documented command never ran (issue #21).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { exportToShareGPT, exportToAlpaca, parseTraceJSONL } from '../training/index.js';

const [traceFile, outDir] = process.argv.slice(2);
if (traceFile === undefined || outDir === undefined) {
  console.error('usage: tsx scripts/export-traces.mts <traces.jsonl> <out-dir>');
  process.exit(2);
}

const traces = parseTraceJSONL(readFileSync(traceFile, 'utf8'));
mkdirSync(outDir, { recursive: true });

const sharegpt = exportToShareGPT(traces);
const alpaca = exportToAlpaca(traces);
writeFileSync(`${outDir}/sharegpt.jsonl`, sharegpt);
writeFileSync(`${outDir}/alpaca.jsonl`, alpaca);

const samples = sharegpt === '' ? 0 : sharegpt.split('\n').length;
console.log(
  `Exported ${String(samples)} samples from ${String(traces.length)} traces to ${outDir}/`,
);

if (samples === 0 && traces.length > 0) {
  // The failure this issue is about was silent: an empty dataset that looked
  // like a successful export.
  console.warn(
    'No samples were written. A step is exported only when it recorded the page ' +
      'it saw, which is opt-in — set `privacy.recordPageContent` before the runs ' +
      'you intend to export, and re-run them.',
  );
}
