# Station Display v2 — Interactive Assist & Control — Implementation Report

**Owner order (2026-09-16, stage 2):** «the display must help the worker, show
and record every action, and let us act from it — e.g. print or other actions —
for **all** stations».
**Owner decisions taken before this build:**

| Question | Decision |
|---|---|
| Who may act from a screen? | **Whoever holds the display URL** (the token IS the write credential — no PIN, no login) |
| First batch | **PRINT + REPRINT** (assist actions exist but are switched off until an admin ticks them) |
| Print path | **BROWSER** — the screen's own printer (CT40 / local BRIDGE stay available, pluggable) |
| “All stations” | **Admin console**: one page for the whole fleet |

**Rule kept:** the UI stays in ONE language (English) — Arabic is forbidden in
UI and in new code (owner rule, commit `16409e6`).

**Status: delivered, built, tested and verified end-to-end** — 323 backend unit
tests, 171 frontend tests, **40/40 live API checks** against a real PostgreSQL
+ the built server.

---

## 1. What the owner gets

| # | Capability | Where |
|---|---|---|
| 1 | **Every station's screen is manageable from ONE page** — with AND without a display, online/offline/disabled, read-only vs interactive; bulk create “missing displays”, apply a profile, enable/disable all (kill switch), switch interactivity | `/admin/displays` (Admin → STATIONS → *Station Displays*) |
| 2 | **The screen acts for the station** — **PRINT / REPRINT** out of the box (the first batch); ACK / CALL SUPERVISOR / REPORT PROBLEM exist and are switched on per display | `/display/:token` action bar |
| 3 | **Printing from the screen** — a REAL job row with the rendered label payload, transport pluggable (BROWSER default, CT40 bridge or local BRIDGE), result reported back (PRINTED / FAILED) | `station_print_jobs` + `POST /display-views/:token/actions/print` |
| 4 | **The supervisor speaks to the station** — admin message (INFO/WARNING/URGENT) shown full-width on the screen with sound until someone taps SEEN | fleet row → *Message*, Stations → Display Mode panel |
| 5 | **Every action is recorded** — the display's own log (`station_display_actions`) + the audit trail (`DISPLAY_*`) + a merged live feed on the screen (SCAN / CARTON / BATCH / STORAGE / IN / OUT / **PRINT / ACK / HELP / EXCEPTION / MESSAGE**) | screen feed, fleet row → *Actions*, `/admin/audit` |
| 6 | **The screen helps instead of just reporting** — audible OK/NOK cue, message alarm, one-tap reason chips for a problem report, big touch targets | display page |
| 7 | **Control Center** now shows the display state of every station | `/admin` → Stations panel |
| 8 | **The screen shows EVERYTHING about the station** — the next action in plain words, what is still expected, what is wrong, the shift totals and how long the operation has been open | `/display/:token` (next-action band, expected queue, alerts strip, footer) |

## 2. Fixes shipped with it (found during the audit)

1. **The live feed was almost never instant.** `station.activity` was listened
   for but NEVER emitted, and receiving / temporary storage / putaway / batches
   emitted no events at all — every station screen was refreshed by the 3 s
   reconcile tick only. Now those writers emit through
   `common/station-activity.ts` (after commit, fire-and-forget, never inside a
   transaction), and the stream **coalesces** the pushes (~600 ms) so one write
   does not fan out into N snapshots.
2. **The SSE change-fingerprint included `lastUpdate`**, which is regenerated on
   every snapshot → the “skip if unchanged” optimisation could never fire and a
   full snapshot was re-sent every 3 s per screen even when idle. Fixed with
   `displayPushFingerprint()`.
3. **The admin could not switch the “recent actions” feed on**: `recent` was
   missing from `DISPLAY_FIELDS` in the Stations page (the backend supported it
   since the owner's «show ALL actions» request). Added — and `reports` is now
   visibly marked *reserved* instead of silently dead.
4. **Batch rows had no context**: `BATCH UNIT` / `BATCH RECEIVE` entries and the
   last-scan card now carry the batch customer (the display binds batch writes
   through the station's assigned worker — no hard-coded ids).
5. **The admin panel could lie about a switch.** It rendered a display's RAW
   stored config and treated “not `false`” as *on*, so a screen could show
   HELP / EXCEPTION as ticked while the server refused them. The station
   displays API now returns the **effective** config (defaults applied) and the
   switches render the server's truth.
6. **The last silent writers** — `workflow.acceptAtStaging` (a Temporary
   Storage station accepting a handoff) and `putaway` (session start / carton
   stored / session complete) now ping `station.activity` too, so those screens
   update on the write, not on the next tick. Pinned by new tests, including
   the order guarantee: **the ping is emitted AFTER the commit**.

## 2b. ASSIST LAYER — «show everything, help the worker» (same day, follow-up order)

The screen is no longer a mirror: it *tells the operator what to do next*. All of
it is computed **server-side** from the same rows the CT40 writes — the browser
never invents a step, and each block has its own visibility switch (so a hidden
block never leaves the API).

| Block | What it shows | Switch |
|---|---|---|
| **NEXT ACTION** | one imperative line + a detail line, with a colour per tone: `SCAN` (blue) / `ATTENTION` (red) / `READY TO FINISH` (green) / `WAITING` (amber) | `guidance` |
| **STILL EXPECTED** | the products/units still coming at this station (biggest gap first, code + name + «13 of 50 units left») | `queue` |
| **ALERTS** | every open discrepancy, every open exception at the station (including the ones raised from this very screen, with the real `EXC-######` code and severity) and an unanswered *call supervisor* — each with a **✓ SEEN** button when the display may ACK | `alerts` |
| **TODAY** | scans · units · cartons · stored · transfers out · screen actions | `stats` |
| **Handover** | «open 42m» next to the operation, so a second operator sees at a glance how long this station has been running it | `operation` |

The next step is decided by a **pure function** (`stationGuidance`), unit tested
row by row, in this priority order:

```
station not ACTIVE        → «This station is not active» (ask a supervisor)
receiving session open    → units left?      → «Scan the next product» + the queue
                            nothing left?    → discrepancy open? → «Resolve the open discrepancy»
                                             → else             → «Every expected product is complete»
                            no line yet      → «Start scanning this arrival»
batch open                → CREATED          → «Register the next unit» (x of y)
                          → receiving        → «Receive the next unit» / «This batch is complete»
temporary storage station → item in REVIEW?  → «A stored product needs review» (red)
                          → else             → «Scan the next product to store it» (last section shown)
open task                 → the task title
nothing open              → «Waiting for the next operation» (with the reason)
```

Alerts follow the same rule as everything else: an exception or a discrepancy
**stays on the screen until it is really closed**, while a *call supervisor* is
cleared by the station's own ✓ SEEN (the ACK action, already audited).

## 3. Contract (what code enforces)

```
READ  : display token → snapshot / SSE / health.   Always, while enabled.
ACT   : display token → /actions/*  ONLY IF  enabled
                                      AND config.interactive === true
                                      AND the single action switch is on
                                      AND under the per-display rate limit (30/min)
WRITE-REVOCATION: disable the display  or  regenerate its token  → read+write die
                                      in the same instant (verified live)
AUDIT : every action → AuditLog with action DISPLAY_* + displayId + stationId + display name
                      + station_display_actions (the station-stamped operational log)
```

* `interactive` defaults to **false**: a display is passive until an admin says
  otherwise, from the fleet console or the station panel. The switch is audited
  (`DISPLAY_UPDATED` carries `interactive`, `previousInteractive`, `actions`).
* **Default action set = PRINT + REPRINT** (+ the *message seen* confirmation of
  an admin message, which is not a station action). ACK / HELP / REPORT PROBLEM
  are one tick away per display; **station moves stay off** (next stage).
* The action bar is a rendering of the **server's** answer (`options.actions`
  in the snapshot) — the browser never decides what it may do.
* Print is refused when there is nothing to print (`NOTHING_TO_PRINT`), a job of
  another station can never be reprinted or resolved (`404`), an exception
  without a reason is refused (`400`), and a screen cannot hammer the API
  (`429`).
* A display that prints through the CT40/bridge falls back to the browser print
  window when the local bridge is unreachable **and says so** — a label is never
  silently lost.

## 4. Files

**Backend**
```
prisma/schema.prisma                                  + StationDisplayAction, StationPrintJob,
                                                        StationDisplayMessage, DISPLAY_* audit actions
prisma/migrations/20260916160000_station_display_interactive/migration.sql
src/bootstrap-schema-repair.ts                        additive/idempotent production repair for the above
src/common/station-activity.ts                        the station.activity ping helper (after commit)
src/modules/displays/displays.service.ts              config (interactive/sound/actions/transport), snapshot
                                                        additions (options, messages, merged feed), actions
                                                        (ack/help/exception/print/reprint/print-result/
                                                        print-queue/message-ack), rate limit, fleet, bulk
src/modules/displays/display-views.controller.ts      POST action routes (public, token-scoped)
src/modules/displays/displays-admin.controller.ts     fleet list, bulk, station action log, send message;
                                                        station list returns the EFFECTIVE config
src/modules/workflow/workflow.service.ts              station.activity on an accepted Temporary Storage intake
src/modules/putaway/putaway.service.ts                station.activity on session start / carton stored / complete
src/modules/receiving/*, batches, temporary-storage   emit station.activity after commit
src/modules/operations/operations.service.ts          per-station display state + fleet counters
```

**Frontend**
```
src/display/StationDisplay.tsx        action bar, dialogs, message banner, sound, toasts, screen-action feed lines
src/display/display-view.ts           types + availableActions / topMessage / soundCueFor
src/display/display-print.ts          label rendering + browser/bridge transports + result reporting
src/admin/pages/DisplaysFleet.tsx     the fleet console (new page)
src/admin/pages/Stations.tsx          display panel: recent switch, interactive + action switches,
                                      print transport, message box, link to the fleet
src/admin/pages/ControlCenter.tsx     display column per station
src/admin/api.ts, src/App.tsx, src/admin/AdminShell.tsx   API client, route, nav
```

**Tests / tools**
```
backend  src/modules/displays/displays.service.spec.ts       +17 stage-2 tests (35 in the file)
backend  src/modules/workflow/workflow.service.spec.ts       NEW — the emit contract (5 tests)
backend  src/modules/putaway/putaway.service.spec.ts         +the station ping (no-op stays silent)
frontend src/display/display-interactive.test.ts             11 tests (action bar, message, sound, label,
                                                              guidance tones, queue lines, handover age)
tools/station-display-smoke.py                               74 end-to-end checks on a live stack (49 v2 + 25 v3)
```

## 5. Verification (what was actually run)

* `backend`: `tsc --noEmit` clean, `eslint` clean, **348/348 jest tests pass** (333 at the v2 checkpoint)
  (30 suites; +10 for the assist layer, including the pure guidance function and
  the «hidden section never leaves the API» filter; the built server was also
  BOOTED — a DI/decorator-metadata crash only shows at boot, not in tsc or jest).
* `frontend`: `tsc --noEmit` clean, `eslint` clean, `vite build` OK, **186/186
  vitest tests pass**.
* **Live end-to-end on PostgreSQL 17 + the built server** (74/74 — the 9 new
  checks cover the assist layer: the NEXT ACTION matches the live operation, the
  expected queue carries code + units left, today's totals count the station's
  work, the handover age is exposed, a block switched OFF is absent from the
  payload, nothing alerts on a healthy station, an open exception AND an
  unanswered supervisor call both reach the screen with the real `EXC-` code and
  severity, and acknowledging clears the call while the real exception stays
  open):
  migrations applied from scratch → seed → admin login → create station →
  create display → snapshot read-only → every action refused (403) → admin
  switches interactive → **the default set is exactly PRINT + REPRINT** (and
  HELP is refused while its switch is off) → assist profile enabled → 
  `NOTHING_TO_PRINT` guard → a CT40-style transaction inserted → display
  mirrors the SAME id → print job with the same code → PRINTED result → reprint
  → ack → help → **real OperationalException row** → admin message → screen SEEN
  → action log → audit rows carrying the display identity → disabled display
  leaks nothing and refuses actions → regenerated token kills the old URL →
  fleet (with/without display, no token ever exposed) → bulk create/profile/
  kill-switch → rate limit 429 → a hammered screen does not lock the others.
  Reproduce with `python3 tools/station-display-smoke.py` (API + DB running).

## 6. How to try it (5 minutes)

```
cd backend  && npm run start:prod          # API on :3000
cd frontend && npm run dev                 # web on :5173 (proxies /api)
cd backend  && AYROVI_SEED_DEMO=true SEED_WORKER_PASSWORD='<local-demo-password>' npm run db:seed
```

1. Admin → **STATIONS → Station Displays** (`/admin/displays`): the fleet shows
   every station, including those **without** a display.
2. Click **Create the missing displays** → one screen per station, URLs are
   shown once per row (*Get URL*).
3. On “Receiving Dock 1 Display” tick **⚡ Interactive** and Save → open the
   screen URL on that machine. The screen shows a **PRINT** and a **REPRINT**
   button (the first batch); tick ACK / HELP / REPORT PROBLEM if you want the
   assist actions on that screen too. Above the action bar the screen always
   shows the **NEXT ACTION** band, the **STILL EXPECTED** list, the **ALERTS**
   strip and the **TODAY** totals (each switchable per display).
4. Put a real transaction at that station (CT40 / Receiving terminal, or the
   smoke tool) → the screen updates **on the write**, not on the next tick.
5. *Message* on the fleet row → the text appears full-width on the screen with
   a sound; the operator taps **SEEN** and it is recorded in the action log.
6. Every one of those actions is in `station_display_actions` + the audit trail
   with the display's name, and in the station's live feed on the screen itself.

## 7. Deliberately NOT in this batch

* **Station moves** from the screen (TS put / station IN-OUT). The switch
  exists (`actions.move`) and is **hard-off by default** — stock-moving writes
  from a wall screen deserve their own reviewed batch.
* **Assist actions on by default** — the owner's first batch is printing; ACK /
  HELP / REPORT PROBLEM are opt-in per display (the code and the endpoints are
  there, the default is off).
* **Wall mode** (one screen showing many stations in a grid).
  `StationDisplayType` is still the natural home for it (a separate token),
  untouched here.
* **Print transports beyond BROWSER as a default**: the CT40/bridge path is
  implemented and reachable per display, but the default stays the screen's own
  printer so no deployment depends on the handheld being in someone's hand.
* **Per-operator identity on a screen** (PIN / login). The owner chose the
  token model, so the action log and audit name the **display**, never a person.
  If a person-level trail is ever needed, that change is additive.

## 8. Operations notes

* To make a screen able to act: Admin → Station Displays → row → *Make
  interactive*, or tick ⚡ Interactive in Stations → Display Mode (then Save).
  Both are audited.
* To stop a screen immediately: *Disable* (read dies too) or *Get URL
  (regenerates)* — the old URL returns 404 for read and 403/404 for every action.
* The display URL is a write credential for the actions you enabled: keep
  interactive screens on trusted hardware, prefer disabling a screen over
  leaving it interactive on an unattended public wall.
* Labels: `station_print_jobs` is the source of truth (who asked, what code, how
  many copies, which transport, printed or failed). A bridge/CT40 agent claims
  QUEUED jobs with `GET /api/v1/display-views/:token/actions/print-queue` and
  reports with `POST .../actions/print/:jobId/result`.

---

## v3 follows this report — the screen set

This report describes the **interactive + assist** layer (v2). The next layer,
built the same day on the owner's order («display must not be one big screen —
think like Amazon warehouses»), turns each station into a **set of
single-purpose screens** (Board / Next Action / Andon / Print) with the role
enforced server-side and an andon colour on every screen, plus the handheld
print-agent API (`GET /print-jobs/pending`, `POST /print-jobs/:id/result`).
Design, decisions and execution status:
[`docs/STATION-DISPLAY-SCREEN-SET-PLAN.md`](STATION-DISPLAY-SCREEN-SET-PLAN.md).
