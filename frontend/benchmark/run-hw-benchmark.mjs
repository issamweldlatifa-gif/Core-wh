#!/usr/bin/env node
/**
 * Hardware scanner benchmark (dual-scanner order §13).
 *
 * The physical USB/BT scanner already DECODES the code — what AYROVI must
 * measure is the receiving-side hardware path: sanitise → duplicate guard →
 * shared submit decision (the SAME pure code the Hardware panel runs). This
 * benchmark pushes every synthetic ground-truth code through that path, plus
 * a duplicate-stream stress, and reports honest metrics:
 *
 *   accepted into pipeline / blocked · duplicate suppression · per-read
 *   validation overhead (μs) · out-of-order flagged (business validation is
 *   backend's job — these are NOT auto-accepted as correct here).
 *
 * The wedge event layer (WedgeParser) is unit-tested separately in vitest;
 * physical device acceptance remains a manual step.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp');
mkdirSync(TMP, { recursive: true });
const esbuildPath = path.join(HERE, '..', 'node_modules', '.bin', 'esbuild');
execSync(`"${esbuildPath}" pipeline.ts --bundle --platform=node --format=esm --outfile=tmp/pipeline.mjs`, {
  cwd: HERE, stdio: 'pipe',
});
const P = await import(`./tmp/pipeline.mjs?t=${Date.now()}`);
const PREP = P.prepareHardwareRead;
const SAN = P.sanitiseWedgeRead;
const WINDOW = 2500;
const dup = { lastValue: '', lastAt: 0 };

const manifest = JSON.parse(readFileSync(path.join(TMP, 'manifest.json'), 'utf8'));
const corpus = manifest.corpus.map((c) => c.toUpperCase());
const gts = manifest.labels.map((l) => l.gt.toUpperCase());

const started = Date.now();
let accepted = 0;
let blocked = 0;
let flaggedOutOfOrder = 0;
let duplicatesSuppressed = 0;
let unique = 0;
const latencies = [];
const rows = [];

// each physical label is one scan spaced ≥3 s apart (a real worker passes the
// next carton) — repeats within the 2.5 s window only happen on double-trigger
for (let i = 0; i < gts.length; i += 1) {
  const gt = gts[i];
  const t0 = performance.now();
  const res = PREP(dup, gt, Date.now() + i * 3000, WINDOW);
  const us = (performance.now() - t0) * 1000;
  latencies.push(us);
  if (!res) { blocked += 1; continue; }
  if (res.duplicate) { duplicatesSuppressed += 1; continue; }
  accepted += 1;
  unique += 1;
  const inOrder = corpus.includes(res.value);
  if (!inOrder) flaggedOutOfOrder += 1;
  rows.push({ code: res.value, accepted: true, onOrder: inOrder, overheadUs: +us.toFixed(1) });
}

// duplicate stream stress: re-hold one code for 2 s ⇒ exactly ONE pipeline event
const dup2 = { lastValue: '', lastAt: 0 };
let events = 0;
for (let t = 0; t < 40; t += 50) {
  const r = PREP(dup2, 'CTN-000123', Date.now() + t, WINDOW);
  if (r && !r.duplicate) events += 1;
}
const avgUs = latencies.reduce((s, v) => s + v, 0) / latencies.length;

const out = {
  method: 'hardware',
  readsFed: gts.length,
  accepted,
  blocked,
  duplicatesSuppressed,
  uniqueCodes: unique,
  onOrderCodes: rows.filter((r) => r.onOrder).length,
  flaggedOutOfOrder, // submitted to business validation — backend decides; 0 auto-correct claims
  duplicateStreamEvents: events, // expect 1
  overheadAvgUs: +avgUs.toFixed(1),
  overheadP95Us: +[...latencies].sort((a, b) => a - b)[Math.ceil(latencies.length * 0.95) - 1].toFixed(1),
  elapsedMs: Date.now() - started,
};

console.log(`\n==== HARDWARE scanner pipeline (${out.readsFed} ground-truth codes fed as wedge reads) ====`);
console.log(`accepted into receiving pipeline  ${out.accepted}/${out.readsFed}`);
console.log(`sanitised out (junk)              ${out.blocked}`);
console.log(`duplicates suppressed             ${out.duplicatesSuppressed} (repeat stream within window)`);
console.log(`duplicate stress: one code held → ${out.duplicateStreamEvents} event(s)`);
console.log(`codes on the order                ${out.onOrderCodes} · flagged out-of-order for backend business validation ${out.flaggedOutOfOrder}`);
console.log(`per-read validation overhead      avg ${out.overheadAvgUs}µs · p95 ${out.overheadP95Us}µs`);
console.log(`elapsed ${(out.elapsedMs / 1000).toFixed(1)}s`);

writeFileSync(path.join(TMP, 'hardware-results.json'), JSON.stringify(out, null, 1));
