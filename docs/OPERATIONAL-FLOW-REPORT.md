# EXECUTION REPORT — Operational Warehouse Flow

Commit: `e1d579d` (pushed to `master`, on top of `7312aea`)
Verification: 38/38 unit tests · 85/85 e2e tests (incl. new 15-case flow matrix) · backend + frontend builds green · full chain exercised live over HTTP (login → CRM card → order → receive → tote → sort → store → bin → pack → ship → trace).

---

## 1. What was implemented (per ordered stage)

| # | Stage | Status | How |
|---|-------|--------|-----|
| 1 | Receiving execution | DONE | New article-level scan: each scanned piece becomes an `ArticleUnit` (SKU matched vs expected line; qty/status/OVERAGE logic reuses the existing reconciliation). Unexpected SKU → `UNEXPECTED_ARTICLE` flash + `ReceivingDiscrepancy(UNEXPECTED_PRODUCT, OPEN)` → immediately visible in Admin → Exceptions (verified live). Products never return to the carton: the unit's only container reference is the tote. |
| 2 | Receiving containers | DONE | `OperationalContainer` type `RECEIVING` (`RCN-xxxxxx`, unique QR value = code). Mixed content allowed. Linkage recorded on the article: container + receiving session + source carton + expected line. |
| 3 | Sorting + storage | DONE | Scan article → backend resolves Category → `CategoryZoneMapping` (configuration, never hardcoded) → shows zone + up to 5 free STORAGE locations in the Warehouse Tree. Scan location → zone validated server-side (wrong zone = 409 with explicit message), article → `STORED` + `currentLocationId` + `ITEM_STORED` audit. `NEEDS_REVIEW` articles are blocked from storage. |
| 4 | Customer sorting | DONE | Customer bins: `OperationalContainer` type `CUSTOMER` (`BIN-xxxxxx`, big label = customer reference, attached to one OPEN order; duplicate active bin rejected). Scan article → system answers PRODUCT → CUSTOMER → CONTAINER. Scan bin → hard validation: bin's order must genuinely still need that SKU (wrong bin/customer/unneeded article → 409 with clear text). Order complete → bin flips to `READY_FOR_PACKING` (audited). |
| 5 | Packing | DONE | Scan bin QR → customer + order + required-vs-present item table. Incomplete bin cannot be packed (409). Pack → `OutboundShipment` (`OUT-xxxxxx` internal label/QR), articles → `PACKED`, bin → `PACKED`, `ORDER_PACKED` audit with full article list. Carrier seam: `CarrierAdapter` interface with a `NullCarrierAdapter` — carrier/tracking stay NULL because **no carrier API exists in this repo** (see gaps). |
| 6 | Shipping | DONE | Scan `OUT-` label → order/customer/contents/tracking shown. Confirm dispatch → shipment `SHIPPED` + `shippedAt/shippedBy`, all articles `SHIPPED`, `SHIPMENT_DISPATCHED` audit. Double dispatch rejected. |
| 7 | Archive/cleanup | DONE | On ship: customer bin → `CLOSED` (audited `CONTAINER_CLOSED`). Rows are **never deleted** — containers, articles, shipments and every audit row remain queryable; verified by e2e case 14 and the trace endpoint. |

## 2. Changed / new files

Backend
- `backend/prisma/schema.prisma` — new enums `ContainerType`, `ContainerStatus`, `ArticleUnitStatus`, `OutboundShipmentStatus`; new models `OperationalContainer`, `ArticleUnit`, `OutboundShipment`; +3 `AuditAction` values; back-relations on `WarehouseOrder`, `OrderItem`, `ExpectedArrivalItem`, `ReceivingSession`, `WarehouseCarton`, `Location`. All additive.
- `backend/prisma/migrations/20260903120000_operational_flow_containers_articles_outbound/migration.sql` — guarded, replay-safe.
- `backend/src/bootstrap-schema-repair.ts` — migration fully mirrored (Render start-command bypass) + registered in the ledger list.
- `backend/src/modules/fulfillment/` — **new**: `fulfillment.service.ts` (all stage logic + traceability), `fulfillment.controller.ts`, `fulfillment.module.ts`.
- `backend/src/modules/orders/` — **new**: `orders.service.ts` (idempotent intake + read), `orders.controller.ts`, `orders.module.ts`.
- `backend/src/integrations/crm/crm-orders.controller.ts` + `dto/order-card.dto.ts` — **new** service-auth order intake endpoint.
- `backend/src/modules/operations/terminal.service.ts` — task registry: sorting → `ready:true`; added `order-sorting`, `shipping`; packing → `ready:true`.
- `backend/src/modules/operations/terminal.service.spec.ts` — updated to the new registry contract.
- `backend/src/app.module.ts` — registers `OrdersModule`, `FulfillmentModule`.
- `backend/prisma/seed.ts` — §3 approved taxonomy into Category Master (upsert-only, admin edits never overwritten) + TEST Category→Zone mappings for the seeded SHOES/CLOTHING zones + `ST-SHP-01` DISPATCH station.
- `backend/test/operational-flow.e2e-spec.ts` — **new** 15-case matrix.

Frontend
- `frontend/src/terminal/fulfillment-api.ts` — **new** typed client.
- `frontend/src/terminal/SortingTask.tsx`, `OrderSortingTask.tsx`, `PackingTask.tsx`, `ShippingTask.tsx` — **new** worker screens.
- `frontend/src/terminal/flow-task.css` — one shared stylesheet for all four (os-* theme, AYROVI identity preserved: black/green mono, green=confirmed, yellow=warning, red=error, blue=info).
- `frontend/src/terminal/ReceivingTask.tsx` — operational tote selector (+NEW TOTE / select / release); with a tote active every product scan creates the traceable article in it; without a tote the exact legacy behaviour is preserved.
- `frontend/src/App.tsx` — routes `/terminal/sorting`, `/terminal/order-sorting`, `/terminal/packing`, `/terminal/shipping`, each behind its `PermissionGate`.
- `backend/public/` — refreshed deployed SPA copy.

## 3. Database changes (all additive)

- `operational_containers` — code (unique, = QR), type RECEIVING/CUSTOMER, status ACTIVE/READY_FOR_PACKING/PACKED/CLOSED, label, orderId (SetNull), createdBy.
- `article_units` — code `ART-` (unique), sku/name/category/subcategory/categoryStatus snapshot, status RECEIVED/IN_CONTAINER/STORED/IN_CUSTOMER_BIN/PACKED/SHIPPED, provenance FKs (arrivalItem, receivingSession, sourceCarton), containerId, currentLocationId+storedAt, orderId+orderItemId, outboundShipmentId. All FKs SetNull-safe; 8 indexes.
- `outbound_shipments` — code `OUT-` (unique), orderId (Restrict), containerId, status READY_TO_SHIP/SHIPPED, carrier/trackingNumber (NULL until real adapter), packedBy/At, shippedBy/At.
- `AuditAction` += `CONTAINER_READY_FOR_PACKING`, `CONTAINER_CLOSED`, `ARTICLE_SCANNED`.
- **No existing table/column/enum value was modified or removed.** Blueprint §20 carton statuses untouched (no SORTED status added — per standing decision). The per-piece lifecycle uses the NEW `ArticleUnit`; the Phase-2 `PhysicalItem` D-47 guard was NOT lifted (see gaps).

## 4. New / modified APIs

Integration (service-auth `x-api-key`, @Public + IntegrationApiGuard)
- `POST /api/v1/integrations/orders` — order intake, idempotent on `externalOrderReference` + living `contentHash` (replay → `UNCHANGED`); content update rejected once articles are fulfilled.

JWT + permission-gated
- `GET /api/v1/orders`, `GET /api/v1/orders/:reference` (operations.view) — read surface incl. bins, articles, outbound shipments.
- `POST/GET /api/v1/fulfillment/containers`, `GET /containers/:code` (receiving.execute/view).
- `POST /api/v1/fulfillment/receiving/sessions/:id/scan-article` (receiving.execute).
- `GET /api/v1/fulfillment/sorting/articles/:code`, `POST /sorting/store` (stowing.execute).
- `GET /api/v1/fulfillment/order-sorting/articles/:code`, `POST /order-sorting/assign` (picking.execute).
- `GET /api/v1/fulfillment/packing/containers/:code`, `POST /packing/containers/:code/pack` (packing.execute).
- `GET /api/v1/fulfillment/shipping/shipments/:code`, `POST /shipping/shipments/:code/ship` (shipping.execute).
- `GET /api/v1/fulfillment/articles/:code/trace` (operations.view) — full chain.

All existing endpoints unchanged; legacy `receive-product` still works (receiving/putaway not broken — receiving e2e suite still green).

## 5. Screens

- `/terminal/sorting` — SCAN ARTICLE → decision panel (zone + free locations / MANUAL REVIEW / NO DESTINATION CONFIGURED) → SCAN LOCATION → STORED. 
- `/terminal/order-sorting` — SCAN ARTICLE → SKU / CUSTOMER / BIN panel → SCAN BIN → confirmation or explicit rejection; bin board with big labels + statuses; bin creation by order reference.
- `/terminal/packing` — SCAN BIN → customer/order/required-vs-in-bin verification → CONFIRM PACKED → shipping label panel (OUT code, carrier "INTERNAL (no carrier connected)", tracking —).
- `/terminal/shipping` — SCAN LABEL → order/customer/contents/tracking → CONFIRM DISPATCH.
- `/terminal/receiving` — extended with the CONTAINER (tote) selector.
Each follows SCAN → SYSTEM DECISION → ACTION → CONFIRMATION → NEXT ITEM, uses the shared os-theme, audio feedback, keyboard-wedge friendly input. Worker terminal home now offers the new tasks per permission (verified live: WORKER001 sees receiving/sorting/putaway).

## 6. Status transitions

- ArticleUnit: `RECEIVED → IN_CONTAINER → STORED → IN_CUSTOMER_BIN → PACKED → SHIPPED` (each transition server-enforced; backward/skip transitions rejected).
- Container: `ACTIVE → READY_FOR_PACKING → PACKED → CLOSED` (customer bins); receiving totes stay ACTIVE/CLOSED.
- OutboundShipment: `READY_TO_SHIP → SHIPPED` (single transition, double-dispatch 409).
- Every transition writes an audit row atomically inside the same transaction: `CONTAINER_CREATED`, `ARTICLE_SCANNED`, `ITEM_STORED`, `ITEM_PICKED`, `CONTAINER_READY_FOR_PACKING`, `ORDER_PACKED`, `SHIPMENT_DISPATCHED`, `CONTAINER_CLOSED`.

## 7. Tests

- Unit: 38/38 (terminal spec updated for the new registry).
- E2E: 85/85, incl. new `operational-flow.e2e-spec.ts` (15 cases: tote scan/traceable unit, unexpected→exception, customer-container-at-receiving rejected, configured destination, wrong-zone rejected, stored, NEEDS_REVIEW blocked, idempotent order intake, bin label + duplicate bin rejected, PRODUCT→CUSTOMER→BIN, wrong-bin + no-order rejected, READY_FOR_PACKING, packing verification + null carrier, SHIPPED + cleanup with history kept, full trace).
- Live HTTP smoke of the entire chain against the running server, including admin exception visibility and worker terminal context.

## 8. Remaining gaps / honest findings

1. **No Orders API existed at all** — `WarehouseOrder`/`OrderItem`/`Product` were schema-only. I did NOT redesign them; I built the missing intake (integration endpoint, same auth/idempotency model as the card endpoints) + read surface. If the real system of record pushes orders differently, only the DTO/controller needs adapting.
2. **No outbound carrier/shipping API exists anywhere in the repo.** The existing "shipments" module is INBOUND only (CRM Shipment Cards). Packing therefore uses an isolated `CarrierAdapter` seam with a `NullCarrierAdapter`: internal `OUT-` label, `carrier`/`trackingNumber` NULL. Nothing was invented. Connecting DHL/Aramex/etc. later = one adapter class, zero workflow changes.
3. **Carton→article provenance is optional**: the CRM contract still has no per-carton product manifest (card-level only — previously flagged to the Card developer). `scan-article` accepts an optional `cartonCode` and records it when the worker scans the carton first; without it the article still traces to card/arrival/session.
4. `PhysicalItem` (Phase-2 D-47-guarded model) was left untouched; the per-piece lifecycle lives in the new `ArticleUnit`. If you later want the two unified, that is a deliberate follow-up migration.
5. ~~New terminal screens use manual/wedge input~~ — **CLOSED in `1e4d22b`**: the camera `ContinuousScanner` is now wired into all four flow terminals (Sorting, Order Sorting, Packing, Shipping) with the same OPEN SCANNER button, outcome feedback and station-gated OCR as Receiving/Putaway.
6. ~~Printing of container/label QR codes out of scope~~ — **CLOSED in `1e4d22b`**: `print-label.ts` renders QR labels as SVG (via the already-bundled @zxing encoder, zero new dependencies) and opens the browser print dialog: BIN labels (big customer name) printed on creation + 🖨 reprint per bin, RCN tote label on creation, OUT shipping label after packing. Dedicated thermal-printer drivers remain out of scope (browser print covers A4/label printers).
7. Order-sorting uses permission `picking.execute` (PICKER role); assign workers accordingly.

### Follow-up `1e4d22b` additions
- **Admin Traceability board** — `/admin/traceability` (operations.view): search/scan any `ART-` code → the full non-negotiable chain rendered hop-by-hop (Card → Arrival → Inbound Shipment → Carton → Receiving Session → Container → Storage Location → Order → Customer → Outbound Shipment → Tracking → Shipped At; unreached hops dimmed), plus a live board of recent articles filterable by status with one-click TRACE.
- New API: `GET /api/v1/fulfillment/articles` (operations.view) — recent article units with container/location/order/shipment joins.
- Verified: 38/38 unit + 85/85 e2e still green; live HTTP smoke of scan → board → trace.

No conflicts with existing code: all suites that existed before are still green, receiving/putaway flows untouched, card integration untouched.
