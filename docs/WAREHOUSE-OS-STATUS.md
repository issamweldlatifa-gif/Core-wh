# WAREHOUSE OS — implementation status

Last updated: 2026-09-01 · local HEAD `putaway`

## Commits (local, not yet pushed)

```
(new)    feat(putaway): stowing workflow, append-only placement ledger
7596b1f  docs: WAREHOUSE OS status, verification and env recovery
e099bc6  feat(os): station-linked sessions + route-level code splitting
bbe3b0f  feat(os): Worker Terminal + Admin Control Center (phase 2 frontend)
2168f16  fix: continuous camera scanner, structure 500s, terminal logout   <- last pushed
```

`origin` is intentionally **not** configured, so no credential is stored in
`.git/config`. To push:

```bash
git remote add origin https://github.com/issamweldlatifa-gif/Core-wh.git
git push origin master
```

> The personal access token that was pasted into the chat is compromised and
> must be revoked: GitHub → Settings → Developer settings → Personal access
> tokens. Use a fresh token, or better, an SSH key.

---

## What is implemented

### Worker Terminal — `/terminal` (§3–§5, §11–§31)

| File | Role |
|---|---|
| `frontend/src/terminal/WorkerShell.tsx` | Identity strip, full-bleed work area, status footer, logout |
| `frontend/src/terminal/WorkerTerminalHome.tsx` | §3 task picker; a single ready task opens directly |
| `frontend/src/terminal/ReceivingTask.tsx` | Receiving workspace driving the continuous scanner |
| `frontend/src/terminal/api.ts` | `terminalApi.context()`, `stationHas()` |

Input convergence (§11): camera, hardware wedge scanner and keyboard all funnel
through one `submitCode()`. Keystroke timing distinguishes a scanner burst from
human typing. **Nothing is shown as RECEIVED until the backend accepts it** (§25).

### Scanner subsystem (§16–§31)

`frontend/src/modules/receiving-terminal/`

- `ContinuousScanner.tsx` — stays open across scans; native `BarcodeDetector`
  with a ZXing fallback; decodes only the ROI; duplicate guard (2.5 s window);
  full teardown on EXIT (tracks stopped, rAF cancelled, OCR worker terminated).
- `ocr-client.ts` — Tesseract.js **on-device only**, loaded via dynamic
  `import()`; frames are dropped rather than queued while busy.
- `candidates.ts` — generic candidate regexes + sliding-window stabiliser.
  No single SKU format is hardcoded; the regex is only a filter.
- `roi.ts`, `scanner-state.ts` — ROI geometry/preprocessing, 11-state machine.

### Putaway / stowing — `/terminal/putaway`

Moves RECEIVED cartons onto real storage locations, closing the schema's own
D-46 gap ("currentLocationId stays NULL until Stowing").

| File | Role |
|---|---|
| `backend/src/modules/putaway/putaway.service.ts` | Validation + append-only placement ledger |
| `backend/src/modules/putaway/putaway.controller.ts` | `/v1/putaway/*`, guarded by `stowing.view` / `stowing.execute` |
| `frontend/src/terminal/PutawayTask.tsx` | Two-step worker screen (carton → location) |
| `frontend/src/terminal/putaway-api.ts` | Typed client |

Design decisions:

- **Append-only history.** Moving a carton does not rewrite its placement row;
  it sets `releasedAt` on the old one and appends a new one, so "where was this
  carton last Tuesday" stays answerable.
- **Re-scanning the same location is a no-op** — no duplicate ledger row and no
  misleading audit entry.
- A carton that was never received cannot be stowed; an INACTIVE/BLOCKED
  location cannot receive stock. Both return a readable rejection instead of a
  500, so the scanner can stay open.
- `Location` deletion is `Restrict` while it holds stock; the station link is
  `SetNull` so history survives.

### Admin Control Center — `/admin` (§6, §36–§40)

`frontend/src/admin/` — `AdminShell.tsx` plus `pages/`: `ControlCenter`,
`Workers` (list + drill-down), `SessionDetail`, `Stations`, `Exceptions`,
`Corrections`, and the shared `CorrectionDialog`.

Every correction goes through `CorrectionDialog`, which enforces a reason and
shows the original state before confirming.

### Backend (§7–§10, §41)

`backend/src/modules/operations/` — operations / stations / terminal
controllers and services, `corrections.service.ts`.

`OperationCorrection` is **append-only**: `COR-NNNNNN`, reason ≥ 8 chars,
`adminId`, `ipAddress`, immutable `originalSnapshot` / `newSnapshot`.
Reversal sets `ReceivingCarton.status = 'REVERSED'` and returns the warehouse
carton to `EXPECTED` — nothing is ever deleted (§8).

`ReceivingSession.stationId` is a real FK to `Station` with `ON DELETE SET NULL`,
and the station is resolved **server-side** from the worker's active assignment
rather than trusted from the client.

---

## Verification performed

Security matrix (backend-enforced, §9/§41/§46):

| Endpoint | Worker | Admin |
|---|---|---|
| `GET operations/overview` · `workers` · `exceptions` · `corrections` | 403 | 200 |
| `GET stations` · `terminal/context` · `receiving/arrivals` | 200 | 200 |
| `POST corrections/*` (all four) | 403 | 200 |
| no token / bad token | 401 | 401 |

Other checks:

- §48 loop: worker login → auto-routed to receiving → session → receive by SKU
  → unknown code correctly **rejected** (`UNKNOWN_CARTON`, not auto-received)
  → exception raised → worker **blocked** from self-closing → admin resolves
  (`COR-000004`) → worker completes → admin reopens (`COR-000005`).
- Station FK: deleting a station nulls the link and **preserves** the session.
- Reason < 8 chars → 400.
- **29/29** backend Jest tests pass (10 new putaway unit tests covering the
  append-only invariants); `tsc --noEmit` clean on both sides.
- Putaway loop verified live: queue → start → reject unknown carton / unknown
  location / blocked location → place → re-scan same location is a no-op →
  move appends a second row and closes the first → admin overview shows the
  live session.
- A user with no operational permissions gets 403 on every putaway route and
  an empty task list — never routed into `/admin`.
- Bundle: 750 kB → **272 kB** (214 → 85 kB gzipped) after code splitting.

---

## Local environment recovery

The sandbox drops `node_modules`, installed system packages, **empty
directories**, and Postgres binaries between sessions. Full recovery:

```bash
# 1. Postgres 17 binaries (data in /home/user/pgdata survives)
sudo apt-get install -y --no-install-recommends postgresql-17 postgresql-client-17
export PATH=$PATH:/usr/lib/postgresql/17/bin

# 2. Recreate the empty dirs the snapshot drops, then start
cd /home/user/pgdata && mkdir -p pg_tblspc pg_replslot pg_twophase pg_snapshots \
  pg_commit_ts pg_serial pg_logical/snapshots pg_logical/mappings pg_stat \
  pg_stat_tmp pg_notify pg_dynshmem pg_wal/archive_status pg_subtrans \
  pg_multixact/members pg_multixact/offsets
chmod -R 0700 /home/user/pgdata && rm -f /home/user/pgdata/postmaster.pid
pg_ctl -D /home/user/pgdata -l /tmp/pg.log -o "-h 127.0.0.1 -p 5432 -k /tmp/pgsock" start

# 3. Dependencies
cd /home/user/Core-wh/backend && npm install
cd /home/user/Core-wh/frontend && npm install

# 4. API (:3000) — note the socket dir flag above; /var/run/postgresql is not writable
cd /home/user/Core-wh/backend
DATABASE_URL='postgresql://ayrovi:ayrovi_dev@127.0.0.1:5432/ayrovi_7cc76cf?schema=public' \
JWT_SECRET='dev_jwt_secret_local_only_change_me_32chars' \
WAREHOUSE_INTEGRATION_API_KEY='dev_integration_key_local' PORT=3000 node dist/main

# 5. Frontend (:5173, proxies /api -> :3000)
cd /home/user/Core-wh/frontend && npm run dev -- --host 0.0.0.0 --port 5173
```

Logins: `ADMIN001` / `ChangeMe!2024` · `WORKER001` / `Worker!2024`

### Gotchas that cost time before

- A stale `node dist/main` keeps :3000 bound and serves 404 for new routes —
  `pkill -f "node dist/main"` before restarting.
- `npx tsc` pulls an unrelated `tsc@2.0.4`; use `./node_modules/.bin/tsc`.
  Global `npx prisma` is v7; use `backend/node_modules/.bin/prisma`.
- Correction route is `corrections/correct-quantity` (not `/quantity`).
- Login DTO fields are `identifier` / `secret`.
- CRM integration needs nested `event` / `arrival` envelopes; the product field
  is `product_name`, not `productName`. Auth header is
  `x-api-key: $WAREHOUSE_INTEGRATION_API_KEY`.
- Session detail has no `totals` key — progress is `tally`, last event `flash`.
- `backend/.env` is untracked and points at an older DB; pass `DATABASE_URL`
  inline.

---

## Not yet done

- **Sorting** (`/terminal/sorting`) is still marked `ready: false` in the task
  registry. Deliberate: the spec does not define a sorting workflow precisely
  enough to implement without inventing business rules, and the standing
  instruction is to skip spec parts that are not sound. It needs a decision on
  what sorting actually produces (sort to zone? to carrier? to order?) before
  it can be built.
- `/admin` nav links for Arrivals / Structure / Users / Roles / Audit / Settings
  redirect to the pre-existing pages rather than being re-skinned into the
  Control Center theme. This was deliberate: those pages work, and the standing
  instruction is not to rebuild working functionality.
- Push to GitHub (blocked on credentials — see top).
