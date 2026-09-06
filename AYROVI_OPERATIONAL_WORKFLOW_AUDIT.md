# AYROVI operational workflow audit

Date: 2026-09-06 · audited source: `e11339b` · branch: `arena/01a073df-core-wh`.

**Produced before changing production code for this request.** The interrupted preceding turn inspected source only; it did not implement the full chain. [FACT] The currently verified native app is Receiving-only with Phone/CT40 presentations, not a production-validated warehouse chain.

## 1. Current architecture

[FACT] NestJS10/Prisma5/PostgreSQL modular monolith (`backend/`), React18/TypeScript/Vite Admin and web terminal (`frontend/`), Kotlin/Compose native Worker (`mobile/`). Global JWT/permission/application guards and AuditService exist. Native repositories, secure session/journal, device detection, scanner/feedback, Phone/CT40 rendering and CI are reusable. No second Worker architecture or Admin redesign is needed.

[FACT] Source owners: `backend/prisma/schema.prisma`; `modules/{receiving,fulfillment,operations,putaway,auth,devices}`; `frontend/src/admin/{api.ts,pages/*}`; native worker-core/presentation/scanner modules. Old receiving audits are historical context, not runtime certification.

## 2. Existing models

| Concept | Source/model | Finding |
|---|---|---|
| Worker/role/permission | User, Role, UserRole, Permission, RolePermission | [FACT] Real identity and live role permissions. Employee code is not authority. |
| Auth/device | Session, Device | [FACT] Device/station bindings stored on sessions; registry managed by Admin. [PARTIAL] Refresh hash/atomic consumption and subject/device checks require hardening. |
| Station/zone/location | Station; Warehouse→Zone→Aisle→Rack→Level→Location | [FACT] Existing physical entities and active states. [MISSING] Operational station-zone/container-location configuration and task-routing rule validation. |
| Task type/workflow | TerminalService.TASK_REGISTRY | [CONFLICT] Registry entries are modules, not task instances. `readyTaskCount` is not workload. |
| Task instance/assignment | WorkerTaskAssignment | [PARTIAL] Concrete manual instruction, workerId required, OPEN/DONE/CANCELLED; no stage/entity FKs, station/device/version, orchestration, automatic hand-off or validated physical completion. |
| Arrival/cartons | ExpectedArrival/ExpectedArrivalItem, WarehouseShipment/WarehouseCarton | [FACT] Real CRM projections, barcodes/QR and expected quantities. Arrival customer is an inbound projection; no separate customer master. |
| Product/order | Product, WarehouseOrder, OrderItem | [FACT] Product identity is store+externalProductCode; orders reference external customer. [CONFLICT] SKU-only order selection can lose store/customer provenance. |
| Physical units | PhysicalItem and ArticleUnit | [CONFLICT] PhysicalItem belongs to earlier order identity; current fulfillment uses ArticleUnit. Do not create a third physical product ledger. |
| Container | OperationalContainer | [FACT] RECEIVING/CUSTOMER, capacity default50 in DB/config; actual contents via ArticleUnit.containerId. [MISSING] Capacity enforcement/automatic rollover, placement purpose/location/close rules and assignment. |
| Outbound | OutboundShipment | [FACT] Internal OUT code, order/container/articles, READY_TO_SHIP/SHIPPED. [MISSING] Verified shipping token/state binding, immutable document/printable bordereau, duplicate-pack uniqueness and full assignment context. |
| Issue/correction/audit | ReceivingDiscrepancy, OperationCorrection, AuditLog | [FACT] Receiving exception and audited correction mechanisms. [MISSING] Task-wide issue lifecycle/severity/owner/entity linking across all stages. |

## 3. Existing APIs

[FACT] `/api/v1/auth/*`, `/terminal/context`, `/terminal/assignments` provide identity/native context and manual instructions. `/stations/*`, `/devices/*`, `/operations/worker-tasks`, `/operations/tasks`, `/operations/exceptions`, `/operations/corrections/*` are existing Admin surfaces.

[FACT] Receiving: GET arrivals/active/session; POST start/scan-carton/receive-carton/receive-product/pause/resume/flag/resolve/complete. `scan-carton` identifies; `receive-carton` commits. Existing article endpoint is POST `/fulfillment/receiving/sessions/:id/scan-article` with `{sku,containerCode,cartonCode?}`. It creates one ArticleUnit; totals-only receive-product creates no physical article.

[FACT] Fulfillment: containers; sorting article lookup/store; order-sorting article lookup/assign; packing lookup/pack; shipping lookup/ship; outbound/article Admin search/trace. Services and underlying records must be reused, not copied into mobile.

[FACT] Putaway is carton→storage-location placement, not the requested product→capacity-managed staging container operation. [CONFLICT] Calling it Product Placement without reconciling that difference would be false parity.

## 4. Existing states

- [FACT] Assignment: OPEN, DONE, CANCELLED. Reuse OPEN for available/assigned, DONE for completed; add only needed IN_PROGRESS/BLOCKED semantics rather than parallel CREATED/READY/COMPLETED synonyms.
- [FACT] ReceivingSession: RECEIVING, PAUSED, COMPLETED, COMPLETED_WITH_DISCREPANCY, CANCELLED. Arrival: EXPECTED/RECEIVING/PAUSED/RECEIVED/RECEIVED_WITH_DISCREPANCY/CANCELLED.
- [FACT] Containers: ACTIVE, READY_FOR_PACKING, PACKED, CLOSED, VOIDED. FULL is currently derived from content count/capacity.
- [CONFLICT] CLOSED currently means released/finished; it must not silently also mean a sealed tote waiting for sorting. Use explicit sorting-ready state/close metadata if needed, retaining existing downstream states.
- [FACT] ArticleUnit: RECEIVED, IN_CONTAINER, STORED, IN_CUSTOMER_BIN, PACKED, SHIPPED, VOIDED. Outbound: READY_TO_SHIP, SHIPPED. Reuse these records/states.
- [FACT] Receiving discrepancy: OPEN, RESOLVED, REJECTED. [MISSING] General issue acknowledgement/progress/resolution across tasks.

## 5. Existing Worker system

[FACT] One native ReceivingWorkflow, ReceivingViewModel, safe source/tote review, explicit one-unit receipt, durable unconfirmed marker and confirmed-result acknowledgement. Phone/CT40 renderers differ; no duplicated native ReceivingStation/ToteStation remains. Sorting/Putaway tiles are disabled in the new app. [MISSING] Real assigned task selection and downstream native task execution.

## 6. Existing Station system

[FACT] Station has department/status, assigned worker, optional warehouse, free-form deviceId and hardware capabilities. Admin assignment releases another station assigned to the same worker. [PARTIAL] Assignment change is not one transaction. [MISSING] Verified stage routing, zone/location/capacity linkage and device FK-based eligibility. A worker must not post arbitrary station/worker ownership as authority.

## 7. Existing Task system

[CONFLICT] Manual WorkerTaskAssignment completion only verifies self-ownership and OPEN→DONE; it does not validate a physical operation. [MISSING] Auto-generation of next-stage task, natural uniqueness, replay-safe completion, assignment load/eligibility, shift handover and task completion snapshots.

[RECOMMENDATION] Extend WorkerTaskAssignment additively into typed operational instances, retaining `taskType=null` manual instructions. Typed completion must be routed through backend domain validation, never generic mark-done. Current assignee/station/device are assignment data; history belongs in existing audit/corrections. A workflow is the coordinator over existing arrival/order/container entities, not another inventory database.

## 8. Existing scanner/device architecture

[FACT] Reuse HoneywellScanner manufacturer/model detector (PHONE fallback), Honeywell Data Collection Intent API, DataWedge, ScannerService/ScannerManager, CameraX/ML Kit, common feedback/audio and native design system. [UNKNOWN] Actual CT40 model/firmware/profile, audible feedback and physical50+ scan performance have not been certified. No hardware is attached to this workspace. Do not replace working detection/scan engines.

## 9. Gaps against the requested chain

[MISSING] Receiving completion does not automatically assign Placement. Placement has no capacity-managed auto-container operation. Sorting has no assignment/customer-card task lock. Packing does not validate configured shipping-out location. Shipping can be posted without a prior verification bound to actor/version/contents. No complete task-wide issue/transition/completion ledger connects Admin and subsequent workers.

[PARTIAL] Admin already has Workers, Stations, Tasks, ReceivingContainers, CustomerBins, Exceptions, OutboundShipments, Traceability and live views. Extend these views/API rather than redesigning Admin.

[FACT] Counter-based code generation and pre-transaction reads in fulfillment are race-prone. Article receipt has no operation ID and does not enforce tote capacity or source-carton membership. Completion can race scans; generic old mutation paths must not bypass task ownership, locks or customer matching.

## 10. Conflicts/security/release findings

[CONFLICT] Bare SKU identifies a product kind, not one unique physical item. Network idempotency can be enforced with operation IDs; detecting deliberate re-scan of the same physical unit requires a serial/unique unit identifier or a documented operator procedure. Do not claim SKU-only physical deduplication.

[CONFLICT] Existing category sorting/storage and customer order sorting are different stages. Preserve authoritative category/store/customer rules; do not guess an order by display name.

[FACT] Audit exists but station/device/task/previous-next state are not consistently populated. Events are emitted inside transactions in fulfillment; publish only after commit. Admin LiveBoard has a baseline AuthContext.token type error; SSE currently exposes query-token handling. Address relevant integration defects without unrelated Admin restyling.

[FACT] `render.yaml` declares one web service `ayrovi-warehouse-core` and PostgreSQL database `ayrovi-warehouse-db`, autoDeploy=true, health path `/api/v1/system/health`, but **does not specify the deployed branch/service ID**. Native compatibility API root differs (`core-wh.onrender.com/api`). [UNKNOWN] Actual linked Render services/branch/deployed commit/health/backup are not proven by this file.

[FACT] Session branch is fixed to `arena/01a073df-core-wh`. No master push or production branch switch is authorized by this session. Release is currently unsigned; only debug QA APK artifacts exist. [MISSING] Managed release signing identity and approved direct APK distribution target. No Render/signing/database credentials are available in the workspace environment; do not request secrets in chat.

## 11. Missing components / decisions

[MISSING] Approved real worker/role/station/zone/device routing, configured capacities, shipping-out destinations, task expiry/shift takeover policy, physical unit identification rule, carrier/bordereau requirements, staging/production endpoints and service IDs, signing/MDM distribution, migration backup/restore proof, CT40/Phone testers and pilot/go-live approval. Record these in AYROVI_PILOT_CONFIGURATION_REQUIRED.md; do not seed fake production data.

## 12. Implementation plan and gates

1. Preserve this audit. Reconcile typed tasks with existing assignments/statuses and extend models additively with FKs, unique constraints, audit/idempotency metadata and explicit configuration.
2. Build a transactional task/operation coordination boundary. Reuse ReceivingService/FulfillmentService writers via an explicit unit of work; no duplicate stock calculations or hidden nested transaction gaps.
3. Complete server eligibility/assignment/source/quantity/capacity/customer/lock/shipping-verification rules and atomic next-task creation. Reuse existing entities and state names; document any extension.
4. Expose assigned worker tasks and backend-directed actions; extend the existing Admin task/issue/shipping views minimally. Reuse native authentication, scanner, detection and two presenters.
5. Isolated PostgreSQL test scenario: one arrival,3 cartons,54+ uniquely tracked test units, multiple stores/SKUs/customer orders, configured capacity50 plus early close, five operational workers/stations/devices. Drive transitions through APIs only; no DB updates to move work. Test replay/races/negative permissions and completion locking.
6. Run lint/typecheck/build/unit/database integration/native UI tests; record measured results, root causes and failures in AYROVI_END_TO_END_VALIDATION_REPORT.md. Hardening is limited to actual findings.
7. Produce readiness/recovery/pilot/go-live reports. **Do not advance to production/Pilot/Render deployment if critical gates, real configuration, signing or hardware evidence are missing.** Missing prerequisites mean BLOCKED/NO-GO, not synthetic success.
8. Final release must identify actual Git commit/push, Render service+commit+health and a real signed install link. A repository blueprint, debug artifact or HTTP200 alone is not proof of a matching healthy deployment.

## 13. Remote-default-branch addendum (audited before integration)

[FACT] During release checks, remote `master` was found ahead of the session baseline at `144a075e9ae614f3ec015668844d9c8e60d2fa3f`. It contains the already merged Worker Operational Model (`8a4619d`, migration fix `af39cf1`) and public-health guard fix (`442f937`). This supersedes several baseline MISSING findings above. Integration must stay on this session's branch; no work/push to master.

[FACT] Reuse `AssignmentsService`, `WorkPolicyService`, shared `task-registry.ts`, operational WorkerTaskAssignment FKs/statuses (ASSIGNED/IN_PROGRESS/COMPLETED/COMPLETED_WITH_DISCREPANCY/BLOCKED/CANCELLED), ReceivingScanEvent ledger, READY_FOR_SORTING capacity/manual close, putaway claims, Admin assignment UI and dispatch-note print. Do NOT build a duplicate task engine/model.

[PARTIAL] Native changes upstream target the old monolithic UI/API location. Keep the current Phone/CT40 presentations, shared repository/scanner and encrypted journal; port only contract changes (operationId, container close/capacity, assignment counts) into the existing shared core.

[CONFLICT] Upstream `completeAssignment` claims instruction-only but allows linked operational tasks and BLOCKED rows to complete manually. Workflow sync updates all entity-linked assignments, including other workers/BLOCKED tasks, and callers swallow errors after the inventory transaction. These are release blockers, not proof of completed task reliability.

[PARTIAL] The new scan ledger is session-scoped on replay but not payload-bound, and article replay returns no original ArticleUnit identity. Capacity checks/close and several completion checks still read before transactions. Upstream sync completes existing assignments; it does not implement the entire configured Receiving→Placement→Customer Sorting→Packing→Shipping automatic assignment chain.

[MISSING] A distinct, configured product-placement-to-container stage, full customer-card completion lock, complete stage-wide issue lifecycle, shipping verification binding and real-world pilot/release sign-off remain. Upstream claims are source documentation, not a substitute for execution evidence.

[RECOMMENDATION] Integrate the already-approved upstream model first, reconcile conflicts without restoring old native Receiving logic, then validate/fix the actual security/data-integrity findings. Preserve absent owner/configuration/release prerequisites as explicit BLOCKED/NO-GO rather than inventing workers/rules or bypassing release signing/deployment verification.

## 14. Implementation/validation checkpoint

[FACT] Approved upstream model was merged into the fixed session branch, keeping native shared-core Phone/CT40 code. No second assignment engine was created. Fixes target the actual completion bypass/actor scoping/transaction synchronization, auth refresh identity/hash/CAS, health status, seed/boot safety, live Admin authentication and native operationId/capacity/count compatibility.

[FACT] Production demo seeding is now forbidden; explicit test/demo mode is required outside production and credentials are not printed. Existing admin credentials are not reset/elevated by seed. Boot no longer runs automatic migration ledger/db-push repairs or silently ignores schema failures. No production data was deleted as a cleanup shortcut.

[PARTIAL] The isolated90-unit PostgreSQL/HTTP stock path passed. [MISSING] Automatic Placement handoff/next-container routing/full downstream native/verified shipping remain blockers. [UNKNOWN] Render actual service binding/deployed commit/logs/health and signed Release distribution. Final outcome is NOT READY; see the named validation/readiness/pilot/go-live/release reports.
