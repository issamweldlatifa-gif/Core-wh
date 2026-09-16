"""
SCREEN FIT CHECK — does a station screen fit the glass?

Writes a real browser report for every screen of a station at several window
sizes (including the 1568×787 of the owner's screenshot, 2026-09-16) and exits
non-zero if anything is pushed out of the viewport: the page must not scroll,
the action bar must be fully visible, and the footer must be on screen.

  python3 tools/display-fit-check.py            # all views of one station
  python3 tools/display-fit-check.py BATCH-01   # another station

Needs the dev stack up (API :3000 + vite :5173) and the DB that demo_data.py
filled (the tokens come straight from the database).
"""

import json
import subprocess
import sys
from pathlib import Path

import os
PSQL = ["/usr/lib/postgresql/17/bin/psql", "-h", "/tmp", "-p", "5433", "-U", "postgres", "-d", "ayrovi", "-t", "-A", "-c"]
import os
BASE = os.environ.get("FIT_BASE", "http://127.0.0.1:5173")
OUT = Path(os.environ.get("FIT_OUT", "/home/user/fit-report"))
SIZES = [
    (1568, 787, "owner-laptop"),   # the window in the owner's screenshot
    (1920, 1080, "full-hd-tv"),
    (1366, 768, "small-laptop"),
    (1024, 768, "old-wall-screen"),
    (768, 1024, "portrait-fallback"),
]


def sql(q: str) -> str:
    return subprocess.run(PSQL + [q], capture_output=True, text=True).stdout.strip()


def screens(station: str):
    q = (
        "select d.config->>'view', d.\"accessToken\", (d.config->>'interactive')::bool "
        "from station_displays d join stations s on s.id=d.\"stationId\" "
        f"where s.code='{station}' order by 1"
    )
    out = []
    for line in sql(q).splitlines():
        if line.strip():
            view, token, interactive = line.split("|")
            out.append((view, token, interactive == "true"))
    return out


SCRIPT = """
async ({ url, width, height, shot }) => {
  return await new Promise((resolve) => {
    const done = (payload) => resolve(payload);
    const run = async () => {
      const page = window.__page;
      const info = await page.evaluate(() => {
        const vh = window.innerHeight, vw = window.innerWidth;
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) };
        };
        const root = document.querySelector('[data-testid="station-display"]');
        const bar = rect('[data-testid="action-bar"]');
        const foot = document.querySelector('footer');
        return {
          view: root ? root.getAttribute('data-view') : null,
          vw, vh,
          scrollH: document.documentElement.scrollHeight,
          scrollW: document.documentElement.scrollWidth,
          bar,
          footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null,
          content: (root ? root.innerText : '').slice(0, 90).replace(/\\n/g, ' | '),
        };
      });
      done(info);
    };
    run();
  });
}
"""

JS = """
const { chromium } = require('playwright');
(async () => {
  const cfg = JSON.parse(process.argv[2]);
  const browser = await chromium.launch();
  const results = [];
  for (const screen of cfg.screens) {
    for (const [w, h, label] of cfg.sizes) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(cfg.base + '/display/' + screen.token, { waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="station-display"]', { timeout: 15000 });
      await page.waitForTimeout(700); // let the live snapshot land
      const info = await page.evaluate(() => {
        const vh = window.innerHeight, vw = window.innerWidth;
        const rect = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };
        const root = document.querySelector('[data-testid="station-display"]');
        const foot = document.querySelector('footer');
        return {
          view: root ? root.getAttribute('data-view') : null,
          vw, vh,
          scrollH: document.documentElement.scrollHeight,
          bar: rect('[data-testid="action-bar"]'),
          footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null,
          text: (root ? root.innerText : '').replace(/\\s+/g, ' ').slice(0, 80),
        };
      });
      const fits = info.scrollH <= h + 2 && (info.bar === null || info.bar.bottom <= h + 1) && (info.footBottom === null || info.footBottom <= h + 1);
      if (label === 'owner-laptop') {
        await page.screenshot({ path: cfg.out + '/' + screen.view + '-' + w + 'x' + h + '.png' });
      }
      results.push({ view: screen.view, size: label, w, h, fits, scrollH: info.scrollH, barBottom: info.bar && info.bar.bottom, footBottom: info.footBottom, text: info.text });
      await page.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(results, null, 1));
})();
"""


def main() -> int:
    station = sys.argv[1] if len(sys.argv) > 1 else "ST-REC-01"
    rows = screens(station)
    if not rows:
        print(f"no displays for station {station}")
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    js_path = Path("/home/user/fit-report") / "_fit.js"  # runner lives with the playwright install
    js_path.write_text(JS)
    cfg = {
        "base": BASE,
        "out": str(OUT),
        "screens": [{"view": v, "token": t} for v, t, _ in rows],
        "sizes": [[w, h, label] for w, h, label in SIZES],
    }
    proc = subprocess.run(
        ["node", str(js_path), json.dumps(cfg)],
        cwd="/home/user/fit-report",  # scratch harness: playwright lives there, never in the app repo
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        return 1
    results = json.loads(proc.stdout)
    bad = [r for r in results if not r["fits"]]
    print(f"station {station} — {len(rows)} screens × {len(SIZES)} window sizes = {len(results)} measurements")
    print(f"{'view':8s} {'size':16s} {'win':11s} {'scrollH':>8s} {'barBottom':>10s} {'footBottom':>11s}  fits")
    for r in results:
        print(
            f"{r['view']:8s} {r['size']:16s} {str(r['w']) + 'x' + str(r['h']):11s} "
            f"{r['scrollH']:>8d} {str(r['barBottom']):>10s} {str(r['footBottom']):>11s}  {'OK' if r['fits'] else 'PUSHED OFF'}"
        )
    print()
    for r in results[:1]:
        print(f"screen text: {r['text']}")
    print(f"screenshots: {OUT}/ (owner-laptop 1568x787 per view)")
    if bad:
        print(f"\nFAIL — {len(bad)} combination(s) push content out of the viewport")
        for r in bad:
            print(f"  {r['view']} @ {r['w']}x{r['h']}: scrollH={r['scrollH']} bar={r['barBottom']} foot={r['footBottom']}")
        return 1
    print("\nPASS — every screen is complete on every window size (nothing pushed off the glass)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
