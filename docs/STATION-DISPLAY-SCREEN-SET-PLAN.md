# Station Display v3 — a SET of single-purpose screens per station (plan + build)

**Owner order (2026-09-16, follow-up):** «a display must not be just ONE big
screen — think of displays that each show ONE action instead of everything on
one screen. Think like Amazon warehouses and large systems. Think of a strong
plan and execute it.»

**Axis of the change:** a station no longer has *a* screen. A station has a
**screen set** — several displays, each with a **role (view)**, each optimised
for one job, positioned where that job is done. This is how real warehouses
work: nobody reads a dashboard at the pick face — they read a light, a number or
one word.

---

## 1. What large operations actually do (and what we copy)

| Industrial pattern | What it is | What we build |
|---|---|---|
| **Andon board** | one screen per area showing ONLY the state of the line, colour-coded, readable from 30 m | `ALERTS` view: full-screen colour (GREEN/AMBER/RED) + the open problems + the supervisor call + how long it has been waiting |
| **Pick-to-light / put-to-light** | a light over the face says *one* thing: what to do now | `ACTION` view: ONE instruction, giant, with the tone colour. Nothing else on the screen |
| **Work queue board** | the operator sees what is coming, in order, not what happened | `QUEUE` view: the expected lines, biggest gap first, with per-line progress |
| **Label / print station** | printing has its own hardware and its own screen | `PRINT` view: the printable target + giant PRINT / REPRINT + the result of the last job |
| **Production board** | shift totals on the wall, for the supervisor, not the operator | `STATS` view: today's numbers, huge |
| **Aging / escalation** | a call or a blocked station *ages*: green → amber → red with time | server-side **andon state** with an age, shown on every screen and in the fleet console |

Two rules we keep from the existing design (they are what makes this safe):
1. **Server-side truth** — the view decides what the server *sends*, not what the
   browser *hides*: a screen that is not the board never receives the data it is
   not showing (the existing "hidden fields never leave the API" invariant).
2. **One credential per screen** — each screen in the set has its own token, so
   one screen can be disabled or regenerated without touching the others.

## 2. The model

```
Station ──< Display(view = BOARD | ACTION | QUEUE | ALERTS | PRINT | STATS)
              │
              ├─ config.view        the screen's role (default BOARD = today's behaviour)
              ├─ config.*           visibility switches (BOARD keeps them all configurable)
              └─ token              its own URL, its own revoke
```

* **Views are presets enforced server-side.** A role implies which blocks may
  leave the API (`ACTION` → guidance only; `ALERTS` → alerts + help; `PRINT` →
  nothing but the print target; …). The admin cannot accidentally configure an
  ACTION screen into a full board.
* **`BOARD` stays exactly as it is today** — same switches, same look, same
  tests. Nothing breaks; the other roles are additive.
* **Andon state** is computed from the same rows (open discrepancy, open
  exception, unanswered call, review-needed storage, station status, last scan
  age) into `{ state: OK | ATTENTION | PROBLEM | IDLE, code, since }` — the code
  only, never the free-text reason (which belongs to the alerts block), so the
  colour signal can never leak hidden data.

## 3. Screen sets (what a station actually gets)

`POST /stations/:id/displays/set` builds the standard set for a station in one
call and returns every URL once:

| Screen | View | Where it physically goes |
|---|---|---|
| `<Station> Board` | BOARD | office / supervisor wall, full context |
| `<Station> Next Action` | ACTION | operator eye-line, the one instruction |
| `<Station> Andon` | ALERTS | aisle wall, colour + problems + calls |
| `<Station> Print` | PRINT | next to the printer, print/reprint only |

The fleet console grows a **Create screen set** bulk action (one call for every
active station) and per-row view selection, so a whole warehouse can be equipped
in one click — the same way an andon rollout works.

## 4. Delivery order (this build)

1. Backend: `view` + server-side presets, andon state, snapshot `options.view`,
   fleet payload, screen-set endpoint + bulk, worker-targeted push for HELP /
   EXCEPTION (open item), station print-queue endpoints for the handheld agent
   (open item).
2. Frontend: the five views rendered as their own layouts + dispatch by
   `options.view`, admin view pickers, fleet andon dot.
3. CT40: a print agent that claims the station's queued jobs and prints them on
   the paired Bluetooth printer (the open item), built by CI.
4. Tests at every layer + `tools/station-display-smoke.py` extended to prove the
   per-view contract on a live stack.

---

## 5. Execution status (2026-09-16, same day — BUILT AND VERIFIED)

| Step | State | Evidence |
|---|---|---|
| 1. Backend — role + presets, andon, screen set, fleet, worker pushes, print queue | **done** | `displays.service.ts`: `DISPLAY_VIEWS`, `VIEW_PRESETS`, `VIEW_LABELS`, `STANDARD_SCREEN_SET`, `config.view`, `andonState()` (10 m → ATTENTION, 25 m → PROBLEM), `createScreenSet()`, `bulk CREATE_SET`, `pendingPrintJobsForWorker()`, `printJobResultForWorker()`, `notifyStationAudience()` |
| 2. Frontend — one layout per role + dispatch | **done** | new `frontend/src/display/StationViews.tsx` (ActionView / QueueView / AlertsView / PrintView / StatsView / AndonBar), `StationDisplay.tsx` dispatches on `options.view` and keeps BOARD untouched (`data-view` attribute for tests) |
| 3. Admin — pick the role, build the set | **done** | `Stations.tsx` role picker + explanation; `DisplaysFleet.tsx` per-row role chips, **+ Build set**, fleet-wide **+ Build the screen set** |
| 4. Tests | **done** | backend **348** jest (displays 52, +RBAC OR 8) · frontend **186** vitest (new `display-views.test.tsx` 11) · `tools/station-display-smoke.py` **74/74** on the live stack · tsc/eslint/vite build clean |
| 5. CT40 print agent (mobile code) | **written, awaiting a CI compile** | `worker-core/…/domain/PrintAgent.kt` (the agent contract: pending queue + report, no Android, no `@Serializable` so R8 needs no keep rules) · `app/…/printer/PrintAgentRunner.kt` (poll → print through the existing SPP link, duplicate-protected by the server job id → report) · wired into `PrintBridgeService` + a counter in the terminal settings · JVM tests in `PrintAgentTest` (core) and `PrintAgentRunnerTest` (app). This module cannot be compiled locally (Gradle TLS-blocked) — the Android workflow compiles it on push |

### Decisions taken while executing (recorded, not hidden)

1. **A role is enforced on the wire, not in the browser.** `filterSnapshotByConfig`
   drops the blocks a role must not have (`guidance`/`queue`/`stats`/`recent`/…);
   the smoke asserts the *absence of the key*, not an empty value.
2. **A partial config patch no longer demotes a screen.** `PATCH
   /station-displays/:id` with a config that does not mention `view` keeps the
   stored role (a physical screen does not change job because someone toggled a
   switch). An explicit `view` still moves it — that is the audited decision.
3. **The handheld print agent needed an OR permission.** It is ONE endpoint for
   six shop-floor jobs; requiring `receiving.execute` locked a batch/sorting/
   packing worker out of printing from their own CT40 (caught live: worker
   `WORKER006` → 403). Added `@RequireAnyPermission` (new decorator + guard
   branch + audit metadata `requiredAny`) and listed the six execution rights.
   Assignment (`Station.assignedWorkerId`) still decides which labels a worker
   can see, and tokenless display URLs are never used by the agent.
4. **`bulk CREATE_SET` accepts `views`** so an operator can roll out only some
   roles (e.g. Next Action + Andon first).
5. **Andon is the one block every role keeps** — a PRINT screen still turns red;
   it carries `{state, code, since}` only (no free text), so it cannot leak the
   alert reason to a role that is not allowed to show alerts.
6. **`STANDARD_SCREEN_SET` = Board / Next Action / Andon / Print.** QUEUE and
   STATS exist and are selectable per screen, but are not created automatically:
   a station normally has one board, one instruction, one colour and one printer
   screen.

### Live walkthrough state (local dev stack)

9 active stations × 4 screens = **36 display URLs** (`tools/demo_data.py` prints
them grouped by station and role; the script is idempotent — a second run
creates 0 screens). RECEIVING (`ST-REC-01`) additionally carries a live session
`RCV-000301` / `SA-4471` 13 of 50, a supervisor message and a printed label pair;
its Next Action **and** Print screens are interactive (all other screens stay
read-only, per the owner rule).

Smoke evidence, verbatim: `=== 74/74 checks passed ===`

### The print path end-to-end (open item — now complete on the API side)

```
screen  ──► POST /display-views/:token/actions/print       (job QUEUED, transport from the screen's config)
                │
                ├── transport BROWSER  → the screen prints it itself (window.print)  → reports PRINTED/FAILED
                └── transport CT40     → the label waits in the queue
                                             │
       handheld (CT40 app) ── GET  /print-jobs/pending ─┘   (WORKER_NATIVE, worker's own stations)
                            ──► printer.print(jobId, label)  (TSPL, SPP to the paired PM-241-BT)
                            ──► POST /print-jobs/:id/result {PRINTED|FAILED}
```

Nothing about the queue can be driven by the handheld itself (it has no create
right), the display token never travels to the phone, and a label is only marked
PRINTED after every requested copy physically left the printer.
