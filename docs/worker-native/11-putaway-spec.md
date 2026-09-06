# 11 · Putaway specification / strict-location gate

**Status: AUDITED, NOT MIGRATED.** Existing web/carton Putaway and native article sorting/storage remain frozen. No new visual-only Putaway lane. Receiving hardware acceptance comes first.

## What exists

- `putaway` endpoints: queue/session/container/product/location flow, `stowing.view/execute`; see [03](03-api-contracts.md) for exact methods and payloads.
- `fulfillment/sorting/articles/:code` plus sorting store: article destination suggestions and direct storage.
- Worker task registry has `putaway`; the frozen native route mapping does not fully implement it.
- Destination suggestion is **not identical to destination authorization**. Source review found validation gaps: suggested-location membership is not a universal enforcement rule and article direct-store can admit unresolved mapping. Mark these **REQUIRES BACKEND VERIFICATION/FIX**, not behavior to copy into a new client.

## Required operational vertical

Assigned real putaway task → scan article/carton/product → receive authoritative destination recommendation and quantity/UOM → display exact location plus hierarchy → scan destination → backend validates destination and current task/stock → confirm physical placement → server returns stored quantity/article identities and next task.

The location instruction and scanned location must remain simultaneously understandable. Use shared LocationBlock/Code/Hierarchy, ProductBlock, ScanZone, QuantityDisplay, ProgressIndicator and terminal actions. Do not build a consumer map/dashboard. Same scanner source/duplicate policy as Receiving.

## Backend decisions before implementation

1. Which stock unit moves: carton, individually tracked ArticleUnit, or bounded quantity? Explicit source and target, no duplicate representation updates.
2. Destination rules: assignment to store/customer/zone, ACTIVE state, hierarchy, stock compatibility, capacity, quarantine/damage restrictions and reservation conflicts.
3. Does a suggestion represent the only permitted location or one of several? Return an explicit validated capability/version, not a client guess based on a display list.
4. Exception actions for unavailable/full/wrong/inactive location, alternate destination and task takeover. Require actual permission, reason, actor and audit; revalidate in the storage transaction.
5. Atomic/idempotent move with payload-bound operationId/result lookup, conflict response and no partial stock placement after a retry.
6. Session/owner state, pause/resume, partial placement, cancellation and completion reconciliation; multi-device/concurrent quantity handling.

These are BC-02/04/06 items, not silent endpoint changes. Existing APIs remain intact until approved backend changes are separately tested/deployed.

## Error and connection policy

Wrong scanned location cannot advance. Show expected/permitted destination, scanned code and server refusal; offer only rescan, authorized alternative, exception or pause capabilities actually returned/enforced. Product identity/destination changes require a fresh lookup. Do not cache a previous item's location as authority.

Draft edits and scan cancellation may remain local; placement requires server authorization. No current stock move is queued/replayed offline. Response loss must query authoritative operation/move state; totals or “location looks occupied” are not proof of which article moved. Block repetition if uncertain.

## Required tests and retirement gate

Real suggested/permitted and forbidden locations, unrelated warehouse/zone, inactive/full location, missing mapping, stale recommendation, capacity race, wrong product, duplicate article, mixed tote/carton, quantities/UOM, supervisor authority revoked mid-task, process/background interruption, lost POST response and recovery. Assert DB source removal/target presence/ArticleUnit status/audit/receipt reconciliation remain consistent.

Reuse shared core/components only after the Receiving device gate; implement one real Putaway use case and then validate on target scanners. Preserve existing backend/Admin stock and sorting functions until dependency/use is proved obsolete and removal approved. No retirement authorized by this document.
