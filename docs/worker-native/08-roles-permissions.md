# 08 · Roles, permissions and session security

**Status:** source-audited and native visibility/guard code implemented; live role/device tests and production sign-off **PENDING**. A role label is never an authorization check.

## Authority and surface separation

Sources: `backend/prisma/seed.ts`, `modules/access/application-access.ts`, JWT strategy, global permission/application guards, `operations/terminal.service.ts`, Receiving/Fulfillment/Putaway controllers and services. See [03](03-api-contracts.md) for endpoint-level requirements.

- The backend constructs current permissions from database roles on **every authenticated request**. A stale native screen cannot grant permission.
- Role `applicationClass`: ADMIN or VIEWER → ADMIN_WEB; OPERATIONAL → WORKER_NATIVE; UNKNOWN → no inferred access. Multiple roles can form a union. Administrator authority alone does not imply Worker login.
- Native context/assignments require WORKER_NATIVE. Several physical-operation endpoints are surface-neutral but permission-guarded. Do not misreport these as native-only.
- The client requires an authenticated native identity, `allowedApplications` containing WORKER_NATIVE, matching context worker ID, and the backend task's `ready`/`permission` fields. Receiving also requires its read permission.
- `readyTaskCount` is the number of available modules. It is not a workload, progress or assignment count.

## Seed roles are examples, not hardcoded UI branches

| Seed role | Application class | Relevant baseline permissions | Native migration behavior |
|---|---|---|---|
| INBOUND_WORKER | OPERATIONAL | Receiving view/execute; stowing view/execute; structure/inventory read | Receiving pilot only when context authorizes it. Other workflows stay in approved legacy terminal. No discrepancy-resolution assumption. |
| PICKER | OPERATIONAL | Picking view/execute, inventory/structure read | Existing order-sorting permission is not a directed-pick contract. No invented Picking UI/tasks. |
| PACKER | OPERATIONAL | Packing view/execute, read context | Packing remains frozen; not silently replaced with Receiving. |
| SUPER_ADMIN, WAREHOUSE_ADMIN | ADMIN | Broad permissions including operational/admin capabilities | ADMIN_WEB unless an operational role additionally grants native surface. |
| WAREHOUSE_MANAGER | ADMIN | Operational execute + discrepancy resolution/corrections, without all structural creation | Not automatically a native supervisor account. |
| VIEWER | VIEWER | Read-only permissions | Admin surface; no native mutation route. |
| Custom/unknown | Backend-defined | Read current permissions/application class | Deny unsupported/unknown access; do not infer from a name such as “Supervisor.” |

Do not alter seeds or grant roles to make a demo work. Provision separate staging identities using the existing Admin process.

## Action matrix

| Action | Required server authority | Native pilot behavior |
|---|---|---|
| Sign-in/device binding | Auth service application/account/device checks | Stable displayed device code; password/PIN entry; no device-attestation claim. |
| View own context/assignments | Native surface; assignments self-scoped | Display server rows only. Instruction DONE does not finish a stock operation. |
| Read Receiving/containers | `receiving.view` | Read online; no offline permission cache treated as authority. |
| Start, identify/receive carton, receive article, pause/resume, report exception | `receiving.execute`; read permission needed to render safely | Explicit stage/busy/online guards; backend still enforces each request. |
| Complete without variance | `receiving.execute` | Fresh server review then completion request. |
| Resolve discrepancy / complete with variance | `receiving.resolve_discrepancy` in addition to relevant execution | Only offer resolution when permitted. Server checks again. A color or job title grants nothing. |
| Formal reject/condition disposition | **No contract** | No rejection/quarantine/restock buttons pretending to work. Exception report is not a disposition. |
| Putaway/storage | Existing `stowing.view` / `stowing.execute` | Strict destination/override contracts must be resolved before new lane. |
| Order-sorting | Existing `picking.execute` | Preserved legacy behavior; not relabeled as location→SKU→quantity Picking. |
| Inventory count, return/disposition, offline stock replay | **No approved workflow contract** | No grant inferred from broad inventory/admin permissions. |

## Session implementation

One application-scoped secure store/client. EncryptedSharedPreferences uses Android Keystore; storage initialization fails closed. Old raw access/refresh/employee entries are purged, **not imported** as credentials; a non-secret legacy device code is migrated only without conflicting identities. No plaintext fallback, password persistence, token logs, backup or cleartext HTTP.

A token `version` implements CAS rotation; an `identityVersion` distinguishes a new login/logout from rotation within the same identity. Concurrent 401s use one refresh. Requests from a previous login cannot retry using a new worker's tokens; a late successful write remains ambiguous and its journal is retained. Logout clears the corresponding local identity before network dispatch (so process death cannot defer local sign-out), even when remote revocation fails, preserves device identity/recovery marker, and warns when server revocation was unconfirmed.

Foreground/resume and periodic online context reads refresh permissions. Mutations stop while context is unverified. Network availability alone does not restore authority. Core guards do not replace backend guards.

## Gaps and required negative tests

BC-04: backend Receiving lacks owner/takeover scope and atomic start. BC-05: refresh token stored-hash verification/atomic consumption and stronger device policy remain backend security work. Device manufacturer/model or an exported scanner broadcast is not attestation.

Mandatory live tests: incorrect password/PIN; inactive worker; wrong application; unregistered/disabled/differently assigned device; revoked access/refresh; role removed mid-task; unauthorized direct API POST despite hidden UI; another worker's assignment; supervisor missing resolution capability; logout offline; logout/refresh race; next worker encountering an unresolved operation. Record backend revision, actor permission set and response/effects, without credentials. No such live matrix is certified yet.
