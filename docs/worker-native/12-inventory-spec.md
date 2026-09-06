# 12 · Inventory count specification / missing contract

**Status: BLOCKED / NOT IMPLEMENTED.** Existing inventory/structure administration and stock viewing are not an operational count/recount workflow. No fabricated count task or blind-count option is exposed.

## Required real workflow

Server assignment → identify permitted warehouse/location → scan and validate location → scan/count authorized stock identities → review count (expected quantity only when allowed) → report missing/unexpected/damaged stock with reason → submit count → server records variance/recount requirement → authorized reconciliation/adjustment → completion.

Count, recount and stock adjustment are distinct records/actions. A worker must not silently edit warehouse stock by submitting a UI quantity. One shared app/core/scanner; InventoryUseCase only after backend and Receiving acceptance gates.

## Backend contract required under BC-06

- Count task ID/version, assignment scope, lifecycle, location/stock snapshot policy and concurrency/stock-movement cut-off.
- Blind versus visible count as **server authorization**. A blind task must not send expected quantities/variance to a client that is prohibited from seeing them. Hiding a field in Compose is insufficient.
- Item identity model (SKU/article/lot/serial), UOM/pack rules, non-negative count semantics including explicit zero, overflow limits and repeated scans versus quantity entry.
- Missing item, unexpected item, damaged/held item and unscannable label reporting; typed/manual identification rules and disposition authority.
- Immutable initial count, recount actor independence, thresholds/review capability, variance response visibility, authorized stock adjustment transaction and audit trail.
- Atomic submission/idempotency, task-version conflict, operation lookup, partial task recovery and multi-worker takeover/cancellation.

Do not infer `inventory.manage` permits blind counts, approves variance, adjusts quarantine stock or grants an offline lease. Map actual permissions/capabilities once approved; no invented endpoint names in production code.

## Native state/design and offline behavior

Task → location scan → product count → review → submission result/recount → completion, with PAUSED/RECONCILE. Shared location/product/quantity/scan/status/error components, large numeric targets and explicit expected/scanned/reason. Preserve 0 as a valid count only when the approved count contract says so; Receiving's positive receipt rule is not copied blindly.

Draft quantity/edit/cancel is SAFE OFFLINE. Count submission/recount/adjustment authority is **UNKNOWN—BACKEND VERIFICATION REQUIRED**, so no offline outbox is enabled. An eventual offline count protocol requires signed/scoped lease, source snapshot/version, conflict policy, per-operation idempotency and encrypted lifecycle-managed storage. No claimed synchronization before those exist.

## Acceptance evidence

Authorized visible/blind assignments; API response does not leak hidden expected stock; location mismatch; count 0/large/negative/overflow; duplicate serialized unit; multiple identical-SKU units; missing/unexpected/damaged reporting; stock moved during count; independent recount; variance approval denial; actor/task changes; auth expiry; response lost after submission; audit and stock adjustment exactly once.

Backend/DB tests plus role-negative requests, native core tests, real hardware and controlled pilot are mandatory. Preserve Admin inventory/warehouse structure and current stock APIs. This missing workflow is a **production cutover blocker**, not a reason to remove working inventory administration.
