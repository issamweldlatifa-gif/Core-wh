#!/usr/bin/env python3
"""
Synthetic label dataset generator for the §17 before/after benchmark.

Deterministic (seeded) PNG labels rendered with real fonts (DejaVu) so that
Tesseract reads them realistically. Categories follow the order:

  Clear Label · Small Text · Low Light · Glare · Tilted Label ·
  Damaged Label · Different Fonts · Different Printers (low DPI) ·
  Different Label Sizes

Outputs `tmp/labels/*.png` + `tmp/manifest.json` (ground truth codes), which
`run-benchmark.mjs` consumes. Usage:  python3 benchmark/gen_labels.py
"""
import json
import os
import random
import sys

from PIL import Image, ImageDraw, ImageFont, ImageFilter

try:
    import numpy as _np
except Exception:  # pragma: no cover
    _np = None

import qrcode
import barcode
from barcode.writer import ImageWriter

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'tmp', 'labels')
FONT_DIR = '/usr/share/fonts/truetype/dejavu'

FONTS = {
    'sans': os.path.join(FONT_DIR, 'DejaVuSans.ttf'),
    'sans-bold': os.path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'),
    'mono': os.path.join(FONT_DIR, 'DejaVuSansMono.ttf'),
    'serif': os.path.join(FONT_DIR, 'DejaVuSerif.ttf'),
}

# Realistic AYROVI-style codes (cartons, SKUs, references). The corpus in the
# benchmark equals this set — exactly like a receiving session's expected data.
CODES = [
    'ABO-123456',
    'TUN-88912',
    'SKU-100200300',
    'CTN-000123',
    '1Z999AA10123456784',
    'ORD-2026-00891',
    'AYROVI-99213',
    'SO-88231-K',
]

# Extra codes the NEW unified-P0 categories render. They are added to the
# session corpus so SKU/Reference direct scans can MATCH — the order's premise.
CORPUS_EXTRA = [
    'SKU-250125789',
    'SKU-764332100',
    'SO-55991-K',
    'CUST-55991-AB',
]

# Codes intentionally NOT in the corpus (safety categories: no-match).
NO_MATCH_CODES = ['XZZ-999999', 'KLM-404040', 'WIP-000123']
# Codes printed almost like a real corpus code but NOT in it (wrong-OCR must
# never auto-enter: candidate/possible-match only).
CONFUSABLE_CODES = ['SKU-100200301', 'ABO-123457']

BG = 244
INK = 12


def draw_label(code: str, width: int, font_key: str, size: int, pad: int = 26):
    """Basic code-on-label image with a small caption, matching a printed label."""
    img = Image.new('L', (width, int(size * 1.5) + 2 * pad + 34), BG)
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONTS[font_key], size)
    # faint caption noise like a real shipping label
    cap = ImageFont.truetype(FONTS['sans'], 13)
    d.text((pad, 8), 'MADE IN TUNISIA  ·  HAZ 3  ·  BOX 1/12', fill=150, font=cap)
    d.text((pad, int(size * 1.5) + pad - 4), code, fill=INK, font=font)
    return img


def add_glare(img: Image.Image, rng: random.Random):
    w, h = img.size
    mask = Image.new('L', (w, h), 0)
    md = ImageDraw.Draw(mask)
    cx, cy = int(w * (0.3 + 0.3 * rng.random())), int(h * (0.2 + 0.3 * rng.random()))
    rx, ry = int(w * 0.22), int(h * 0.30)
    md.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(8))
    shine = Image.new('L', (w, h), 255)
    return Image.composite(shine, img, mask)


def add_damage(img: Image.Image, rng: random.Random):
    """Gaps / stains over the printed text, like a scuffed label."""
    out = img.copy()
    d = ImageDraw.Draw(out)
    w, h = out.size
    for _ in range(rng.randint(6, 12)):
        x = rng.randint(0, w - 1)
        y = rng.randint(0, h - 1)
        r = rng.randint(1, 4)
        shade = rng.choice([BG, 128])
        d.ellipse((x - r, y - r, x + r, y + r), fill=shade)
    # speckle noise
    px = out.load()
    for _ in range(800):
        x = rng.randint(0, w - 1)
        y = rng.randint(0, h - 1)
        v = px[x, y]
        if rng.random() < 0.5:
            px[x, y] = min(255, v + rng.randint(6, 40))
        else:
            px[x, y] = max(0, v - rng.randint(6, 40))
    return out


def low_dpi(img: Image.Image, factor: float = 0.42):
    """Downscale + upscale = aliased 'poor printer DPI' look."""
    w, h = img.size
    small = img.resize((max(2, int(w * factor)), max(2, int(h * factor))), Image.BILINEAR)
    return small.resize((w, h), Image.BILINEAR)


def motion_smear(img: Image.Image, k: int = 10):
    """Horizontal motion blur (camera moved while scanning)."""
    g = img.convert('L')
    w, h = g.size
    if _np is None:
        return g
    a = _np.asarray(g, dtype=_np.float64)
    out = _np.empty_like(a)
    # box over trailing k px along x (causal) — direction-agnostic enough
    for x in range(w):
        lo = max(0, x - k)
        out[:, x] = a[:, lo:x + 1].mean(axis=1)
    return Image.fromarray(_np.clip(out, 0, 255).astype(_np.uint8))


def qr_image(code: str, box: int = 7):
    q = qrcode.QRCode(version=None, box_size=box, border=2,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    q.add_data(code)
    q.make(fit=True)
    return q.make_image(fill_color='black', back_color='white').convert('L')


def barcode_image(code: str):
    """Code128 rendered by python-barcode; returned as a grayscale PIL image."""
    bc = barcode.get('code128', code, writer=ImageWriter())
    tmp = os.path.join(HERE, 'tmp', f'_bc_{abs(hash(code))}')
    bc.save(tmp, options={'write_text': False, 'module_width': 0.30,
                          'module_height': 16, 'quiet_zone': 6.5, 'font_size': 0})
    path = tmp + '.png'
    try:
        return Image.open(path).convert('L')
    finally:
        if os.path.exists(path):
            os.remove(path)


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(20260903)
    manifest = []
    idx = 0

    def emit(category, img, code, kind='text', label_kind='CARTON'):
        nonlocal idx
        idx += 1
        fname = f'{idx:02d}-{category}.png'
        img.save(os.path.join(OUT, fname))
        manifest.append({
            'id': idx, 'category': category, 'gt': code,
            'file': fname, 'kind': kind, 'labelKind': label_kind,
        })

    # 1 · Clear labels
    for code in rng.sample(CODES, 3):
        emit('clear', draw_label(code, 620, 'sans', 44), code)
    # 2 · Small text
    for code in rng.sample(CODES, 3):
        img = draw_label(code, 620, 'sans', 22)
        img = img.crop((0, 0, 620, img.size[1]))
        emit('small_text', img, code)
    # 3 · Low light (dim, not pitch black — the gate still attempts OCR)
    for code in rng.sample(CODES, 3):
        img = draw_label(code, 620, 'sans', 44)
        img = Image.eval(img, lambda v: int(v * 0.42))
        emit('low_light', img, code)
    # 4 · Glare
    for code in rng.sample(CODES, 3):
        img = add_glare(draw_label(code, 620, 'sans', 44), rng)
        emit('glare', img, code)
    # 5 · Tilted
    for code in rng.sample(CODES, 3):
        img = draw_label(code, 620, 'sans', 44)
        img = img.rotate(rng.choice([-7, -5, 4, 6, 8]), expand=True, fillcolor=BG,
                         resample=Image.BICUBIC)
        emit('tilted', img, code)
    # 6 · Damaged
    for code in rng.sample(CODES, 3):
        emit('damaged', add_damage(draw_label(code, 620, 'sans', 44), rng), code)
    # 7 · Different fonts (labels printed with different label printers/fonts)
    for code, fk in zip(rng.sample(CODES, 3), ['sans-bold', 'mono', 'serif']):
        emit('font_' + fk, draw_label(code, 640, fk, 42), code)
    # 8 · Different printers (simulated low DPI + slight blur)
    for code in rng.sample(CODES, 3):
        img = draw_label(code, 620, 'sans', 44)
        img = low_dpi(img, 0.38).filter(ImageFilter.GaussianBlur(0.4))
        emit('printer_lowdpi', img, code)
    # 9 · Different label sizes
    for code in rng.sample(CODES, 3):
        if len(code) < 10:
            img = draw_label(code, 460, 'sans', 52)
        else:
            img = draw_label(code, 760, 'sans', 40)
        emit('label_size', img, code)

    # =====================================================================
    # UNIFIED P0 categories (ids continue after the frozen §17 set)
    # =====================================================================
    # 10 · Direct SKU target (single-line product label → line OCR)
    for code in CORPUS_EXTRA[:2]:
        emit('sku_direct', draw_label(code, 620, 'sans', 46), code, label_kind='PRODUCT')
    # 11 · Direct Reference target
    for code in CORPUS_EXTRA[2:]:
        emit('ref_direct', draw_label(code, 620, 'mono', 46), code, label_kind='PRODUCT')
    # 12 · Motion (camera moved while scanning)
    for code in rng.sample(CODES, 3):
        emit('motion', motion_smear(draw_label(code, 620, 'sans', 44), k=11), code)
    # 13 · No Match — printed code NOT in the session corpus
    for code in NO_MATCH_CODES:
        emit('no_match', draw_label(code, 620, 'sans', 46), code)
    # 14 · Wrong OCR — code nearly equal to a real corpus code, but NOT it
    for code in CONFUSABLE_CODES:
        emit('confusable', draw_label(code, 620, 'sans', 46), code, label_kind='PRODUCT')
    # 15 · Fast path: real QR codes
    for code in rng.sample(CODES, 3):
        emit('qr_clear', qr_image(code), code, kind='qr')
    # 16 · Fast path: real Code128 barcodes
    for code in rng.sample(CODES, 3):
        emit('barcode_clear', barcode_image(code), code, kind='barcode')

    with open(os.path.join(HERE, 'tmp', 'manifest.json'), 'w') as f:
        json.dump({'corpus': CODES + CORPUS_EXTRA, 'labels': manifest}, f, indent=1)
    print(f'generated {idx} labels in {OUT}')


if __name__ == '__main__':
    sys.exit(main())
