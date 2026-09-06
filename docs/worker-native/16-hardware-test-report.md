# 16 · Physical hardware test report

## Result: NOT RUN — NO HARDWARE ACCEPTANCE

No physical Android handset, Zebra/Honeywell terminal, USB/ADB connection or warehouse operator was available in this session. No trigger/scan-speed/ergonomics/battery claims are certified. Emulator/automated tests cannot fill this report with PASS.

## Required device record (one per target configuration)

Record: manufacturer/model/asset ID; Android/API/security patch; firmware; DataWedge/Data Collection service versions; managed scanner profile revision and export hash; Android package/version/SHA-256/signing certificate; backend URL/commit/schema version; date/operator/approver; test account permission set and assigned station; camera/hardware/HID/manual modes; network conditions; sanitized printed-label fixture IDs. **Never record passwords/tokens or production customer data.**

Target model/OS/profile and hardware owner are **TBD by warehouse/IT**. Zebra and Honeywell support in source is not a tested model list. Camera-only installability must also be validated because camera is now an optional manifest feature.

## Execution matrix

Every result below is **NOT RUN**.

| ID | Physical test | Required evidence / pass rule |
|---|---|---|
| HW-01 | Managed install/update of SAME package | Correct trusted signing identity/version; no second app; existing device registration retained. |
| HW-02 | Password/PIN login and device policy | Real permitted worker/station; inactive/unregistered/other-worker device refused by server. |
| HW-03 | Zebra physical side trigger + DataWedge | Correct action/category/data/symbology; foreground only; no keystroke+intent double delivery. |
| HW-04 | Zebra software START/STOP trigger | Real profile supports command; timeout/cancel/manual fallback when no result; no assumed decode. |
| HW-05 | Honeywell claim/release and physical trigger | Scanner claims on RESUME/releases on PAUSE/dispose; resumes repeatedly without dead receiver. |
| HW-06 | Camera permission/unavailable/no camera | Denied/revoked/no-camera states explicit; hardware/manual still usable; no false success. |
| HW-07 | Valid 1D/2D/QR/GS1 and manual | Exact identity and true source retained where API supports source; no OCR substitution. |
| HW-08 | Rapid different labels and held/repeated label | No queued duplicate writes; held label stays suppressed; explicit next item can share SKU. |
| HW-09 | Damaged/low contrast/glare/noisy/unknown label | Failed decode is not business receipt; meaningful retry/manual feedback; multiple visible labels require isolation. |
| HW-10 | Wrong arrival/carton/shipment/product | Expected/scanned/reason readable; no acceptance on identification/refusal. |
| HW-11 | Correct/invalid/inactive/wrong-type tote | Server validates ACTIVE RECEIVING tote; unit ends up in confirmed tote. |
| HW-12 | Reused received carton and same-SKU next unit | No second carton count; exactly one ArticleUnit per explicit unit confirmation. |
| HW-13 | Quantity 0/negative/decimal/1/2/overflow | Invalid/bulk values blocked; no N-request loop; one unit creates one physical record. |
| HW-14 | Condition problem and discrepancy authority | No false reject/restock/quarantine; real flag/reason; unauthorized resolution/variance close denied. |
| HW-15 | Network loss before request | No stock write/outbox; OFFLINE and server authorization requirement explicit. |
| HW-16 | Network loss after POST dispatch | Hold/reconcile, no retry; verify DB/tote/audit against physical item before continuing. |
| HW-17 | App kill before dispatch/after POST/after response | Marker durable; no replay on restart; confirmed receipt not repeated after GET failure. |
| HW-18 | Background/resume, lock/unlock, interruptions | No background capture; context/permissions refreshed; no leaked receiver/camera; current task recoverable. |
| HW-19 | Auth expiry/revocation/role removal mid-task | Scanning/actions blocked; no new-login token reuse by previous request; journal preserved. |
| HW-20 | Logout/next worker/unresolved previous task | Stable device code; private recovery details not exposed to next worker; no fallback replay. |
| HW-21 | Long name/SKU/location, big quantities, 150–200% fonts | Critical codes/actions readable and reachable; no overlap/cropping; system bars/IME do not hide confirmation. |
| HW-22 | Gloves/one hand/bright-dark conditions/TalkBack | 56/64dp controls usable, text+indicator+tone, safe focus order; sound is supplemental. |
| HW-23 | Sustained receiving workload | Record actual duration/attempts/failures/latency/thermals/battery; no invented performance claim. |
| HW-24 | Approved pause/resume/complete/rollback drill | Server and physical stock reconcile; no client switch while mutation unresolved; audit retained. |

## Method and acceptance

Use an approved staging warehouse/backend and physically labeled test stock. For each case, retain sanitized operation/request IDs, server result, ArticleUnit/tote/session/audit evidence, device logs excluding credentials, operator observations and defects. Keep large evidence/videos/APKs outside Git and link immutable hashes/locations.

Block expansion if a trigger drops/repeats commands, counts diverge, wrong location/product is accepted outside policy, roles bypass server enforcement, encrypted recovery is lost, or controls are unsafe in the target environment. Missing hardware evidence is itself a gate failure, not “not applicable.”

Backend missing condition/bulk/idempotency contracts constrain any Receiving pilot. Explicitly record that scope; do not mark the complete receiving acceptance path PASS when those cases cannot be performed.

Hardware owner: **UNASSIGNED** · Execution date: **PENDING** · Warehouse acceptance: **NOT SIGNED** · Release approval: **NOT AUTHORIZED**.

## v1.4.1 additional CT40 checks (physical: NOT RUN)

Verify WHITE and BLACK modes on the actual CT40 under warehouse illumination, including system bars, glare, contrast, glove operation, 150–200% fonts and keyboard visibility. Confirm theme changes do not recreate/lose the task, scanner or pending receipt. Verify Carton → next carton, Produit selection with confirmed source/tote, bad carton then mode switch, closed tote revalidation, busy/offline/paused/expired states, acknowledgement/unknown-result holds and Back/task-action menu focus.

Automated emulator UI/crypto checks now run on native push/PR builds. Their 720×1280 / density 320 configuration is a **360dp test viewport**, not a statement of CT40 hardware specifications. Native screenshots use clearly labelled UI TEST FIXTURE data; they are not live warehouse data or a physical acceptance certificate. See report15 for the executed outcome.

## Device-aware update evidence

Phone/CT40 renderers and the existing Honeywell intent adapter were exercised by native emulator tests, including synthetic broadcast-driven receiving through completion. Nineteen Android cases passed; ten fixture screenshots were collected. This does not change the **NOT RUN** physical results above. Actual trigger-down/claim acknowledgement, scanner profile/decoder tones, display/gloves, live station assignment and DB stock effects still require the target CT40. Full A–O report: [device-aware-receiving-report.md](device-aware-receiving-report.md).
