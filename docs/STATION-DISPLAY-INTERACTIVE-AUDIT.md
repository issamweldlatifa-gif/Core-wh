# Station Display Mode — Interactive Assist & Control · Audit + Design

> **STATUS (2026-09-16, same day): the audit below was answered by the owner and
> the build is DELIVERED.**
> Decisions: **whoever holds the display URL may act** (opt-in per display, the
> token is the write credential) · **first batch = PRINT + REPRINT** (ack / help /
> report problem exist but are switched OFF by default) · **print transport =
> BROWSER** (CT40 / local bridge remain pluggable) · **fleet = admin console**.
> See [`STATION-DISPLAY-V2-INTERACTIVE-REPORT.md`](STATION-DISPLAY-V2-INTERACTIVE-REPORT.md)
> for what was implemented, the fixes shipped with it (live-feed events, SSE
> fingerprint, missing `recent` switch, batch context, effective config in the
> admin panel, putaway/workflow pings) and the live verification results
> (**40/40** end-to-end checks). Everything below stays as the record of what
> existed before that build.

**Status:** audit of the delivered Display Mode + proposal for the next stage.
**Scope owner order:** «the display must help the worker, show and record every
action, and let us control / trigger actions (e.g. print) from it — for **all**
stations».
**Rule respected:** UI stays in ONE language (English) — Arabic is forbidden in
UI and in new code (owner rule, commit `16409e6`).

Part 1 is what exists **today, verified in code**. Part 2 is what is missing or
broken. Part 3 is the proposed design (contract, permission model, action
catalog). Part 4 is the phased plan. Part 5 is the decision list that needs an
owner answer before code is written.

---

## 1. What exists today (verified)

| Layer | Delivered | Where |
|---|---|---|
| Schema | `StationDisplay` (stationId, name, enabled, `displayType` default `LIVE_STATION`, 256-bit `accessToken` unique, `config` JSON, `lastSeenAt`) | `backend/prisma/schema.prisma:2393` |
| Public read API | `GET /display-views/:token` (snapshot), `/:token/stream` (SSE), `/:token/health` — `@Public()`, **no write route at all** | `backend/src/modules/displays/display-views.controller.ts` |
| Admin API | `GET/POST /stations/:stationId/displays`, `PATCH/DELETE /station-displays/:id`, `POST /:id/regenerate` — `stations.view` / `stations.manage`, audit-logged (`DISPLAY_CREATED`, `DISPLAY_UPDATED`, `DISPLAY_ENABLED/DISABLED`, `DISPLAY_ACCESS_REGENERATED`, `DISPLAY_STATION_CHANGED`, `DISPLAY_DELETED`) | `displays-admin.controller.ts`, `displays.service.ts:75-195` |
| Snapshot builder | Reads the SAME tables the CT40 writes (receiving session + scan events + cartons + discrepancies, TS items, task assignment, worker-bound batch units/receives, `ProductStationMove` IN/OUT) | `displays.service.ts:243-584` |
| Server-side visibility | 12 switches (`worker, operation, task, lastScan, product, customer, quantity, status, progress, station, recent, reports`) filtered **before** the payload leaves the API | `filterSnapshotByConfig` |
| Display page | `/display/:token` — full-screen read-only board, 5 states (`DISABLED/IDLE/PROCESSING/SUCCESS/ERROR`), last-scan hero + recent-action feed + progress bar + FULLSCREEN button, native `EventSource` + 10 s poll fallback | `frontend/src/display/StationDisplay.tsx`, `display-view.ts` |
| Admin panel | Per-station "Display Mode" panel: create / copy URL / open / enable / disable / regenerate / delete / per-field checkboxes | `frontend/src/admin/pages/Stations.tsx:35-170` |
| Mobile/other | Printer = Bluetooth SPP **local to the CT40**, lifecycle only is reported to `POST /printers/audit`; there is **no print-job table and no server-side print path** | `devices/printers.controller.ts` |

**Invariant that must survive this stage:** the display token is a *read*
credential. It carries no admin authority and no worker authority, and hidden
fields never reach the browser. Anything that writes must arrive on a
*different* credential — never by widening the public token.

---

## 2. Gaps found (what to fix / what to add)

### 2.1 Live-ness bugs (fix first — they are cheap and visible)

1. **The SSE "instant" topics almost never fire.** `INSTANT_TOPICS` listens for
   `scan.accepted / scan.rejected / bin.ready / packed / shipped /
   exception.opened / station.activity`, but only
   `fulfillment.service.ts` (picking/packing/shipping) emits any of them.
   Receiving, temporary storage, putaway and batches emit **nothing**, and no
   code emits `station.activity` at all. Consequence: a receiving/batch station
   display is only refreshed by the 3 s reconcile tick, not by the write.
2. **The change fingerprint includes `lastUpdate`**, which is regenerated on
   every snapshot (`displays.service.ts:213`) → the tick's "skip if unchanged"
   optimisation can never fire: the server re-sends a full snapshot every 3 s
   per screen even when nothing happened.
3. **The admin panel cannot toggle the `recent` feed**: `DISPLAY_FIELDS` in
   `Stations.tsx:13-25` omits `recent`, although the backend supports it and the
   owner asked for it (the "all actions" feed). `reports` is shown but is dead
   in v1 (no `reports` section is ever produced) — either remove it or make it
   real.
4. **Batch rows carry no product/customer**: `BATCH UNIT` / `BATCH RECEIVE`
   entries are built with `productName: null, customerName: null` — the operator
   sees a code with no context.
5. **No audio / no attention cue.** Nothing beeps or flashes on a new accepted
   or rejected scan — on a wall screen across the aisle the worker cannot notice
   a result without staring at it.

### 2.2 Worker-assist gaps (what the display does not do yet)

6. **It reports, it does not guide.** No "next action" instruction, no queue of
   what is expected next (next product / next unit / remaining units), no
   "waiting for X" guidance, no shift/assignment context (task start, ETA).
7. **Nothing addresses the worker.** The screen is passive; there is no
   operator → display channel: call the workstation, show a message ("come to
   gate 2", "stop scanning, supervisor coming"), ask for a confirmation, or
   raise an alert that the screen makes loud/visible.
8. **No acknowledgement trail.** An exception/error on the screen is shown but
   never *seen*: nobody records that the human at the station acknowledged it.
9. **No handover/context for a second person**: nothing shows "who is on this
   station since when" (worker + device + session age) — the fields exist in the
   DB, `worker` shows only code/name.

### 2.3 Action / control gaps (the owner's core request)

10. **Zero write endpoints.** `/display-views` has only three GETs. There is no
    way to trigger *any* action from a display: no print, no reprint, no
    exception raise/resolve, no TS move, no station IN/OUT, no task confirm, no
    "call supervisor".
11. **Print is not reachable from a screen.** The physical link is Bluetooth on
    the CT40; the display is a browser. Three legitimate paths exist (browser
    print on the display PC / broker a job to the worker's CT40 / local bridge
    agent on the display PC) and **none of them is implemented, chosen or
    documented** — there is no `PrintJob` model, no print queue, no label
    template server-side.
12. **No station-level "control" surface at all**: enable/disable a station's
    operation, take a station out of service, reassign a worker, clear a blocked
    task — all of that is admin-web-only and per-station.

### 2.4 Fleet ("all stations") gaps

13. **No fleet view.** Displays are managed one station at a time
    (`Stations.tsx`); there is no list of every display across the warehouse, no
    "which station has no display / is offline / is stale" board, no bulk create
    ("one display per active station"), no bulk enable/disable, no standard
    config profile ("apply these switches everywhere").
14. **No multi-station / rotating view.** A big screen in the office can only
    show ONE station, and only if you already hold its token.
15. The admin Control Center already draws a station table
    (`ControlCenter.tsx:210-234`) but carries **no display columns** (has
    display / online / last seen).

### 2.5 Security & hygiene

16. The display token travels in the **URL path** into every access log
    (`docker/nginx.conf` logs it by default) — a token in a log is a read
    credential in a log. Cheap hardening: log-format suppression for
    `/display/`, or move the token out of the path for the API calls.
17. `snapshotForToken` returns `{enabled:false}` with the display **name** only —
    good; but there is no rate limit on the public snapshot route, so a token
    holder can hammer the DB (each snapshot = ~10 queries across 5 s of data).
18. No data retention/cap on the 24 h window: the snapshot's `recent` fan-out
    (`take: 12` × 7 sources) is fine, but the 20-session `take` and the day
    boundary are hard-coded — should become config.

---

## 3. Proposed design — "Station Display v2: Assist + Control"

### 3.1 Layering (keeps the read-only invariant intact)

```
READ  (today)  public token  →  snapshot / SSE        ← unchanged, no writes
ACT   (new)    display-scoped operator session        ← PIN/password on the screen,
               + permission keys + station scope        TTL-bound, revocable
FLEET (new)    admin web (ADMIN_WEB + stations.*)     ← create/configure/monitor all
```

* The public token stays read-only **forever**.
* An action needs: an **enabled display**, `config.interactive = true`, a **live
  operator session bound to that display's station**, and the matching
  **permission key**.
* Every action is audited with `displayId + stationId + actorUserId`, and emits
  a domain event so every other screen/admin board updates instantly.
* Actions are idempotent where the operation is (reprint, re-ack) and refuse
  when the station's current operation makes them meaningless (e.g. no
  `reprint` if there is no last printed label).

### 3.2 New permission keys (reserved-then-real, same pattern as the repo)

```
display.operate      # unlock/act on any display of the operator's scope
display.print        # print / reprint a label from a display
display.assist       # raise exception, call supervisor, message, acknowledge
display.station_move # TS put / station IN-OUT from a display
```

Worker-class roles get `display.operate + display.assist` on their own station;
supervisor gets all four; viewer gets none (screen stays read-only for them).

### 3.3 Action catalog (each one = existing service call, never a new truth)

| # | Action | Backend it reuses | Permission | Audit event |
|---|---|---|---|---|
| A1 | **Print label** (last scan / carton / batch unit) | `PrintJob` (new, thin) → browser print or CT40 bridge | `display.print` | `DISPLAY_PRINT_REQUESTED` / `PRINT_FAILED` |
| A2 | **Reprint** (same payload, marked REPRINT) | A1 | `display.print` | `DISPLAY_REPRINT` |
| A3 | **Acknowledge alert** (seen by human at station) | new `DisplayAction` row | `display.operate` | `DISPLAY_ALERT_ACK` |
| A4 | **Raise exception** (blocked, damaged, missing, wrong item) | `OperationalException` (existing) | `display.assist` | `EXCEPTION_OPENED` |
| A5 | **Call supervisor / help** | audit + push to supervisor devices | `display.assist` | `DISPLAY_HELP_REQUESTED` |
| A6 | **Operator message → worker** (admin writes, worker screen shows + beeps) | new `DisplayMessage` | `display.assist` | `DISPLAY_MESSAGE_SENT` |
| A7 | **Confirm / next** (validate the highlighted step) | the same service the terminal uses | `display.operate` | existing op event |
| A8 | **TS put / transfer IN-OUT** | `ProductStationMove`, `temporary-storage.service` | `display.station_move` | existing move events |
| A9 | **Take station out of service / pause** | `stations.service` status | `stations.manage` | `STATION_STATUS_CHANGED` |

Rules: the display never creates a parallel record — it calls the exact same
service the CT40/terminal calls, so ids, audit and reports stay canonical.

### 3.4 Fleet console (all stations)

* New admin page **Stations → Displays (fleet)**: one row per station with
  `has display / enabled / last seen / interactive / config profile`, columns in
  the existing Control Center station table, and bulk actions:
  * "Create a display for every active station that has none"
  * "Apply profile to all" (visibility switches + interactive on/off)
  * "Disable all" / "Enable all" (kill switch), each audit-logged once with the
    affected ids as metadata.
* New endpoint: `GET /station-displays` (fleet list, no tokens — tokens stay
  manage-only, per the existing rule) + `POST /station-displays/bulk`.
* Optional **wall mode**: `/display-wall/:token` renders N stations in a grid
  with rotation. Its token is a *separate* credential (`StationDisplayType`
  already exists for exactly this reason).

### 3.5 Display-side UX (assist)

* Big **NEXT ACTION** band (instruction string produced server-side from the
  same workflow state).
* Audio cue + colour flash on `OK / NOK` (config `sound`, muteable per display).
* "Waiting for…" idle state that names the missing input (arrival not started,
  no task assigned, paused session) instead of a generic `WAITING FOR NEXT
  OPERATION`.
* Action bar (only rendered when unlocked): `PRINT`, `REPRINT`, `HELP`,
  `EXCEPTION`, `ACK`, and per-department extras (TS move, station move).
* Operator unlock: numeric keypad on the screen (PIN), 15-minute idle lock,
  visible "unlocked as <name> until HH:MM" banner so nobody acts anonymously.

---

## 4. Phased plan (each phase ships and is testable alone)

| Phase | Content | Risk | Notes |
|---|---|---|---|
| **P0 — Fix live-ness** | emit real events from receiving / TS / putaway / batches (`station.activity`), exclude `lastUpdate` from the fingerprint, add `recent` to the admin switches, drop or implement `reports`, enrich batch rows | none (read path) | half a day; immediately visible on every screen |
| **P1 — Fleet console** | fleet list endpoint + page + bulk create/apply/disable + display columns in Control Center | low | answers "include all stations" |
| **P2 — Operator session + audit skeleton** | unlock keypad, `display.operate`, action log, ack action | medium (first write path) | the security boundary of the whole stage |
| **P3 — Print from the display** | print path decision (see §5), label templates, `PrintJob`, reprint | medium | needs hardware answer |
| **P4 — Assist actions** | exception, help, operator→worker message, sound | low-medium | reuses existing services |
| **P5 — Station moves / control** | TS put, station IN-OUT, station pause/out-of-service | medium | needs `stations.manage` scope check |
| **P6 — Wall mode** | multi-station grid + rotation + separate token type | low | optional |

---

## 5. Open decisions (need an owner answer before code)

1. **Who may trigger an action from a display?**
   (a) supervisor/worker signs in with PIN on the screen (recommended: keeps the
   read-only token intact, gives a real audit actor);
   (b) whoever holds the display URL may act (fast, but the URL becomes a write
   credential — breaks the current invariant);
   (c) nobody at the station — only the admin web can act remotely.
2. **Which actions land in the first build?** print/reprint only; print +
   assist (help, exception, message); or the full catalog of §3.3.
3. **Print path:** (a) browser print dialog on the display PC (works with any
   Windows printer, needs a click) / silent kiosk printing; (b) route the job to
   the CT40's Bluetooth printer through the worker app (needs a push channel);
   (c) a small local bridge agent on the display PC (like the existing CT40
   bridge).
4. **"All stations" scope:** admin fleet console only, or also a multi-station
   wall screen (P6) in the same delivery.
