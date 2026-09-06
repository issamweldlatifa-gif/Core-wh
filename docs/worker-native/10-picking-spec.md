# 10 · Picking specification / contract gate

**Status: NOT IMPLEMENTED in the new native lane; BLOCKED pending backend contract and Receiving hardware acceptance.** No mock Picking screen, invented task queue or location exception has been added.

## Existing behavior versus requested behavior

Existing `fulfillment/order-sorting` resolves a scanned ArticleUnit to a customer order/bin and assigns it, under `picking.execute`. Its DTOs/repository methods and frozen UI remain useful for that operation. It is **not** a directed pick: there is no authoritative pick task/reservation → required location → product → outstanding quantity → confirmation contract. A PICKER role or `picking.view/execute` permission does not create missing task data.

## Required vertical after BC-06 approval

1. Server-owned assigned task with task ID/version, order/wave reference, priority, remaining lines and assignment/lease state. Queue count must come from real tasks.
2. Show mandatory warehouse/zone/location hierarchy and exact location code. Scan location; backend validates it against the task before enabling product capture.
3. Scan product/barcode; backend resolves permitted identity, lot/serial/expiry constraints if relevant, expected unit of measure and remaining reserved quantity.
4. Enter picked quantity using shared numeric controls. Server enforces positive whole/pack quantities, available/reserved stock, over/short-pick and concurrent changes. No client assumption that every SKU is quantity one or interchangeable.
5. Explicit confirm with stable operation identity and task version; atomically record picked units, source removal, destination tote and audit. Return authoritative remaining work.
6. Next product/location or server-confirmed task completion. A beep, assignment DONE or local line count cannot finish the pick.

## Exceptions and authorization

Wrong location/product stays blocked with expected/scanned/reason and rescan/back/pause actions. Missing, damaged, insufficient stock, alternate location, lot substitution and short pick require a backend-provided permitted action + reason policy. The UI must not offer “override” just because a user has a supervisory-looking role. Server enforcement must cover direct API calls, not only workflow ordering.

## Contract information required (no endpoint invented)

Document method/path/auth/application/permission, request/response schema, task version/ownership, scan resolution and identity rules, source/destination storage effects, quantity/UOM limits, cancellation/release behavior, exception capability/reasons, completion invariants, idempotency/payload binding and operation-result lookup. Decide reservation expiry, cross-worker takeover, duplicate serial handling, order cancellation and multi-device races. Approve these separately from the native client.

## Shared reuse and state

Reuse WorkerRepository/transport, WorkerSessionUseCase, scanner manager, connection/session guards, terminal components and safe mutation recovery pattern. New PickingUseCase/StateFlow holds interaction state only; no stock policy in Compose, no API/scanner copied from Receiving. Model task → location → product → quantity review → confirmation → next/result with PAUSED/RECONCILE states. Draft quantity/scan cancellation is safe offline; **pick mutation authorization remains UNKNOWN**, so stop offline.

## Acceptance / migration

Backend contract tests, task/stock/audit integration tests and worker/supervisor negative API matrix first. Then native state tests, real API/device walk-through, fast duplicate/wrong-location/short-pick/network-loss/task-cancellation tests. Demonstrate exactly-once physical effect via idempotency, not optimistic local counters. Keep existing order-sorting/Admin functions until replacement scope is explicitly approved. No legacy deletion based on this specification alone.
