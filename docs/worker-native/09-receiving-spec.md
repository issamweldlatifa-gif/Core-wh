# 09 · Receiving vertical specification and pilot limits

**Status:** native implementation + automated test sources delivered. **Not a fully accepted production workflow.** Real-backend/device execution and formal condition/rejection/bulk contracts remain gates. Read [15](15-testing-report.md) and [16](16-hardware-test-report.md) for evidence, not UI appearance.

## Entry and operational questions

Home shows only server-authorized work, real arrival queue size and own instructions. Select Receiving → recover the backend's open session or scan/select an actual arrival. Each state answers: task/arrival, station/source/tote, required scan, server result, next allowed action. No counter is incremented for a beep or HTTP dispatch.

Architecture: `ReceivingScreen → ReceivingViewModel → ReceivingWorkflow → ReceivingGateway/WorkerRepository → actual AYROVI API`. Shared `TerminalScanInput` and design-system components only. No per-screen API implementation or independent scanner.

## v1.4.1 · One-tap Carton / Produit modes

One shared `ReceivingWorkflow`, repository and scanner, **not two workflows/APIs/apps**. Modes are interaction intents, not backend permissions.

- **Carton (default):** arrival → scan/identify carton → explicit receipt confirmation → next carton. This does not receive product units or alter expected quantities.
- **Produit:** switches to the article lane. A required source carton must have an actual server RECEIVED event; an identified-but-unconfirmed carton stays on confirmation. An ACTIVE RECEIVING tote is required and a reused tote is re-read on mode entry. The existing one-article confirmation/acknowledgement policy remains.
- A mode change cannot dismiss an unresolved mutation or confirmed receipt awaiting acknowledgement, bypass pause/completion/offline/auth checks, or authorize a stock action. It sends no stock POST.
- Switching away from a product review discards only its unsubmitted draft. Confirmed source and tote context are distinct from the current carton preview. Missing/removed source events force verification rather than inferring acceptance from totals.
- Back navigation is in the header; task actions are grouped in a scanner-suspending menu. One scanner host stays mounted across operational steps, rather than recreating hardware adapters for each phase.

The state table below describes the shared product lane; in Carton mode confirmation returns directly to CARTON. API requests/schema/permissions are unchanged. No bulk, condition/rejection, offline replay or backend authorization is invented by these mode buttons.

## Guided state machine

| State / instruction | Input and backend action | Advance condition / feedback |
|---|---|---|
| ARRIVAL / scan arrival | Internal AYROVI arrival code or server queue selection. GET active; POST start only if none. | Real RECEIVING/PAUSED session returned. Unknown/closed arrival remains blocked with reason. |
| CARTON / scan source carton | Shared barcode/QR/manual scan → `scan-carton` with actual source. | `CARTON_IDENTIFIED` is a preview only. UNKNOWN/WRONG_SHIPMENT is not success. |
| CONFIRM_CARTON / verify carton | Explicit physical confirmation → `receive-carton`. | Matching RECEIVED event required. Event cartonId is external code. A previously received carton may be selected as source without counting it again. |
| TOTE / scan receiving tote | GET real container by code. | Must be RECEIVING + ACTIVE. Invalid type/status stays on this step; no stock POST. Tote provisioning stays in existing authorized tools. |
| PRODUCT / scan product | Exact SKU → fresh session read and preview. | Preserve case/identity. A reference is not silently substituted for a SKU. Preview is not receipt. |
| REVIEW_PRODUCT / verify unit | Product, expected/remaining server quantities, destination tote, quantity input, condition limitation. | One physical unit only. Empty/zero/negative/fraction/overflow/bulk values cannot dispatch. Explicit `CONFIRM 1 ARTICLE` required. |
| RESULT / next action | Real `scan-article` response must identify an ArticleUnit and recognized result. | ARTICLE_RECEIVED or UNEXPECTED_ARTICLE. Unexpected can mean physically received with discrepancy, **not rejected**. The server result is durably retained; explicit acknowledgement/next unit re-arms same-SKU scanning deliberately. |
| REVIEW_COMPLETE / review arrival | Fresh server tally and open exceptions. | Worker with variance cannot complete without resolution permission. Backend rechecks on POST complete. |
| COMPLETE | Backend COMPLETED / COMPLETED_WITH_DISCREPANCY; CANCELLED separately identified. | Show recorded outcome; next arrival reloads server queue. Never equate cancellation with successful receipt. |
| PAUSED | Explicit pause; no scan mutation while paused. | Explicit online resume; reload context and re-scan source/tote. Backend's permissive paused helper is not copied. |
| RECONCILE | Persistent unresolved operation or storage failure. | No replay or local “dismiss and receive again.” Only authoritative reconciliation; see below. |

When no expected cartons exist in the server tally, the existing API permits a tote-first session. That is not a new provenance rule; source-carton policy remains BC-02/04.

## Quantity, condition and exception scope

The existing ArticleUnit endpoint accepts **only `{sku, containerCode, cartonCode?}`**, one unit per request. It has no quantity, source, operationId, condition or rejection fields. The old totals-only `receive-product` endpoint is deprecated in the shared repository and is never combined with article creation in this lane.

- Bulk receipt is blocked, not implemented as a client N-request loop.
- Product condition is a stated contract limitation, not a fake saved field. A worker may report a real exception reason through `flag` if authorized.
- Reporting does not reject stock, approve damaged stock, quarantine, restock or establish a formal condition record. Follow the warehouse's approved hold/escalation procedure; the app does not invent one.
- A qualified resolution action uses the real discrepancy endpoint and actual reason. No automatic “Resolved” approval.
- The complete requested condition→accept/reject/disposition flow is **BLOCKED by BC-03**. Physical pilot approval must explicitly restrict scope; it cannot waive missing production functionality by renaming this complete.

## Error and recovery behavior

Expected/scanned codes and backend reasons must remain readable, including wrong shipment, unknown carton, unusable tote, unexpected product, quantity refusal and missing permissions. Decoder success is separate from server confirmation. Empty queue is distinct from a failed queue request. Required tally/product quantities are decoded defensively; missing data is not zero stock.

The synchronous busy guard is set before coroutine scheduling. A second scan/tap cannot enqueue a second write. HTTP redirects/automatic connection retries are disabled. Only a definite pre-execution unauthorized request can be refreshed/repeated once; lost mutation responses, 5xx, unrecognized success or interrupted storage commit remain uncertain.

An encrypted marker is committed **before** mutation dispatch. There is no serialized request body/outbox or replay worker. After response loss/process death:

- Carton receipt: match the server's received event, not an optimistic counter.
- Start/pause/resume/resolve/complete: read recorded lifecycle/exception state, never blindly repeat.
- Article receipt or flag: aggregate counts cannot identify that operation. Hold device/work, supervisor reconciles the physical unit and closes the server session; then reload. BC-01 should provide a reliable operation lookup.
- Another worker cannot disclose/overwrite the previous worker's marker. Escalate through the controlled device-recovery procedure; no client role bypass or silent data clear.
- After a confirmed receipt, persist its ArticleUnit/tote evidence before rendering success. A later GET failure or process interruption retains the recorded unit for explicit operator acknowledgement, without a new success beep or POST. Refresh and acknowledge physical placement before the next item.

## Acceptance scenarios

Happy path with real printed labels/tote; existing active session; duplicate/previously received carton; wrong shipment; unknown/damaged label; exact versus case-different SKU/reference; unexpected SKU; long product/SKU; quantities 0, negative, decimal, 1, 2 and overflow; incomplete/variance completion with worker versus authorized supervisor; pause/resume; rapid different/same codes; no network before/after POST; process kill before dispatch/after dispatch/after response; auth expiry during review/receipt; logout and worker change; session changed/closed by another operator.

Required evidence includes API/DB ArticleUnit + tote + reconciliation + audit consistency, stock counted once, real hardware triggers, role-negative requests and supervisor reconciliation. Unit fixtures are not that evidence. Do not proceed to new Picking/Putaway/Inventory/Returns screens before this gate.

## v1.5 · One core, two device-specific presentations

Phone and CT40 now render the same ReceivingPresentation and dispatch identical ReceivingIntent commands. Phone prioritizes software scan (the existing real camera engine), then camera/manual controls; CT40 normally has no scan button and consumes the real Honeywell side-trigger barcode intent path. Common feedback distinguishes decode from validated arrival/carton/product discovery and from an actually recorded receipt. Normal successes advance through existing rules; physical confirmation and durable acknowledgement are still required where they were before.

Simple invalid/unknown/duplicate capture shows red/error tone briefly, then readiness without an OK dialog or another request. In CARTON mode, an already-received carton returns to the next-carton step without unnecessary reconfirmation or a stock write; in PRODUCT mode explicit source confirmation remains. Permission/offline/unknown-result holds cannot be cleared by feedback timers. Worker wording no longer exposes migration, API/HTTP/Prisma or replay implementation details. Source/code/task reasons remain available in safe operational terms.

See [Device-aware Receiving report](device-aware-receiving-report.md) for complete A–O audit, tests, known limitations and backend mapping. The absence of real station-scoped arrival enforcement, formal condition/disposition and atomic article idempotency still blocks full production acceptance; presentation changes do not repair those contracts.
