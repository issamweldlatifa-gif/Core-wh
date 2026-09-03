#!/usr/bin/env node
/**
 * §17 before/after benchmark runner.
 *
 * Reads the synthetic labels from tmp/labels/*.png (gen_labels.py) and runs
 * BOTH pipelines over each label with the SAME tesseract engine:
 *
 *   CURRENT  — the previous scanner recipe: legacy global-threshold
 *              preprocessing → Tesseract → raw token filter → submit the
 *              first stable candidate. No quality gate, no corpus validation.
 *   IMPROVED — the P0 pipeline: quality gate → auto profile → preprocessing
 *              → OCR → field extraction → corpus validation → composite
 *              confidence → HIGH auto / MEDIUM confirm / LOW drop.
 *
 * The TS pipeline is bundled with esbuild (benchmark/pipeline.ts) so the
 * benchmark exercises the exact code shipped in the app.
 *
 * Outputs a per-category table + tmp/results.json.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(HERE, 'tmp');
const WORK = path.join(TMP, 'work');
mkdirSync(WORK, { recursive: true });

// ---- 0. bundle the exact TS pipeline (node/esm) ----
const esbuildPath = path.join(HERE, '..', 'node_modules', '.bin', 'esbuild');
execSync(`"${esbuildPath}" pipeline.ts --bundle --platform=node --format=esm --outfile=tmp/pipeline.mjs`, {
  cwd: HERE, stdio: 'pipe',
});

const P = await import(`./tmp/pipeline.mjs?t=${Date.now()}`);
const CFG = P.DEFAULT_SCAN_CONFIG;
const AQ = P.assessQuality;
const AP = P.applyProfile;
const LEGACY = P.legacyPreprocess;
const SP = P.selectProfile;
const EFT = P.extractFieldTokens;
const NORM = P.normaliseToken;
const MAC = P.matchAgainstCorpus;
const CC = P.computeConfidence;
const EC = P.extractCandidates;

const manifest = JSON.parse(readFileSync(path.join(TMP, 'manifest.json'), 'utf8'));
const corpus = manifest.corpus.map((c) => c.toUpperCase());

function grayFromPixels(px) {
  const g = new Uint8ClampedArray(px.width * px.height);
  for (let i = 0, p = 0; i < g.length; i += 1, p += 4) {
    g[i] = (px.data[p] * 0.299 + px.data[p + 1] * 0.587 + px.data[p + 2] * 0.114) | 0;
  }
  return g;
}

function pngFromGray(gray, w, h) {
  const out = new PNG({ width: w, height: h });
  for (let i = 0, p = 0; i < gray.length; i += 1, p += 4) {
    out.data[p] = gray[i];
    out.data[p + 1] = gray[i];
    out.data[p + 2] = gray[i];
    out.data[p + 3] = 255;
  }
  return PNG.sync.write(out);
}

/** OLD scanner decision: submit first raw candidate; no validation anywhere. */
function oldDecision(text) {
  const cands = EC(text);
  if (!cands.length) return { kind: 'no_read', guess: '' };
  return { kind: 'read', guess: cands[0] };
}

/** NEW scanner decision (mirrors rankStable + computeConfidence in the app). */
function newDecision(text, ocrConf01, qScore, qualityGatePass) {
  const tokens = EFT(text);
  if (!tokens.length) return { kind: 'no_fields', value: '' };
  const scored = tokens.map((t) => {
    const clean = NORM(t.token);
    const match = MAC(clean, corpus, CFG.validation);
    const conf = CC(
      {
        detection: 'OCR', ocrConfidence: ocrConf01, qualityScore: qScore,
        formatScore: t.formatScore, dbScore: match.dbScore,
        corpusPresent: corpus.length > 0, matchKind: match.kind,
        votes: CFG.consensus.votesRequired,
      },
      CFG,
    );
    return { clean, match, conf };
  });
  scored.sort((a, b) => {
    const ae = a.match.kind === 'exact' ? 1 : 0;
    const be = b.match.kind === 'exact' ? 1 : 0;
    if (ae !== be) return be - ae;
    return b.conf.score - a.conf.score;
  });
  const best = scored[0];
  if (!qualityGatePass) return { kind: 'quality_blocked', value: best.clean, level: best.conf.level };
  const value = best.match.kind === 'candidate' && best.match.matched ? best.match.matched : best.clean;
  return { kind: best.conf.level.toLowerCase(), value, match: best.match, conf: best.conf, best };
}

// Keep the language-data download inside the ignored tmp/ tree so benchmark
// runs never drop stray traineddata into the repo.
const worker = await createWorker('eng', 1, {
  cachePath: path.join(TMP, 'tessdata'),
});
await worker.setParameters({
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  tessedit_pageseg_mode: '6',
});

const rows = [];
const started = Date.now();
for (const L of manifest.labels) {
  const png = PNG.sync.read(readFileSync(path.join(TMP, 'labels', L.file)));
  const px = { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  const gray = grayFromPixels(px);
  const gt = L.gt.toUpperCase();

  // ---- CURRENT pipeline ----
  const legacyGray = LEGACY(gray);
  writeFileSync(path.join(WORK, 'cur.png'), pngFromGray(legacyGray, px.width, px.height));
  const oldT0 = performance.now();
  const oldRes = await worker.recognize(path.join(WORK, 'cur.png'));
  const oldOcrMs = performance.now() - oldT0;
  const old = oldDecision(oldRes.data.text ?? '');

  // ---- IMPROVED pipeline ----
  const qT0 = performance.now();
  const q = AQ(gray, px.width, px.height);
  const qMs = performance.now() - qT0;
  const profile = SP(q);
  const pT0 = performance.now();
  const prepped = AP(px, profile, { smallTextUpscale: 2, maxWidth: 960 });
  const pMs = performance.now() - pT0;
  writeFileSync(path.join(WORK, 'new.png'), pngFromGray(prepped.gray, prepped.width, prepped.height));
  const newT0 = performance.now();
  const newRes = await worker.recognize(path.join(WORK, 'new.png'));
  const newOcrMs = performance.now() - newT0;
  const conf01 = Math.max(0, Math.min(1, (newRes.data.confidence ?? 0) / 100));
  const nd = newDecision(newRes.data.text ?? '', conf01, q.score, q.pass);

  const oldKind = old.kind === 'read'
    ? (old.guess === gt ? 'old_exact'
        : corpus.includes(old.guess) ? 'old_wrong_match'
        : 'old_unknown')
    : 'old_no_read';

  let newKind;
  if (nd.kind === 'high') newKind = nd.value === gt ? 'new_auto_exact' : (corpus.includes(nd.value) ? 'new_auto_wrong' : 'new_auto_unknown');
  else if (nd.kind === 'medium') {
    const near = nd.match?.candidates?.some((c) => c.value === gt);
    newKind = nd.value === gt ? 'new_confirm_correct' : near ? 'new_confirm_possible_correct' : 'new_confirm_wrong';
  } else newKind = 'new_drop';

  rows.push({
    id: L.id, category: L.category, gt,
    oldKind, oldGuess: old.kind === 'read' ? old.guess : '',
    newKind,
    qualityLevel: q.level, qualityPass: q.pass, qualityReasons: q.reasons.join('+') || '-',
    profile,
    ocrConf: +conf01.toFixed(2),
    ms: {
      oldOcrMs: +oldOcrMs.toFixed(1), newOcrMs: +newOcrMs.toFixed(1),
      qualityMs: +qMs.toFixed(1), preprocessMs: +pMs.toFixed(1),
      newTotalMs: +(qMs + pMs + newOcrMs).toFixed(1),
    },
    newReadText: (newRes.data.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
  });
  process.stdout.write(`\r[${rows.length}/${manifest.labels.length}] ${L.category} → ${newKind} `);
}
await worker.terminate();

const all = rows;
const total = all.length;
const count = (pred) => all.filter(pred).length;
const ratePct = (pred) => `${(count(pred) / total) * 100}`;

const summary = {
  total,
  old_exact: count((r) => r.oldKind === 'old_exact'),
  old_wrong_match: count((r) => r.oldKind === 'old_wrong_match'),
  old_unknown: count((r) => r.oldKind === 'old_unknown'),
  old_no_read: count((r) => r.oldKind === 'old_no_read'),
  new_auto_exact: count((r) => r.newKind === 'new_auto_exact'),
  new_confirm_correct: count((r) => r.newKind === 'new_confirm_correct' || r.newKind === 'new_confirm_possible_correct'),
  new_auto_wrong: count((r) => r.newKind === 'new_auto_wrong'),
  new_drop: count((r) => r.newKind === 'new_drop'),
  quality_blocked: count((r) => r.qualityPass === false),
  old_success_rate: count((r) => r.oldKind === 'old_exact') / total,
  new_success_rate: count((r) => r.newKind === 'new_auto_exact' || r.newKind === 'new_confirm_correct') / total,
  elapsedMs: Date.now() - started,
};
const avg = (f) => all.reduce((s, r) => s + f(r), 0) / Math.max(1, all.length);
summary.latency = {
  oldOcrAvgMs: +avg((r) => r.ms.oldOcrMs).toFixed(1),
  newOcrAvgMs: +avg((r) => r.ms.newOcrMs).toFixed(1),
  qualityAvgMs: +avg((r) => r.ms.qualityMs).toFixed(1),
  preprocessAvgMs: +avg((r) => r.ms.preprocessMs).toFixed(1),
  newEndToEndAvgMs: +avg((r) => r.ms.newTotalMs).toFixed(1),
};

const byCat = {};
for (const r of all) (byCat[r.category] ??= []).push(r);
const table = Object.entries(byCat).map(([cat, list]) => {
  const n = list.length;
  const f = (pred) => `${(list.filter(pred).length / n) * 100}%`;
  return {
    category: cat, n,
    'old read exact': f((r) => r.oldKind === 'old_exact'),
    'old wrong/unknown submit': f((r) => r.oldKind === 'old_wrong_match' || r.oldKind === 'old_unknown'),
    'new auto exact': f((r) => r.newKind === 'new_auto_exact'),
    'new confirm ok': f((r) => r.newKind === 'new_confirm_correct' || r.newKind === 'new_confirm_possible_correct'),
    'new drop': f((r) => r.newKind === 'new_drop'),
  };
});

console.log(`\n\n==== BEFORE/AFTER — synthetic labels (${total}) — elapsed ${(summary.elapsedMs / 1000).toFixed(1)}s ====`);
console.table(table);
console.log(`TOTAL old: exact-read ${summary.old_exact}/${total} (${(100 * summary.old_success_rate).toFixed(1)}%) · WRONG-MATCH submitted ${summary.old_wrong_match} · garbage/unknown submitted ${summary.old_unknown} · no-read ${summary.old_no_read}`);
console.log(`TOTAL new: auto-exact ${summary.new_auto_exact} · confirmed-correct ${summary.new_confirm_correct} · unsafe auto-wrong ${summary.new_auto_wrong} · drops/rescan ${summary.new_drop} · quality-blocks ${summary.quality_blocked}`);
console.log(`success rates → old ${(100 * summary.old_success_rate).toFixed(1)}% | new ${(100 * summary.new_success_rate).toFixed(1)}%`);
console.log(`latency avg → old OCR ${summary.latency.oldOcrAvgMs}ms | new OCR ${summary.latency.newOcrAvgMs}ms (+quality ${summary.latency.qualityAvgMs}ms +preprocess ${summary.latency.preprocessAvgMs}ms = ${summary.latency.newEndToEndAvgMs}ms end-to-end)`);

writeFileSync(path.join(TMP, 'results.json'), JSON.stringify({ summary, table, rows }, null, 1));
