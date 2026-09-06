# AYROVI end-to-end validation report

Date: 2026-09-06 · **overall requested automatic warehouse chain: BLOCKED**.

Do not confuse an HTTP/database test of existing stock operations with the requested automatic assigned-worker chain. Production data, devices and Render were not used for this test.

## 1. Scenario used — PASS (isolated test setup)

`backend/test/warehouse-volume.e2e-spec.ts`: one uniquely prefixed test arrival, three cartons with barcode/QR values, **90 physical ArticleUnits**, three SKUs/references, three customer/order references (30 units each), receiving/supervisor/storage/customer-sort/packing/shipping actors with real database roles, stations and registered devices. Container capacity is supplied as configuration 50, not mobile arithmetic. One tote closes at 50, another closes manually at 37, a final tote contains 3.

Fixture setup is restricted by `AYROVI_TEST_DATABASE=true`. Setup uses isolated records; after setup stock moves only through authenticated HTTP APIs. The CI PostgreSQL service is disposable; observations are saved under ignored `backend/test-results/`. No test records were inserted into Production.

## 2. Receiving result — PASS for exercised operations

Assigned receiving appears via the actual assignment API. Wrong worker and manual completion of the operational task are denied. Three cartons are identified then confirmed; duplicate/unknown codes are distinct; missing quantities block ordinary completion. Supervisor resolves the test issue through the existing API. Ninety unit receipts and one operation replay produce exactly 90 ArticleUnits in this sequential scenario. Receiving completion updates the worker's task in the inventory transaction.

Concurrent capacity/provenance/payload-binding guarantees beyond this scenario are **BLOCKED** pending further implementation/validation.

## 3. Placement result — BLOCKED

The existing category sorting/storage endpoint successfully moves units from the receiving tote to a configured location. This is **not** the requested separately assigned Product Placement stage that automatically selects/opens capacity-managed containers. The test still calls container creation explicitly through the worker API; automatic successor-container creation and Receiving→Placement task handoff are absent and are recorded as BLOCKED in the observations.

## 4. Sorting result — PASS for existing customer-bin matching; full task handoff BLOCKED

Correct articles enter their customer/order bin; wrong customer bin and repeat assignment are rejected. Completed contents make the existing bin READY_FOR_PACKING. No DB state edits move an article. Automatic sorting-task creation/assignment and the requested explicit customer-card completion/correction workflow are not fully validated.

## 5. Packing result — PASS for existing packing; destination preparation BLOCKED

Three complete 30-unit bins pack into real outbound records. The current patch rechecks locked bin state/completeness and updates linked packing assignments in the same transaction. Configured shipping-out destination verification as a separate operation remains missing.

## 6. Shipping result — PASS for existing dispatch; required verification gate BLOCKED

Each outbound record is read then dispatched; a second dispatch is rejected. All 90 units become SHIPPED; no unit loses its order link. Shipping status/completion is serialized and linked assignment update is transactional. The existing POST still lacks an actor/version/content-bound prior-verification token. Thus the requested rule “no shipping without required verification” is **not certified**.

## 7. Admin result — PASS for exercised read/trace; full monitoring BLOCKED

Admin HTTP search finds each dispatched shipment with 30 articles; article trace links back to the arrival. Existing dispatch-note rendering uses backend data and has escaping tests. A complete immutable bordereau with every required station/device/issue field, universal issue lifecycle and all automatic task history remain incomplete. Admin was not redesigned.

## 8. Phone result — BLOCKED for full-chain acceptance

Existing native Phone presentation/scanner architecture is retained and Receiving integration updated for upstream operationId/capacity/assignment contracts. Full downstream native task execution and actual handset tests are not completed by backend HTTP tests. Native CI evidence is recorded in the final release report.

## 9. CT40 result — NOT TESTABLE physically here

No real CT40/USB/ADB/warehouse operator is connected. Existing Honeywell detector/imager adapter and scanner-first UI were not rebuilt. Prior emulator/synthetic-intent evidence is not a physical50+ trigger/QR/audio/network pilot.

## 10. Permission/security result — PASS for exercised guards; broader chain BLOCKED

Real JWT/role/application guard matrix runs on PostgreSQL. New fixes block manual closure of linked/blocked tasks, scope workflow updates to actor/taskKey, check linked-task ownership/station, compare stored refresh hash/subject/application, consume refresh atomically, and preserve device/station binding. Unassigned floor-work policy remains permissive by the upstream operating model; strict assignment-only routing and cross-stage takeover policy still need approved implementation.

## 11. Error/offline result — PASS for existing automated coverage; field acceptance BLOCKED

Native no-replay/journal and worker-safe errors remain. Health now returns503 when DB probe fails. Render/backend outage recovery and real device scanner disconnects were not field tested. No offline stock authority or outbox is invented.

## 12. Data integrity result — PASS for sequential90-unit assertions; production integrity BLOCKED

The database test asserts 90 distinct received/shipped units, correct customer counts and no missing order references. It does not prove every concurrent capacity/order allocation/code-generation race, payload-bound idempotency, unique task creation or global issue closure rule. No claim of full production integrity is made.

## 13. Failed tests — FAIL (resolved findings) / BLOCKED (scope)

- First database attempt: fixture device codes were lowercase but real authorization normalizes to uppercase. Corrected fixture data; no auth bypass was introduced.
- Second attempt: worker assignment projection returned null entity relations because `myAssignments` did not include them. Fixed the backend projection, not the assertion.
- Local unit doubles needed the newly enforced transaction/access collaborators; mocks and assertions were updated to the stricter contract, with new negative tests.
- Full automatic next-task/Placement/native downstream/shipping-verification acceptance remains BLOCKED, not counted as passed tests.

## 14. Root causes

[DATA] Fixture normalization mismatch. [BACKEND] Missing relation includes. [PERMISSION]/[STATE MACHINE] Operational/manual assignment completion conflated and callbacks updated blocked/other-worker tasks. [DATABASE] Completion synchronization happened after commit with swallowed errors. [SECURITY] Weak refresh rotation and automatic demo/password seeding. [ASSIGNMENT] No complete configured next-task creation policy.

## 15. Fixes performed

Integrated approved upstream model instead of adding another task engine. Hardened assignment completion/synchronization, refresh/subject/device checks, packing/shipping serialization, health status, seed/startup safety, header-authenticated Admin SSE and native operationId/assignment/capacity compatibility. Added real PostgreSQL HTTP scenario and managed release/Render verification gates. No production migration/deployment was explicitly run or verified; automatic Render behavior is unverified.

## 16. Remaining blockers

Automatic assigned Receiving→Placement→Sorting→Packing→Shipping chain, successor container policy, downstream native flows, full issue lifecycle, shipping verification binding, concurrent integrity coverage, approved real configuration, physical devices, signed release identity/distribution and verified Render service/branch/commit/log/health evidence. **Do not declare the requested workflow complete.**

Execution verified: [Backend CI](https://github.com/issamweldlatifa-gif/Core-wh/actions/runs/34019791630) passed 22 PostgreSQL HTTP tests with zero failures/pending. It explicitly reported the 90-unit existing stock path PASS and automatic Placement handoff/container rollover/full assigned chain BLOCKED. Native CI passed 123 JVM and 19 emulator tests. Final references/counts are in `AYROVI_FINAL_RELEASE_REPORT.md`. A successful existing stock-path suite is not a successful automatic task-chain gate.
