# 04 · Business logic extraction map

**Backend owns warehouse truth.** Kotlin owns interaction sequencing, state presentation and transport safety—not a copy of server arithmetic. The frozen web/native UI is evidence, not a specification.

| Rule / transition | Actual authority | Extraction / native use |
|---|---|---|
| Login → app allowed → registered device when supplied | `AuthService.login`, application-access kernel | One auth repository; app=WORKER_NATIVE, device identity. Never derive permission from employee code, station label or barcode. |
| Current roles and session validity | `JwtStrategy`, global guards | Revalidate on foreground and final API 401/403; task visibility comes from context AND permissions. |
| Assigned task OPEN→DONE | `TerminalService.completeAssignment` | Self-scoped server operation; not automatically marked done when Receiving completes. |
| Expected quantity/source data immutable | `ReceivingService.start`, expected-arrivals integration | Display expected/received/remaining returned by server; do not mutate expected locally. |
| Carton identity | `ReceivingService.scanCarton` | Send exact trimmed scan. Identify only; a confirmation is a separate use-case command. |
| Carton acceptance | `ReceivingService.receiveCarton` | Success only after returned RECEIVED event. Keep scanned source and operation ID distinct from identity scan. |
| Unknown/wrong/duplicate carton | same services + flash union | Distinct operational messages. Unknown/wrong already write exceptions; no silent second flag or false acceptance. |
| Product identity | receiving product line SKU and `FulfillmentService.scanArticleAtReceiving` | Fresh session data supplies review context. Exact SKU match only; no fuzzy OCR/case change treated as a valid identity. Local preview is not server acceptance. |
| Physical article/tote receipt | `FulfillmentService.scanArticleAtReceiving` | One request = one ArticleUnit. Always select a real ACTIVE RECEIVING tote. Do not call both totals-only and article APIs for the same physical item. |
| Quantities | server reconciliation | Show server totals. Baseline article API supports only one unit; a typed bulk count must **not** become a loop with partial success. BC-01 blocks bulk native acceptance. |
| Unexpected/overage products | server receipts/discrepancies | Unexpected article is physically recorded, not rejected. UI must explicitly distinguish “received with exception” from rejected. No invented max-expected denial/approval rule. |
| Pause/resume | receiving lifecycle endpoints | Only server state changes workflow. Scanner inactive while paused/backgrounded/submitting/awaiting confirmation. Require resume before new native receipt even though baseline helper is permissive. |
| Complete arrival | `ReceivingService.complete/reconcile` | Backend decides exact match vs discrepancy close. No local success because counts visually match. Resolution action shown only with actual permission. |
| Exception vs rejection | `flag`, `resolveDiscrepancy`; no rejection endpoint | Report a reason through existing flag only; label it an exception. Do not claim restock/reject/quarantine. |
| Putaway location/status | `PutawayService.place`, Fulfillment sorting | Keep existing fallback; native strict-location migration blocked pending BC-06. Do not copy advisory destination into a client-side security rule. |
| Order sorting | `findOrderNeeding`, `orderSortingAssign` | Preserve original operation, not relabel as a pick task. Requires authoritative order/bin. |
| Packing completeness | backend order completeness check | No client arithmetic for stock or order ownership; printer integration separate and unverified. |
| Shipping | backend `ship` | Server dispatches, closes container, retains history. Carrier null means no carrier integration. |
| Inventory / return transitions | **MISSING** | Only specifications, no fake mutation implementation. |

## Invalid logic deliberately not extracted into the new lane

1. CARTON_IDENTIFIED = received: **INVALID**, no backend mutation yet.
2. Receiving session `ACTIVE`: **INVALID**, actual enum RECEIVING.
3. Totals-only API `operationId` implies idempotency: **INVALID**, ignored.
4. Loop `scan-article` N times as one bulk receipt: **INVALID / REQUIRES BACKEND VERIFICATION**; partial outcomes cannot be safely replayed.
5. Native tote selects first active session across arrivals: **INVALID** workflow association; use authenticated context or explicit arrival selection.
6. Number of successful beeps = “today's operations”: **INVALID**; not backend count.
7. OCR score/uppercase normalization = known product: **INVALID**. Capture is not authorization.
8. No connection exception = no assigned tasks: **INVALID**. Present loading/connection errors distinctly.
9. Client `OfflineQueue` = authorized offline receipt: **INVALID**, no server sync protocol exists.
10. Advisory carton category destination = authorized override: **INVALID / REQUIRES BACKEND VERIFICATION**.
11. Quantity ≤0 coerced to1: **INVALID input handling** for a terminal; request explicit correction rather than changing worker intent.

## Extraction boundaries

```
Compose (render + intents only)
  → ViewModel (Android lifecycle)
    → ReceivingWorkflow (StateFlow; ordered interaction commands)
      → ReceivingGateway / WorkerRepository (one endpoint implementation)
        → authenticated transport + secure SessionStorage
          → existing AYROVI NestJS services / PostgreSQL

Camera / Honeywell / DataWedge / manual
  → one ScannerManager / ScanCoordinator
    → source-aware ScanResult
      → ReceivingWorkflow (no business rules inside scanner)
```

## Offline classification (deny by default)

| Operation | Classification | Implemented behavior |
|---|---|---|
| Edit an unsubmitted code/reason, scanner feedback, cancel preview | SAFE OFFLINE | In-memory draft only; never “received”. Passwords excluded from saved state. |
| View previously loaded session | REQUIRES SERVER for freshness | May remain visible, clearly OFFLINE/stale; cannot confirm work from it. |
| Start/resume/pause/complete, carton receipt, article receipt, exceptions | REQUIRES SERVER AUTHORIZATION | No offline submit queue. Losing response blocks further mutations until reconciliation. |
| Refresh roles/session/task assignment | REQUIRES SERVER AUTHORIZATION | Do not invent cached authorization. |
| Barcode normalization and duplicate detection | SAFE OFFLINE | Capture-only, no stock effects. |
| Future offline counts/returns/picks | UNKNOWN — BACKEND VERIFICATION REQUIRED | Disabled; no endpoint or permission assumed. |

Local duplicate suppression is not network idempotency. An ambiguous write needs server reconciliation; an offline queue must wait for approved idempotency, identity scoping, expiry and conflict policy.
