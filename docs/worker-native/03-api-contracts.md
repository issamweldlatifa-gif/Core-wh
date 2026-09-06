# 03 · Backend API contract audit

Baseline `4b762cf`. **Observed contract, not a proposed replacement.** Native and web clients were traced to controllers **and service implementations**. Base path `/api/v1` (URI versioning in `backend/src/main.ts`). Android currently defaults to `https://core-wh.onrender.com/api`; environment/deployed revision not verified. Native must use an explicit trusted HTTPS environment; never disable TLS to make testing pass.

## Shared contract notation

- `!` required field, `?` optional; `{}` means no useful body. All IDs/codes in paths must be percent-encoded as individual path segments.
- All endpoints require `Authorization: Bearer <accessToken>` unless marked public. JWT strategy rebuilds permissions from DB on **every** request. No credentials or API keys belong in scanner intents.
- **N** = `@RequireApplication(WORKER_NATIVE)`; **S** = surface-neutral + listed permission; **A** = ADMIN_WEB. S does not imply unauthenticated.
- Common failures: 401 missing/expired/revoked session or disabled account/device; 403 permission/application denied; 429 rate limit on auth; 500 unexpected/database failure. Error envelope: `{statusCode:number,message:string|string[],error:string,path:string,timestamp:ISO8601}`. Business refusals can instead be HTTP 200 `flash` or `kind` and must be examined.
- GET success 200; Nest POST normally 201 unless configured otherwise. Clients accept 2xx, not only 200.
- No write is authorized offline. A failed network response **does not prove a POST failed**. Read/reconcile before a worker decides to act again. Never automatically resubmit non-idempotent operations.
- Inline TypeScript body interfaces in Receiving/Fulfillment do **not** invoke class-validator. Swagger summaries are not full schemas. Native defensive validation is UX protection, not a replacement for backend validation.

## Authentication and work context

Sources: `modules/auth/{auth.controller,auth.service,token.service}.ts`, `dto/*`, `strategies/jwt.strategy.ts`, `modules/operations/{operations.controller,terminal.service}.ts`.

| Method / endpoint | Auth / authorization | Request | Success response | Errors / effects / retry |
|---|---|---|---|---|
| POST `/auth/login` | Public, rate-limited; server adjudicates app/roles/device | `identifier!:string[1..100]`, `secret!:string[1..128]`, `mode?:password\|pin` (case-normalized), `app?:ADMIN_WEB\|WORKER_NATIVE` default ADMIN_WEB, `deviceId?:string≤30` | `{accessToken,refreshToken}` | 400 DTO; 401 bad credentials/inactive; 403 wrong surface/unregistered/disabled/other-worker device. Creates session, audits, may bind unassigned device. No background retry; user may sign in again after ambiguous failure. |
| POST `/auth/refresh` | Public, rate-limited; signed refresh token + ACTIVE session | `refreshToken!:string(min10)` | token pair | 401 invalid/expired/revoked. Revokes old session, creates new preserving app/device/station. **Not retry-safe after lost response**. Client single-flight required; hash/CAS backend gap below. |
| GET `/auth/me` | S, authenticated | none | `{user:{id,name,employeeCode,email,status,lastLoginAt},roles:string[],permissions:string[],application,allowedApplications,session:{id,application,deviceId,stationId,createdAt,expiresAt}}` | Reads live DB identity. Safe read retry; no offline authorization. |
| POST `/auth/logout` | S, authenticated | `{}` | `{success:true}` | Revokes current session, USER_LOGOUT audit. Local tokens must be cleared even if network fails; do not claim server revocation then. |
| GET `/terminal/context` | N, authenticated; task list filtered by live permission | none | `{worker:{id},tasks:TerminalTask[],readyTaskCount,home,station?,activeSession?,activePutaway?,resume?}` | Task has `{key,label,path,department,permission,ready}`. `readyTaskCount` = module count, **not work count**. Resume is latest open receiving/putaway for worker; re-check it against current permissions. Safe read retry. |
| GET `/terminal/assignments` | N, self-scoped | none | `{open:Assignment[],recent:Assignment[]}` | Assignment `{id,title,description?,relatedType?,relatedCode?,status,note?,createdAt,completedAt?}`; recent limited 10. Safe read retry. |
| POST `/terminal/assignments/:id/complete` | N, service verifies owner | `note?:string` | `{ok:true,id,status:DONE}` | 404 not found/not own; 409 not OPEN. OPEN→DONE; audited. Does not complete a receiving/pick operation. No automatic replay; GET assignments after ambiguity. |

## Receiving response models

`SessionDetail` is returned by all Receiving commands:

```
id, code, status, startedAt, pausedAt?, completedAt?,
deviceType?, deviceName?, scanSource?,
arrival: {id,code,externalArrivalId,customerName,customerId,storeName?,status},
shipment?: {id,code,externalShipmentId,carrierName?,carrierCode?,trackingNumber?,
            senderName?,senderCompany?,totalCartons,totalProducts,totalUnits},
cartons: [{id,externalCartonId,reference?,qrCodeValue?,barcodeValue?,cartonNumber,
           totalCartons,status,weight?,weightUnit?}],
receivedCartonEvents: [{id,code,scanType,source,status,cartonId?,receivedAt?}],
products: [{id,sku?,reference?,productName?,category?,subcategory?,categoryStatus,
            expected,received,remaining,difference,status}],
discrepancies: [{id,type,status,reason?,expected?,actual?,difference?,resolution?}],
tally: {expectedCartons,receivedCartons,expectedProducts,receivedProducts,
        expectedUnits,receivedUnits,openDiscrepancies,shortUnits,overageUnits,
        unexpectedProducts,missingCartons},
flash?: {kind,...variant fields}
```

**Important:** `receivedCartonEvents.cartonId` is shaped as the **external carton code**, not DB UUID. Session active enum is `RECEIVING`, not `ACTIVE`. `flash.carton` can be an object (identified) or string (duplicate); decode as a union/JsonElement, never assume object. The response has `cartons`, not the old web type's `expectedCartons` alias. It has `completedAt`, not `endedAt`.

## Receiving endpoints (complete legacy client surface)

Sources: `modules/receiving/receiving.controller.ts`, `receiving.service.ts`; web `modules/receiving/api.ts`, native `WorkerRepository.kt`.

| Method / endpoint | Permission (S) | Required / optional request | Result / state / side effects | Errors / retry |
|---|---|---|---|---|
| GET `/receiving/arrivals` | `receiving.view` | none | Array `{id,code,customerName,storeName?,status,products,units,shipments,carrier?,tracking?,cartons}` for EXPECTED/RECEIVING/PAUSED; unpaginated | Safe read; only these real rows can be counted. |
| GET `/receiving/arrivals/:idOrCode/active` | `receiving.view` | path DB id or internal code | SessionDetail or null | 404 unknown arrival; safe read. External CRM arrival ID is not accepted here. |
| POST `/receiving/arrivals/:idOrCode/start` | `receiving.execute` | `deviceType?`, `deviceName?`, `scanSource?` strings | Existing RECEIVING/PAUSED session returned, else seeds reconciliation rows from arrival, attaches first shipment/station, arrival→RECEIVING; audit | 404 unknown; 409 already received. Logically reuse-existing, but concurrent start not DB-unique; read active after lost response, do not blindly repeat. |
| GET `/receiving/sessions/:id` | `receiving.view` | path session id | SessionDetail with fresh tally | 404 unknown; safe read/recovery. No owner filter in baseline. |
| POST `/receiving/sessions/:id/scan-carton` | `receiving.execute` | `code!:string`, `scanType?:QR\|BARCODE\|MANUAL` default MANUAL, `operationId?:string`, `source?:CAMERA\|EXTERNAL_SCANNER\|MANUAL` default MANUAL | Searches exact trimmed external id / QR / barcode / reference. `CARTON_IDENTIFIED` **does not receive**. UNKNOWN_CARTON / WRONG_SHIPMENT write scan + discrepancy; duplicate audit only | 400 empty; 404 session; 409 closed. 200/201 flash refusals. Operation ID dedupe only where a ReceivingCarton row exists, not identified audit. No blind retry. |
| POST `/receiving/sessions/:id/receive-carton` | `receiving.execute` | `cartonId!:string` (DB id/external id/QR), `operationId?`, `source?` | Creates RECEIVED event; WarehouseCarton→RECEIVED; audit; SessionDetail | 404 carton; 409 wrong shipment/closed. Same operation ID reuses state, duplicate carton returns DUPLICATE_CARTON. Dedupe globally keyed, not payload-verified; concurrent races unresolved. Reconcile event before declaring success. |
| POST `/receiving/sessions/:id/receive-product` | `receiving.execute` | `sku!:string`, `quantity?:number` default1, `source?` | **Totals-only** reconciliation, no ArticleUnit/tote. Quantity coerced `max(1,floor(Number(q)||1))`. Unknown SKU creates UNEXPECTED; expected line increments and overage discrepancy | No idempotency: client `operationId` ignored. No auto retry/offline replay. **Not used by migrated tote flow**. |
| POST `/receiving/sessions/:id/pause` | `receiving.execute` | `{}` | RECEIVING→PAUSED; arrival→PAUSED; audit | 409 not RECEIVING. Read state after ambiguity. |
| POST `/receiving/sessions/:id/resume` | `receiving.execute` | `{}` | PAUSED→RECEIVING; arrival→RECEIVING; audit | 409 not PAUSED. Read state after ambiguity. |
| POST `/receiving/sessions/:id/flag` | `receiving.execute` | `code?:string`, `sku?:string`, `reason?:string` | Creates OPEN IDENTIFICATION_ERROR if SKU supplied, otherwise UNKNOWN_CARTON; reason fallback. Returns SessionDetail | Not an accept/reject/condition API; no generic action capability. Non-idempotent, no blind retry. Native requires worker reason for meaningful report. |
| POST `/receiving/discrepancies/:id/resolve` | `receiving.resolve_discrepancy` | `resolution?:string` default “Resolved” | Discrepancy→RESOLVED + actor/time + audit; SessionDetail | Service also checks supervisor capability. Missing ID can produce Prisma error rather than documented 404. Do not infer from role name. Read state before retry. |
| POST `/receiving/sessions/:id/complete` | `receiving.execute`; also `receiving.resolve_discrepancy` if any variance/missing carton/open issue | `{}` | Exact match→COMPLETED/arrival RECEIVED; otherwise COMPLETED_WITH_DISCREPANCY/RECEIVED_WITH_DISCREPANCY, short lines→SHORT; audit | 403 supervisor needed; 409 closed. Baseline helper allows PAUSED; native requires explicit resume. No automatic replay. |

The product API's quantity coercion, PAUSED mutation allowance and globally keyed weak carton idempotency are **INVALID / REQUIRES BACKEND VERIFICATION**, not rules to copy.

## Fulfillment endpoints used by Worker clients

Source: `modules/fulfillment/{fulfillment.controller,fulfillment.service}.ts`, web `terminal/fulfillment-api.ts`, native `WorkerRepository.kt`.

| Method / endpoint | Permission (S) | Request | Response / effects | Refusals / retry |
|---|---|---|---|---|
| GET `/fulfillment/containers` | `receiving.view` | `type?:RECEIVING\|CUSTOMER`, `status?:ACTIVE\|READY_FOR_PACKING\|PACKED\|CLOSED` query | Last 200 containers, order ref, `_count.articles`, capacity stored on raw model | Bad enum may reach Prisma→500 (inline query types). Safe read; not total task count. |
| GET `/fulfillment/containers/:code` | `receiving.view` | code trimmed/uppercased by server | Container + order/items/products + article list | 404 unknown; safe read. |
| POST `/fulfillment/containers` | `receiving.execute` (**also for CUSTOMER bins**) | `type!:RECEIVING\|CUSTOMER`, `label?`, `orderReference?` required for CUSTOMER, `capacity?:integer1..100000` default50 | New RCN-/BIN- code, ACTIVE, creation audit. Customer order bound | 400 capacity/order ref; 404 order; 409 closed order/already active bin. No idempotency; GET after ambiguity. Permission mismatch for pure pickers is not fixed by UI granting receiving. |
| POST `/fulfillment/receiving/sessions/:id/scan-article` | `receiving.execute` | `sku!:string`, `containerCode!:string`, `cartonCode?:string` | **Exactly one** physical ArticleUnit→IN_CONTAINER; reconciliation +1; audit. `{flash:{kind:ARTICLE_RECEIVED\|UNEXPECTED_ARTICLE,article:{code,sku,productName?,category?,subcategory?,categoryStatus},container},matched:boolean,receivingProductId}` | 400 SKU; 404 session/tote; 409 session not RECEIVING, tote wrong type/not ACTIVE. Unexpected SKU is **written**, not rejected. No quantity/source/operationId/condition fields; no capacity or strict carton provenance enforcement. **No retry after ambiguous response; no quantity POST loop.** |
| GET `/fulfillment/sorting/articles/:code` | `stowing.execute` | article code | `{kind:DESTINATION,article,zone,suggestedLocations[]}` or NEEDS_REVIEW/UNMAPPED/AMBIGUOUS/REJECTED+reason | 404 unknown; safe read. Suggested locations are not proof of capacity/reservation. |
| POST `/fulfillment/sorting/store` | `stowing.execute` | `articleCode!`, `locationCode!` | Article→STORED, sets location, removes tote; `{flash:{kind:STORED,article,location},article}` + audit | 404; 409 article not receivable/classification/location inactive/wrong resolved zone. Missing mapping is not hard-denied in service: backend gap. No auto retry. |
| GET `/fulfillment/order-sorting/articles/:code` | `picking.execute` | article code | ASSIGNMENT+article/order/orderItemId/bin?/binMissing; NO_ORDER+reason; REJECTED+reason | 404; safe read. Not directed location-first Picking. |
| POST `/fulfillment/order-sorting/assign` | `picking.execute` | `articleCode!`, `containerCode!` | Article→IN_CUSTOMER_BIN; order/bin bindings; completeness may set READY_FOR_PACKING. `{flash:{kind:ARTICLE_ASSIGNED\|BIN_READY_FOR_PACKING,article,bin,customer,progress}}`; audits/events | 404; 409 already assigned/packed/shipped, wrong bin/type/status/order/SKU not needed. Does not require STORED for all source states. No auto retry. |
| GET `/fulfillment/packing/containers/:code` | `packing.execute` | code | `{bin:{code,label?,status},order:{reference,customer},required:[{sku,productName,requested,inBin}],articles[],complete}` | 404; 409 wrong type/no order; safe read. |
| POST `/fulfillment/packing/containers/:code/pack` | `packing.execute` | `{}` | Bin→PACKED, articles→PACKED, outbound READY_TO_SHIP; `{flash,shipment:{code,status,carrier?,trackingNumber?,labelValue}}`; audits/events | 404; 409 already packed/closed, empty/incomplete. Internal label only; **does not print**. No auto retry. |
| GET `/fulfillment/shipping/shipments/:code` | `shipping.execute` | code | Shipment + order/articles/container; status READY_TO_SHIP/SHIPPED | 404; safe read. |
| POST `/fulfillment/shipping/shipments/:code/ship` | `shipping.execute` | `{}` | Shipment/articles→SHIPPED, bin→CLOSED; history kept; `{flash:{kind:SHIPPED,shipment}}`; audits/events | 404; 409 already shipped. No auto retry. |
| GET `/fulfillment/articles/:code/trace` | `operations.view` | code | `{article,trace:{crmCard?,expectedArrival?,inboundShipment?,sourceCarton?,receivingSession?,container?,storageLocation?,customerOrder?,customer?,outboundShipment?,tracking?,shippedAt?}}` | 404; safe read. Present in native client but not worker task registry; do not expose by inventing a worker permission. |

PublicArticle: `{code,sku,productName?,category?,subcategory?,categoryStatus,status}`. Flash fields are not uniform across operations; preserve actual JSON shape.

## Putaway API (web fallback; native missing at baseline)

Sources: `modules/putaway/{putaway.controller,putaway.service}.ts`, `dto/putaway.dto.ts`, web `terminal/putaway-api.ts`.

`PutawaySession`: `{id,code,status:ACTIVE|PAUSED|COMPLETED|CANCELLED,startedAt,completedAt?,worker?,station?,placements:[{id,cartonCode,locationCode,placedAt,releasedAt?,cartonSource,locationSource}],tally:{storedThisSession,totalPlacements,pendingCartons}}`.

| Method / endpoint | N permission | Request | Success / state / side effects | Errors / retry |
|---|---|---|---|---|
| GET `/putaway/queue` | `stowing.view` | `limit?:number` default50, max200 | RECEIVED, unplaced cartons; arrival/customer/shipment/categories/classification/sorting verdict | Invalid limit not fully DTO-validated. Safe read, list may be capped. |
| GET `/putaway/sessions/active` | `stowing.view` | none | Worker's latest ACTIVE/PAUSED session or null | Safe read. |
| GET `/putaway/sessions/:id` | `stowing.view` | id | PutawaySession | 404; safe read; no owner check in baseline. |
| POST `/putaway/sessions/start` | `stowing.execute` | `deviceType?:string≤40`, `deviceName?:string≤120` | Reuse own open session, else ACTIVE session + station + audit | Read active before retry after ambiguity; race not DB-unique. |
| POST `/putaway/scan-carton` | `stowing.execute` | `code!:string1..160` | `{flash:CARTON_READY+carton}` or UNKNOWN_CARTON / CARTON_NOT_RECEIVED | Read-only despite POST; 400 bad DTO/empty. Allows RECEIVED or STORED carton. |
| POST `/putaway/scan-location` | `stowing.execute` | `code!:string1..160` | `{flash:LOCATION_READY+location}` or UNKNOWN_LOCATION / LOCATION_UNAVAILABLE | Read-only; uppercases code; validates ACTIVE only. |
| POST `/putaway/sessions/:id/place` | `stowing.execute` | `cartonCode!`, `locationCode!` strings1..160, `cartonSource?`, `locationSource?` ScanSource enums | `{flash:STORED+carton/location/moved,session}`; closes previous placement, appends new, carton→STORED. Same current location no-op | 404 session; 409 not ACTIVE; other refusals in flash. No operation ID. Destination category is audited **advisory**, not authorization. Reconcile first on network error. |
| POST `/putaway/sessions/:id/pause` | `stowing.execute` | `{}` | status→PAUSED, audit | No source-state/owner gate in baseline service. No auto retry. |
| POST `/putaway/sessions/:id/resume` | `stowing.execute` | `{}` | status→ACTIVE, audit | Same source-state gap. No auto retry. |
| POST `/putaway/sessions/:id/complete` | `stowing.execute` | `{}` | status→COMPLETED, audit; already completed no-op | 404. Reconcile before retry. |

## APIs explicitly absent

No worker sync/offline-batch API, scanner telemetry sink, worker push API, device self-registration, formal Receiving rejection/condition, directed Picking tasks/reservations, Inventory count/recount/blind count, or Returns/disposition API exists. Admin device registry and admin live SSE are not replacements. No native client for a proposed API is to be shipped as if it existed.

## Separate backend changes required (NOT silently implemented by this native slice)

| ID | Change / why | Required evidence before enabling |
|---|---|---|
| BC-01 | Extend the **existing** article-receipt endpoint with atomic bounded quantity, idempotency key, payload/actor/session binding, scan-source and operation-result lookup. No new competing receipt API. | DTO/schema migration, replay and concurrent-device DB tests, lost-response test, deployment capability/version verification. Until then exactly one article per confirmed request; no queue/retry. |
| BC-02 | Extract one backend reconciliation routine for totals/article paths; transaction/locking strategy; retain UNEXPECTED on repeated unexpected SKU; enforce agreed tote capacity and carton provenance. | Existing contract parity, concurrent quantity/overage tests; policy approval on capacity/provenance enforcement. |
| BC-03 | Define condition/rejection/exception reason catalog and per-state allowed actions, quantity/disposition rules, supervisor override semantics. | Warehouse owner signs business rules; backend-enforced permissions and audit; rejected item never silently counted as accepted. |
| BC-04 | Consistent active/paused/closed state gates, owner/warehouse scope, atomic session start; clarify multi-shipment arrivals. | Negative authorization/session tests and existing worker handoff policy approval. |
| BC-05 | Auth refresh hash/sub/app verification + atomic consume; device binding concurrent-use tests; managed-device policy. | Old-token replay/race tests, revoke/reassign tests, existing login compatibility. |
| BC-06 | Directed Picking, strict Putaway validation, Inventory and Returns contracts, permission keys and backend counts. | Workflow-specific specs 10–13, database migrations and negative API tests before native screens. |

This report is the integration contract for the migration. A client-side restriction may reduce accidental work, but **never repairs missing backend authorization**. Production remains blocked on critical server findings.
