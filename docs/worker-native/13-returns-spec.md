# 13 · Returns specification / missing disposition contract

**Status: BLOCKED / NOT IMPLEMENTED.** The audited code has trace, receiving and fulfillment functionality, but no complete authorized operational returns/disposition API. Do not simulate returns by calling Receiving with a negative quantity or relabeling a container.

## Required real workflow

Return authorization/task → scan return reference → identify and validate returned product/ArticleUnit → verify permitted quantity and origin → record condition and actual return reason → obtain server-permitted disposition → explicit confirm (restock / reject / quarantine as authorized) → server stock/audit result → next item → complete return.

Unknown return/product, wrong order/customer, duplicate previously processed unit, missing label, excess quantity and condition requiring review must stay explicit. Returning physical stock is not automatically authorization to credit an order or make it sellable.

## BC-03/06 contract information needed

- Return/RMA identity, original shipment/order/article linkage, authorization window, owner/warehouse scope and task lifecycle/version.
- Remaining returnable quantity, duplicate serial/ArticleUnit detection, UOM, multi-unit/partial return rules and origin provenance.
- Server condition/reason taxonomy with required evidence/notes and sensitive attachment policy if needed. No client-only freeform value passed as an unsupported backend field.
- Disposition capabilities and role/permission enforcement: sellable restock, rejection, quarantine/inspection, escalation; which physical holding/target locations are allowed.
- Transactional effects on ArticleUnit/stock, condition/sellability, tote/location, return record and audit. Financial effects belong to an explicit backend contract, not a mobile assumption.
- Idempotency and operation lookup, current-version conflicts, response-loss reconciliation, task cancellation/takeover and immutable decision history.

Existing `receiving.resolve_discrepancy` does not by itself authorize returns rejection, restocking or quarantine. The backend must enforce the specific action even if a client exposes no button.

## Shared native implementation after approval

Use the same session/transport, scanner source handling, terminal shell and product/location/quantity/exception/confirm/danger components. ReturnsUseCase owns sequencing; UI only renders permitted actions and dispatches intents. Read condition/reason options from authoritative configuration; no visual mock flow with invented backend success.

Restock must show and validate the physical destination. Reject/quarantine must explain the server-approved next handling action. Destructive disposition requires an explicit confirmation and reason. Server refusal shows expected/scanned/reason plus only permitted recovery actions.

## Offline and acceptance gates

Only draft editing/scan cancellation is currently SAFE OFFLINE. Return receipt/disposition/restock authorization is **UNKNOWN—BACKEND VERIFICATION REQUIRED**; no replay queue. A lost response cannot be resolved from aggregate stock alone. Stop, query operation result when supported, and reconcile physically before repetition.

Test actual authorized/unknown/expired return, wrong product/customer, duplicate serial, quantities, condition taxonomy, each disposition and unauthorized direct request, target location validation, race with other worker, interrupted task, no network before/after confirmation, auth expiry, process death and resulting stock/sellability/audit consistency. Require real API/DB evidence, enterprise-device checks and controlled warehouse acceptance.

Until all gates pass, retain existing trace/fulfillment/admin functionality. Returns absence prevents the requested full migration/cutover from being called complete.
