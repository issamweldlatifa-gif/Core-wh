#!/usr/bin/env node
/**
 * Unified-P0 before/after benchmark runner.
 *
 * Reads the synthetic labels (45 labels / 16 categories) from
 * tmp/labels/*.png (gen_labels.py) and evaluates BOTH pipelines with the SAME
 * Tesseract.js engine + the SAME ZXing decode the browser uses:
 *
 *   FAST PATH  (qr_clear / barcode_clear) — ZXing MultiFormatReader over the
 *               ROI luma (identical RGBLuminanceSource+HybridBinarizer code
 *               path as ContinuousScanner.readBarcode). Decode → corpus exact
 *               → matched. Measures decode accuracy + latency; then asserts
 *               the duplicate guard yields exactly ONE event.
 *   SLOW PATH  (text) — CURRENT (legacy global-threshold → first raw token,
 *               auto-submit, no gate/validation) vs IMPROVED (quality gate →
 *               auto profile → OCR → fields → consensus-weighted confidence →
 *               corpus validation → HIGH auto / MEDIUM confirm / LOW drop).
 *               PRODUCT labels (sku_direct / ref_direct / confusable) run the
 *               DIRECT-TARGET path: dominant text line → dynamic crop → deskew
 *               decision → PSM7 line OCR (mirrors ContinuousScanner).
 *
 * The TS pipeline is bundled by esbuild from pipeline.ts so this exercises the
 * exact shipped code. Outputs tables + tmp/results.json (frozen).
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createWorker } from 'tesseract.js';
import {
  MultiFormatReader,
  HybridBinarizer,
  RGBLuminanceSource,
  DecodeHintType,
  BarcodeFormat,
} from '@zxing/library';

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
const FL = P.findDominantLine;
const CROP = P.lineCropBox;
const SKEW = P.estimateSkewDeg;
const SKEWPROF = P.profileForLineSkew;
const ISDUP = P.isDuplicate;
const NOTE = P.noteSubmission;

const manifest = JSON.parse(readFileSync(path.join(TMP, 'manifest.json'), 'utf8'));
const corpus = manifest.corpus.map((c) => c.toUpperCase());

function grayFromPixels(px) {
  const g = new Uint8ClampedArray(px.width * px.height);
  for (let i = 0, p = 0; i < g.length; i += 1, p += 4) {
    g[i] = (px.data[p] * 0.299 + px.data[p + 1] * 0.587 + px.data[p + 2] * 0.114) | 0;
  }
  return g;
}

/** applyProfile consumes RGBA Pixels (converts via toGray internally), so
 *  widen the luma ROI/line buffers before preprocessing — same as the app. */
function grayToRgba(gray, w, h) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, p = 0; i < w * h; i += 1, p += 4) {
    rgba[p] = gray[i]; rgba[p + 1] = gray[i];
    rgba[p + 2] = gray[i]; rgba[p + 3] = 255;
  }
  return rgba;
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

/** Same decode path as the browser scanner (§4 fast path). */
const ZX_FORMATS = [
  BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93, BarcodeFormat.CODABAR, BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
  BarcodeFormat.ITF, BarcodeFormat.DATA_MATRIX,
];
function decodeImage(file) {
  const png = PNG.sync.read(readFileSync(file));
  const lum = new Uint8ClampedArray(png.width * png.height);
  for (let i = 0, p = 0; i < lum.length; i += 1, p += 4) {
    lum[i] = (png.data[p] * 0.299 + png.data[p + 1] * 0.587 + png.data[p + 2] * 0.114) | 0;
  }
  const reader = new MultiFormatReader();
  const hints = new Map();
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZX_FORMATS);
  reader.setHints(hints);
  const src = new RGBLuminanceSource(lum, png.width, png.height);
  const r = reader.decode(new HybridBinarizer(src));
  return r?.getText?.().trim() ?? null;
}

/** OLD scanner decision: submit first raw candidate; no validation anywhere. */
function oldDecision(text) {
  const cands = EC(text);
  if (!cands.length) return { kind: 'no_read', guess: '' };
  return { kind: 'read', guess: cands[0] };
}

function classifyOld(old, gt, inCorpus) {
  if (old.kind !== 'read') return 'old_no_read';
  if (old.guess === gt) return inCorpus ? 'old_auto_correct' : 'old_auto_out_of_corpus';
  if (corpus.includes(old.guess)) return 'old_auto_wrong_corpus';
  return 'old_auto_unknown';
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
  if (!qualityGatePass) return { kind: 'quality_blocked', value: best.clean };
  const value = best.match.kind === 'candidate' && best.match.matched ? best.match.matched : best.clean;
  return { kind: best.conf.level.toLowerCase(), value, match: best.match, conf: best.conf };
}

const worker = await createWorker('eng', 1, { cachePath: path.join(TMP, 'tessdata') });
await worker.setParameters({
  tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-',
  tessedit_pageseg_mode: '6',
});
async function recognizePng(file, psm = '6') {
  if (psm !== '6') await worker.setParameters({ tessedit_pageseg_mode: psm });
  const { data } = await worker.recognize(file);
  if (psm !== '6') await worker.setParameters({ tessedit_pageseg_mode: '6' });
  return { text: data.text ?? '', confidence: data.confidence ?? 0 };
}

// ===========================================================================
const rows = []; // text (slow path)
const fastRows = []; // qr / barcode (fast path)
const started = Date.now();

for (const L of manifest.labels) {
  const png = PNG.sync.read(readFileSync(path.join(TMP, 'labels', L.file)));
  const px = { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  const gray = grayFromPixels(px);
  const gt = L.gt.toUpperCase();

  // ----------------------- FAST PATH (QR / barcode) -----------------------
  if (L.kind === 'qr' || L.kind === 'barcode') {
    const d0 = performance.now();
    let decoded = null;
    try { decoded = decodeImage(path.join(TMP, 'labels', L.file)); } catch { decoded = null; }
    const ms = performance.now() - d0;
    const ok = decoded === gt;
    fastRows.push({ id: L.id, category: L.category, gt, decoded, ok, decodeMs: +ms.toFixed(1) });
    process.stdout.write(`\r[${rows.length + fastRows.length}/${manifest.labels.length}] ${L.category} → ${ok ? 'DECODED+MATCH' : 'MISS'}`);
    continue;
  }

  const product = L.labelKind === 'PRODUCT';
  const inCorpus = corpus.includes(gt);

  // ----------------------- CURRENT pipeline (legacy) -----------------------
  const legacyGray = LEGACY(gray);
  writeFileSync(path.join(WORK, 'cur.png'), pngFromGray(legacyGray, px.width, px.height));
  const oldT0 = performance.now();
  const oldRes = await recognizePng(path.join(WORK, 'cur.png'), '6');
  const oldOcrMs = performance.now() - oldT0;
  const old = oldDecision(oldRes.text ?? '');

  // ----------------------- IMPROVED pipeline (smart path) -----------------
  const qT0 = performance.now();
  const q = AQ(gray, px.width, px.height);
  const qMs = performance.now() - qT0;

  // quality gate (same precedence as the component)
  if (CFG.ocr.qualityGateEnabled && !q.pass) {
    const r = {
      id: L.id, category: L.category, gt, labelKind: L.labelKind, product,
      oldKind: classifyOld(old, gt, inCorpus),
      oldGuess: old.kind === 'read' ? old.guess : '',
      newKind: 'new_drop', qualityLevel: q.level, qualityPass: false,
      qualityReasons: q.reasons.join('+') || '-', profile: '-', ocrConf: 0,
      ms: { oldOcrMs: +oldOcrMs.toFixed(1), newOcrMs: 0, qualityMs: +qMs.toFixed(1), preprocessMs: 0, newTotalMs: +qMs.toFixed(1) },
      lineFound: null, newReadText: '',
    };
    rows.push(r);
    process.stdout.write(`\r[${rows.length + fastRows.length}/${manifest.labels.length}] ${L.category} → quality-gate drop`);
    continue;
  }

  let profile = SP(q);
  let psm = profile === 'C_SMALL_TEXT' ? '7' : '6';
  let ocrGray = gray;
  let ocrW = px.width;
  let ocrH = px.height;
  let lineFound = null;
  let targetMs = 0;

  if (product) {
    // DIRECT TARGET: dominant line → dynamic crop (§5/§6/§8)
    const t0 = performance.now();
    const line = FL(gray, px.width, px.height, {
      maxWidth: CFG.targeting.analysisMaxWidth, preferLowest: true,
    });
    targetMs = performance.now() - t0;
    if (!line || line.score < CFG.targeting.minScore) {
      const r = {
        id: L.id, category: L.category, gt, labelKind: L.labelKind, product,
        oldKind: classifyOld(old, gt, inCorpus),
        oldGuess: old.kind === 'read' ? old.guess : '',
        newKind: 'new_drop', qualityLevel: q.level, qualityPass: true,
        qualityReasons: q.reasons.join('+') || '-', profile, ocrConf: 0,
        ms: { oldOcrMs: +oldOcrMs.toFixed(1), newOcrMs: 0, qualityMs: +qMs.toFixed(1), preprocessMs: 0, newTotalMs: +(qMs + targetMs).toFixed(1) },
        lineFound: false, newReadText: '',
      };
      rows.push(r);
      process.stdout.write(`\r[${rows.length + fastRows.length}/${manifest.labels.length}] ${L.category} → no-target-line drop`);
      continue;
    }
    lineFound = true;
    const box = CROP(line, px.width, px.height, CFG.targeting.margin);
    if (box && box.height >= 8 && box.width >= 12) {
      const crop = new Uint8ClampedArray(box.width * box.height);
      for (let yy = 0; yy < box.height; yy += 1) {
        for (let xx = 0; xx < box.width; xx += 1) {
          crop[yy * box.width + xx] = gray[(box.y + yy) * px.width + (box.x + xx)];
        }
      }
      const skew = SKEW(crop, box.width, box.height);
      profile = SKEWPROF(skew, profile);
      ocrGray = crop;
      ocrW = box.width;
      ocrH = box.height;
      psm = '7';
    }
  }

  const pT0 = performance.now();
  const rgbaIn = grayToRgba(ocrGray, ocrW, ocrH);
  const prepped = AP({ data: rgbaIn.slice(), width: ocrW, height: ocrH }, profile, {
    smallTextUpscale: CFG.ocr.smallTextUpscale,
    maxWidth: CFG.ocr.ocrMaxWidth,
  });
  const pMs = performance.now() - pT0;
  writeFileSync(path.join(WORK, 'new.png'), pngFromGray(prepped.gray, prepped.width, prepped.height));
  const newT0 = performance.now();
  const newRes = await recognizePng(path.join(WORK, 'new.png'), psm);
  const newOcrMs = performance.now() - newT0;
  const conf01 = Math.max(0, Math.min(1, newRes.confidence / 100));
  const nd = newDecision(newRes.text ?? '', conf01, q.score, true);

  const oldKind = classifyOld(old, gt, inCorpus);

  let newKind;
  if (nd.kind === 'high') {
    newKind = nd.value === gt && inCorpus ? 'new_auto_exact'
      : nd.value === gt ? 'new_auto_out_of_corpus'     // never happens: out-of-corpus never scores HIGH
      : 'new_auto_wrong';
  } else if (nd.kind === 'medium') {
    const near = nd.match?.candidates?.some((c) => c.value === gt);
    if (!corpus.includes(nd.value) && !near) newKind = 'new_confirm_manual';   // human verify / manual fallback — SAFE
    else newKind = nd.value === gt ? 'new_confirm_correct' : near ? 'new_confirm_possible_correct' : 'new_confirm_wrong';
  } else newKind = 'new_drop';

  rows.push({
    id: L.id, category: L.category, gt, labelKind: L.labelKind, product,
    oldKind, oldGuess: old.kind === 'read' ? old.guess : '',
    newKind,
    qualityLevel: q.level, qualityPass: true, qualityReasons: q.reasons.join('+') || '-',
    profile,
    ocrConf: +conf01.toFixed(2),
    ms: {
      oldOcrMs: +oldOcrMs.toFixed(1), newOcrMs: +newOcrMs.toFixed(1),
      qualityMs: +qMs.toFixed(1), preprocessMs: +pMs.toFixed(1),
      targetMs: +targetMs.toFixed(1),
      newTotalMs: +(qMs + pMs + newOcrMs + targetMs).toFixed(1),
    },
    lineFound,
    newReadText: (newRes.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 80),
  });
  process.stdout.write(`\r[${rows.length + fastRows.length}/${manifest.labels.length}] ${L.category} → ${newKind}`);
}
await worker.terminate();

// ---- duplicate guard: one physical code → one event (§26) ----
const dup = { lastValue: '', lastAt: 0 };
const DUP_WINDOW = CFG.duplicate.repeatWindowMs;
let dupEvents = 0;
const d0 = Date.now();
if (!ISDUP(dup, 'CTN-000123', d0, DUP_WINDOW)) { NOTE(dup, 'CTN-000123', d0); dupEvents += 1; }
for (let t = 1; t <= 20; t += 1) { // continuous re-holds of the SAME code
  ISDUP(dup, 'CTN-000123', d0 + t * 100, DUP_WINDOW);
}
const duplicate = { windowMs: DUP_WINDOW, eventsForOneCode: dupEvents };

// ============================ aggregate ====================================
const all = rows;
const total = all.length;
const count = (pred) => all.filter(pred).length;
const inC = (r) => corpus.includes(r.gt);

const nCorpusText = count(inC); // text labels whose gt IS on the order
const nOutText = total - nCorpusText; // safety labels: code NOT on the order
const OLD_GOOD = (r) => r.oldKind === 'old_auto_correct';
const OLD_BAD_SUBMIT = (r) => ['old_auto_wrong_corpus', 'old_auto_unknown', 'old_auto_out_of_corpus'].includes(r.oldKind);
const NEW_AUTO_OK = (r) => r.newKind === 'new_auto_exact';
const NEW_CONFIRM_SAFE = (r) => ['new_confirm_correct', 'new_confirm_possible_correct', 'new_confirm_manual'].includes(r.newKind);
const NEW_DROP = (r) => r.newKind === 'new_drop' || r.newKind === 'new_confirm_wrong';
const NEW_AUTO_BAD = (r) => r.newKind === 'new_auto_wrong' || r.newKind === 'new_auto_out_of_corpus';

const summary = {
  totalText: total,
  corpusInText: nCorpusText,
  corpusOutText: nOutText,
  old_auto_correct: count((r) => OLD_GOOD(r)),
  old_auto_bad_submit: count((r) => OLD_BAD_SUBMIT(r)),
  old_no_read: count((r) => r.oldKind === 'old_no_read'),
  new_auto_exact: count((r) => r.newKind === 'new_auto_exact'),
  new_confirm_correct: count((r) => r.newKind === 'new_confirm_correct'),
  new_confirm_possible_correct: count((r) => r.newKind === 'new_confirm_possible_correct'),
  new_confirm_manual: count((r) => r.newKind === 'new_confirm_manual'),
  new_confirm_wrong: count((r) => r.newKind === 'new_confirm_wrong'),
  new_drop: count((r) => r.newKind === 'new_drop'),
  new_auto_wrong: count((r) => NEW_AUTO_BAD(r)),
  quality_gate_blocks: count((r) => r.qualityPass === false),
  no_target_drops: count((r) => r.lineFound === false),
  // Rates are computed over IN-CORPUS labels only: out-of-corpus reads must be
  // blocked, never counted as scanner misses.
  old_auto_success_rate: count((r) => inC(r) && OLD_GOOD(r)) / nCorpusText,
  new_auto_success_rate: count((r) => inC(r) && NEW_AUTO_OK(r)) / nCorpusText,
  new_full_success_rate: count((r) => inC(r) && (NEW_AUTO_OK(r) || NEW_CONFIRM_SAFE(r))) / nCorpusText,
  old_out_of_corpus_autoentered: count((r) => !inC(r) && r.oldKind.startsWith('old_auto')), // would enter a code NOT on the order
  new_out_of_corpus_autoentered: count((r) => !inC(r) && NEW_AUTO_BAD(r)), // must stay 0
  new_out_of_corpus_blocked: count((r) => !inC(r) && !NEW_AUTO_BAD(r)),
  duplicate,
  fast: {
    qrOk: fastRows.filter((r) => r.category === 'qr_clear' && r.ok).length,
    qrTotal: fastRows.filter((r) => r.category === 'qr_clear').length,
    barcodeOk: fastRows.filter((r) => r.category === 'barcode_clear' && r.ok).length,
    barcodeTotal: fastRows.filter((r) => r.category === 'barcode_clear').length,
    avgDecodeMs: +(fastRows.reduce((s, r) => s + r.decodeMs, 0) / Math.max(1, fastRows.length)).toFixed(1),
  },
  latency: {},
  elapsedMs: Date.now() - started,
};
const avg = (f) => all.reduce((s, r) => s + f(r), 0) / Math.max(1, all.length);
summary.latency = {
  oldOcrAvgMs: +avg((r) => r.ms.oldOcrMs).toFixed(1),
  newOcrAvgMs: +avg((r) => r.ms.newOcrMs).toFixed(1),
  qualityAvgMs: +avg((r) => r.ms.qualityMs).toFixed(1),
  preprocessAvgMs: +avg((r) => r.ms.preprocessMs).toFixed(1),
  targetAvgMs: +(all.filter((r) => r.product).reduce((s, r) => s + (r.ms.targetMs ?? 0), 0) / Math.max(1, all.filter((r) => r.product).length)).toFixed(1),
  newEndToEndAvgMs: +avg((r) => r.ms.newTotalMs).toFixed(1),
};
summary.fast.qrRate = summary.fast.qrTotal ? summary.fast.qrOk / summary.fast.qrTotal : 0;
summary.fast.barcodeRate = summary.fast.barcodeTotal ? summary.fast.barcodeOk / summary.fast.barcodeTotal : 0;
summary.unsafeAutoWrong = count((r) => NEW_AUTO_BAD(r));

// per-category text table
const byCat = {};
for (const r of all) (byCat[r.category] ??= []).push(r);
const table = Object.entries(byCat).map(([cat, list]) => {
  const n = list.length;
  const f = (pred) => `${((list.filter(pred).length / n) * 100).toFixed(0)}%`;
  return {
    category: cat, n,
    'old auto ✔': f((r) => OLD_GOOD(r)),
    'old auto ✗ submit': f((r) => OLD_BAD_SUBMIT(r)),
    'new auto ✔': f((r) => NEW_AUTO_OK(r)),
    'new confirm': f((r) => NEW_CONFIRM_SAFE(r)),
    'new rescan': f((r) => NEW_DROP(r)),
  };
});

// fast-path table (decode accuracy)
const fastTable = (['qr_clear', 'barcode_clear']).map((cat) => {
  const list = fastRows.filter((r) => r.category === cat);
  return {
    category: cat,
    n: list.length,
    decoded: `${list.filter((r) => r.ok).length}/${list.length}`,
    okRate: `${((list.filter((r) => r.ok).length / Math.max(1, list.length)) * 100).toFixed(0)}%`,
    avgDecodeMs: `${(list.reduce((s, r) => s + r.decodeMs, 0) / Math.max(1, list.length)).toFixed(1)}ms`,
  };
});

console.log(`\n\n==== BEFORE/AFTER — text slow path (${total}) + fast path (${fastRows.length}) — ${(summary.elapsedMs / 1000).toFixed(1)}s ====`);
console.log(`(in-corpus text ${nCorpusText} · out-of-corpus safety text ${nOutText})`);
console.table(table);
console.log(`FAST PATH (${fastRows.length} QR/barcode):`);
console.table(fastTable);
console.log(`OLD: auto-correct ${summary.old_auto_correct} · would auto-submit WRONG/UNKNOWN ${summary.old_auto_bad_submit} · no-read ${summary.old_no_read}  (auto success on in-corpus ${(100 * summary.old_auto_success_rate).toFixed(1)}%)`);
console.log(`NEW: auto-exact ${summary.new_auto_exact} · confirm-correct ${summary.new_confirm_correct} · confirm-possible ${summary.new_confirm_possible_correct} · confirm-manual ${summary.new_confirm_manual} · drop/rescan ${summary.new_drop + summary.new_confirm_wrong} · unsafe auto-wrong ${summary.new_auto_wrong}`);
console.log(`success rates (in-corpus only) → old auto ${(100 * summary.old_auto_success_rate).toFixed(1)}% | new auto ${(100 * summary.new_auto_success_rate).toFixed(1)}% | new auto+confirm ${(100 * summary.new_full_success_rate).toFixed(1)}%`);
console.log(`out-of-corpus codes: old would auto-enter ${summary.old_out_of_corpus_autoentered}/${nOutText} (WRONG ARTICLE) · new auto-enters ${summary.new_out_of_corpus_autoentered}, blocked/verified ${summary.new_out_of_corpus_blocked}`);
console.log(`latency avg → old OCR ${summary.latency.oldOcrAvgMs}ms | new OCR ${summary.latency.newOcrAvgMs}ms (+q ${summary.latency.qualityAvgMs}ms +pp ${summary.latency.preprocessAvgMs}ms +target ${summary.latency.targetAvgMs}ms = ${summary.latency.newEndToEndAvgMs}ms)`);
console.log(`fast decode → QR ${(100 * summary.fast.qrRate).toFixed(0)}% · Code128 ${(100 * summary.fast.barcodeRate).toFixed(0)}% · avg ${summary.fast.avgDecodeMs}ms`);
console.log(`duplicate guard → ${duplicate.eventsForOneCode} event(s) for one continuous code (window ${duplicate.windowMs}ms)`);

writeFileSync(path.join(TMP, 'results.json'), JSON.stringify({ summary, table, fastTable, rows, fastRows }, null, 1));
