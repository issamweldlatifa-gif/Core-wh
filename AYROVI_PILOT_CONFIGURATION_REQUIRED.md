# AYROVI pilot configuration required

**Status: BLOCKED.** No production configuration was invented or deployed.

| Status | Category | Required owner-supplied configuration/evidence |
|---|---|---|
| [MISSING] | Worker | Approved real roster, employee identities, shift/absence coverage; no demo users in Production. |
| [MISSING] | Role / Permission | Role-to-stage matrix for Receiving, Product Placement, customer Sorting, Packing, Shipping and Supervisor; explicit correction/reopen permissions. |
| [MISSING] | Station | Approved IDs/codes, active status, allowed task departments, worker/device binding and assignment change procedure. |
| [MISSING] | Zone / Location | Real staging/storage/shipping-out destinations; capacity/compatibility and warehouse boundaries. |
| [MISSING] | Task / Assignment | Configured next-stage routing, eligible worker selection, workload/tie-break rules, blocked/no-worker behavior and reassignment/expiry policy. Existing manual assignment/sync is not full automatic routing. |
| [MISSING] | Container capacity | Per-purpose capacity, early-close policy, successor-container creation and incompatible-customer isolation.50 is used only as explicit test configuration. |
| [MISSING] | Business Rule | Product Placement versus existing category storage mapping; whole-order/multi-container policy; physical serial/unit identity versus repeated SKU scans. |
| [MISSING] | Issue handling | Severity/blocking/escalation/acknowledgement/resolution rules across all stages. |
| [MISSING] | Shipping | Required verification, real customer/address references, carrier integration or approved internal dispatch-note scope, printer/label format. |
| [MISSING] | Device | Actual CT40 model/Android/firmware/Scan Wedge profile, registered device identities and phone test inventory. |
| [MISSING] | Signing | Managed keystore/certificate used by installed Worker App, alias and passwords supplied through the approved secret store; never in chat/Git. |
| [MISSING] | Distribution | Approved signed APK distribution/MDM target. Existing Actions debug artifacts are QA, not a declared production channel. |
| [MISSING] | Render | Actual web service IDs, repository/branch bindings, authorized read access, service URLs, build/deploy/runtime log evidence and exact commit health. |
| [MISSING] | Recovery | Verified encrypted database/config backups, restore test, migration/drift review and application rollback artifact. |
| [MISSING] | Approval | Warehouse, security, QA, backend/Android and release owners; acceptance criteria and go-live window. |

Provide configuration through Admin/MDM/environment controls. Do not send credentials or production customer datasets in chat. The session remains on `arena/01a073df-core-wh`; a Render service following another branch will not automatically deploy its pushes.
