# COMMAND #3 — Worker Control / إدارة العمال — Final Delivery Report

**Date:** 2026-09-03 · **Status:** Shipped (backend + frontend), verified end-to-end on a local stack, migration safe for prod.
**Scope:** Admin Control Center → WORKFORCE → **Workers** page (evolved in place, not a new page).

---

## ملخص تنفيذي (Arabic)

- **البلوك = إيقاف مؤقت قابل للعكس**: الحساب يبقى سليماً (`LOCKED`)، لا يمكن للعامل تسجيل الدخول، والمشرف يمكنه فك الحظر في أي وقت.
- **الإزالة = فصل نهائي لكن ناعم**: الحساب يُعطَّل نهائياً (`DISABLED`) ويبقى مع كل سجلّاته وتاريخه للتدقيق — **لا حذف نهائي من قاعدة البيانات أبداً**.
- **مؤشّر الحضور بجانب كل عامل**: عمل اليوم؟ نعم/لا + وقت آخر نشاط اليوم، مع عدد الجلسات والمهام المفتوحة والحالة.
- **المهام المعيّنة**: يعيّن المشرف مهمة محددة لعامل محدد (مثل: استقبال وصول/طلب رقم X)؛ تظهر فوراً داخل تيرمينال ذلك العامل ويمكنه إقفالها «DONE» مع ملاحظة، وتعود إلى سجلّ الأدمن مثبتة باسمه.
- **إضافة عامل جديد** من نفس الصفحة + سجلّ مهام مركزى (Registry) بحالات OPEN / DONE / CANCELLED.
- كل عملية مقيّدة بالصلاحية `users.manage` على الخادم ومُسجَّلة في سجلّ التدقيق (Audit) بهوية المُنفِّذ.
- **لم تُمسّ أي بيانات إنتاج**؛ الهجرة آمنة، تلقائية، ومتوافقة مع نظام الإصلاح الذاتي عند الإقلاع.

---

## 1. What was delivered

### 1.1 Block / Unblock / Remove (the requested control over workers)

| Action | Terminal login | Reversible | DB row | Audit |
|---|---|---|---|---|
| **Block** | `ACTIVE → LOCKED` — login refused; live sessions revoked | ✅ Yes (Unblock → `ACTIVE`) | kept | `USER_STATUS_CHANGED` (BLOCK + reason) |
| **Unblock** | `LOCKED → ACTIVE` | — | kept | `USER_STATUS_CHANGED` (UNBLOCK) |
| **Remove** | `ACTIVE/LOCKED → DISABLED` — refused forever | ❌ No (final separation) | **kept, never deleted** (soft) | `USER_STATUS_CHANGED` (REMOVE + mandatory written reason) |

Rules enforced server-side (not only in the UI):

- Only **workers** can be managed from this surface — a `SUPER_ADMIN` account and your **own** account are protected and rejected with a clear error.
- **Remove** requires a written reason (≥ 2 chars) and automatically **cancels all OPEN assigned tasks** of that worker (`CANCELLED` + `cancelReason: "worker removed — <reason>"`).
- A blocked worker sees `Account is blocked by a manager — contact your supervisor.` on login; a removed one sees `Account is not active.`
- All transitions are audited with actor identity, IP, previous → new state, reason.

### 1.2 Presence — "does this worker work or not?"

Each row in the Workers list now answers, per worker and honestly from real data:

- **Status** (ACTIVE / BLOCKED / REMOVED) — blocked & removed workers **remain listed** so they can be unblocked or audited.
- **Worked today** — `YES · HH:MM` (time of last activity today) or `NO` (last activity on an earlier day) or `never`. "Worked" = any receiving **or putaway** session started today, or an operational activity timestamp later than local midnight.
- **Sessions today** = receiving + putaway session count.
- **Open tasks** = count of OPEN admin-assigned tasks for that worker.
- Active in-flight task (code), station, roles, join date.

### 1.3 Admin → worker task assignment ("writing/adding tasks for workers")

- Admin picks **one specific worker** and attaches a concrete task (title, optional instructions, optional reference type + code such as an arrival/order/container code).
- The task appears **in that worker's terminal** (top of the terminal home; the one-click auto-route to a single task waits until assigned tasks are loaded, so an assignment is never skipped).
- The worker marks it **DONE** (optional note) — the terminal posts `TASK_COMPLETED`, audited.
- The Admin **Assigned task registry** below the workers table shows OPEN / DONE / CANCELLED with worker, task, reference, creator, completion proof (`Done by <code>` + note), and lets an admin cancel an OPEN task.

### 1.4 Add a worker

`+ Add worker` on the same page creates an **ACTIVE** account with a chosen worker role (`INBOUND_WORKER`, `PICKER`, `PACKER`), audited `USER_CREATED`. (Assigning a station remains on the Stations screen.)

---

## 2. Backend changes

| File | Change |
|---|---|
| `backend/prisma/schema.prisma` | `enum AssignmentStatus { OPEN DONE CANCELLED }`; model `WorkerTaskAssignment` (table `worker_task_assignments`) with worker/creator/completer/canceller relations and indexes; `User` back-relations; no removal of existing fields/models. |
| `backend/prisma/migrations/20260903150000_admin_worker_control_tasks/migration.sql` | New guarded/idempotent migration (CREATE TYPE guarded, ADD VALUE IF NOT EXISTS ×3, CREATE TABLE IF NOT EXISTS, guarded FKs). |
| `backend/src/bootstrap-schema-repair.ts` | Same guarded DDL registered under ledger `20260903150000_admin_worker_control_tasks` for the in-process boot self-heal (covers the case where `start.sh` isn't the entrypoint). |
| `backend/src/modules/operations/operations.service.ts` | `workers()` now lists **all** non-back-office accounts regardless of status with presence/task fields; new `blockWorker / unblockWorker / removeWorker / workerTasksList / workerTaskCreate / workerTaskCancel` (+ session revocation, protected-account rules, OPEN-task cancellation on remove, audit). |
| `backend/src/modules/operations/operations.controller.ts` | `POST /workers/:id/block|unblock|remove`, `GET|POST /worker-tasks`, `POST /worker-tasks/:id/cancel` — all under `RequirePermissions('users.manage')`. |
| `backend/src/modules/operations/terminal.service.ts` | `myAssignments(userId)` and `completeAssignment(userId, id, note)` — strictly self-scoped to the authenticated worker. |
| `backend/src/modules/operations/operations.controller.ts` (TerminalController) | `GET /terminal/assignments`, `POST /terminal/assignments/:id/complete`. |
| `backend/src/modules/auth/auth.service.ts` | Distinct, honest login messages for `LOCKED` vs `DISABLED` (audit keeps `account_<status>`). |

## 3. Frontend changes

| File | Change |
|---|---|
| `frontend/src/admin/api.ts` | `WorkerRow` presence fields (`workedToday`, `lastActivityAt`, `pendingTasks`, `status`, `createdAt`), `WorkerTaskRow`, `WORKER_ROLE_OPTIONS`, and API methods for create/block/unblock/remove/tasks. |
| `frontend/src/admin/pages/Workers.tsx` | Evolved Workers page: presence columns, status tags, per-worker **+ task / block / unblock / remove** actions (only with `users.manage`), Add-worker modal, Assign-task modal, reason modals, and the live **Assigned task registry** with status filter + cancel. |
| `frontend/src/terminal/WorkerTerminalHome.tsx` | **ASSIGNED TASKS** block at the top of the terminal home with DONE buttons; auto-route to a single regular task waits for assigned tasks to load. |
| `frontend/src/terminal/api.ts` | `assignments()` + `completeAssignment()`. |
| CSS | `.wt-assigned*` (terminal) and admin helpers (`.ac-ok`, `.ac-linkbtn--danger`, `.ac-rowbtns`, `.os-grid2`). |

## 4. Acceptance evidence (local stack, real DB, Playwright)

Headless-Chromium acceptance against the local stack (`127.0.0.1`, real `ayrovi_warehouse` DB) — **14/14 checks passed**:

1. Workers list shows the new presence/status/tasks columns.
2. Admin assigned a concrete task to `WORKER001`.
3. Task appears **OPEN** in the admin registry immediately (live refresh).
4. Task surfaces in `WORKER001`'s terminal home (**ASSIGNED TASKS**).
5. Worker marked it **DONE** (terminal footer confirms `DONE — <title>`).
6. Registry reflects completion with proof (`Done by WORKER001`).
7. Admin **blocked** the worker → status BLOCKED.
8. Blocked worker **cannot sign in**: `Account is blocked by a manager — contact your supervisor.`
9. Admin **unblocked** → ACTIVE.
10. Worker can sign in again after unblock.
11. Admin **added** a new worker (`+ Add worker`, audited).
12. Admin **removed** that worker permanently (soft) with mandatory reason → status REMOVED.
13. Removed worker stays listed, tagged REMOVED (account kept).
14. Removed worker cannot sign in.

**Dev-DB trail after acceptance** (local only; production untouched): `worker_task_assignments` DONE×3 / CANCELLED×1; audit `USER_CREATED`×3, `USER_STATUS_CHANGED`×9 (block/unblock/remove cycles), `TASK_ASSIGNED`×4, `TASK_COMPLETED`×3, `TASK_CANCELLED`×1; `WORKER001` back to **ACTIVE**; `ADMIN001` untouched; QA workers left **DISABLED** (proof of soft removal).

Screenshots: `artifacts/wc-1-workers-list.png` … `artifacts/wc-10-final-workers.png`.

## 5. Production safety notes

- Migration is **additive and idempotent**; it will be applied by Render's release step (`start.sh` runs `prisma migrate deploy`) and re-guarded in-process by `bootstrap-schema-repair.ts`, so a partial application self-heals instead of crashing the boot.
- **No destructive DDL**; nothing is dropped or altered on existing tables.
- **No prod data touched** during this delivery; verification ran against the local DB only.
- Existing live accounts with **no role** (`1234`, `12345`, status ACTIVE) were already listed before this change (previous filter was status-only) and remain visible; they are not treated as back-office. If those two accounts should be treated differently, tell us and we will scope the next change.
- Assigning an OPEN task to a worker is allowed only while the worker is `ACTIVE`/`LOCKED`-eligible; a `DISABLED` worker must be reactivated first (server rejects with a clear message).

## 6. Pending operator security follow-ups (unchanged, repeat each delivery)

1. **Rotate `INITIAL_ADMIN_PASSWORD`** on Render (the value has been in play during this engagement).
2. **Revoke the Render API key** and the **one-shot GitHub PAT** used for deployments during this engagement.
