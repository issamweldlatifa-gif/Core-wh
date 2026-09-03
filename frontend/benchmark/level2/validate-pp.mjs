/**
 * PP-OCR level-2 offline validation (P1 gate).
 *
 * Runs the SAME TypeScript engine that ships to the browser (bundled via
 * esbuild) against real-label fixtures, using onnxruntime-node as the ONNX
 * backend, and compares the recognised lines with the Python (RapidOCR)
 * ground truth stored in *.expected.json.
 *
 * Usage:  node benchmark/level2/validate-pp.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONT = path.resolve(HERE, '../..');
const TMP = path.join(HERE, 'tmp');
const esbuild = path.join(FRONT, 'node_modules/.bin/esbuild');

execSync(
  `"${esbuild}" ${path.join(HERE, 'pp-bundle.ts')} --bundle --platform=node --format=esm --outfile=${path.join(TMP, 'pp-bundle.mjs')}`,
  { cwd: FRONT, stdio: 'pipe' },
);

const ort = require('onnxruntime-node');
const { PPOcrEngine } = await import(`./tmp/pp-bundle.mjs?t=${Date.now()}`);

const backend = {
  kind: 'node',
  async makeSession(bytes) {
    return ort.InferenceSession.create(bytes);
  },
  tensor(data, dims) {
    return new ort.Tensor('float32', data, dims);
  },
};

const models = {
  det: new Uint8Array(readFileSync(path.join(FRONT, 'public/ocr-models/ch_PP-OCRv3_det_infer.onnx'))),
  cls: new Uint8Array(readFileSync(path.join(FRONT, 'public/ocr-models/ch_ppocr_mobile_v2.0_cls_infer.onnx'))),
  rec: new Uint8Array(readFileSync(path.join(FRONT, 'public/ocr-models/ch_PP-OCRv3_rec_infer.onnx'))),
  keys: JSON.parse(readFileSync(path.join(FRONT, 'public/ocr-models/ppocr_keys.json'), 'utf8')),
};

const engine = new PPOcrEngine(backend);
await engine.init(models);

function normCode(s) {
  return s.replace(/[\s\-._/]/g, '').toUpperCase();
}

function loadPng(file) {
  const png = PNG.sync.read(readFileSync(file));
  return { data: png.data, width: png.width, height: png.height };
}

// Explicit acceptance targets: the actual product/label codes in each fixture.
// These are what the scanner must read; other recognised words (segmentation or
// cosmetic OCR differences like MadeIn vs MadelIn) are reported, not asserted.
const FIXTURE_TARGETS = {
  label_real_crop: ['PB2602010156165', 'sb2310176616632001', '2JW1Z3D0520179877'],
  scan_ui_full: ['PB2602010156165', 'sb2310176616632001', '2JW1Z3D0520179877', 'RCV-000202'],
};

const fixtures = [
  { name: 'label_real_crop', input: path.join(HERE, 'inputs/label_real_crop.png'), expected: path.join(HERE, 'label_real_crop.expected.json') },
  { name: 'scan_ui_full', input: path.join(HERE, 'inputs/scan_ui_full.png'), expected: path.join(HERE, 'scan_ui_full.expected.json') },
];

let allOk = true;
for (const fx of fixtures) {
  console.log('\n===== fixture:', fx.name);
  const expected = JSON.parse(readFileSync(fx.expected, 'utf8'));
  const exp = expected.lines
    .filter((l) => l.conf >= 0.5)
    .map((l) => ({ text: l.text, conf: l.conf }));

  const img = loadPng(fx.input);
  const started = Date.now();
  const res = await engine.recognize(img);
  const elapsedMs = Date.now() - started;
  const got = res.lines.map((l) => ({ text: l.text, conf: l.confidence }));

  console.log(`  engine: ${got.length} lines in ${elapsedMs}ms (det=${res.timings.detMs.toFixed(0)} rec=${res.timings.recMs.toFixed(0)})`);
  for (const g of got) console.log(`   TS   conf=${g.conf.toFixed(2)}  ${JSON.stringify(g.text)}`);
  for (const e of exp) {
    const hit = got.some((g) => g.text.replace(/\s+/g, ' ').trim() === e.text.replace(/\s+/g, ' ').trim());
    if (!hit) console.log(`   (python-only line: ${JSON.stringify(e.text)} conf=${e.conf.toFixed(2)})`);
  }

  const targets = FIXTURE_TARGETS[fx.name] ?? [];
  const gotCodes = new Set(got.map((l) => normCode(l.text)));

  let ok = true;
  const missing = [];
  for (const t of targets) {
    const norm = normCode(t);
    const found = gotCodes.has(norm);
    console.log(`   target ${t}: ${found ? 'OK' : 'MISSING'}`);
    if (!found) {
      ok = false;
      missing.push(t);
    }
  }
  if (ok && got.length === 0 && targets.length > 0) ok = false;
  console.log(`  => ${ok ? 'PASS' : 'FAIL'}${missing.length ? ' missing=' + missing.join(',') : ''}`);
  allOk = allOk && ok;
}
console.log('\nRESULT:', allOk ? 'ALL PASS' : 'FAILURES PRESENT');
process.exit(allOk ? 0 : 1);

