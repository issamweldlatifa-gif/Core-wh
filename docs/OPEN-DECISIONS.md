# AYROVI Warehouse Core — Phase 0 — Open Decisions Log

> Per the Phase 0 charter: *"إذا وجدت قرارًا معماريًا غير محسوم، توقف وسجّله كـ
> Open Decision بدل افتراضه."* (If you find an unresolved architectural
> decision, STOP and record it as an Open Decision instead of assuming.)

Every item below is either **RESOLVED** (agreed in this handoff) or **OPEN**
(needs a decision before the next phase). All decisions are recorded rather
than silently assumed, so nothing is baked in accidentally.

---

## A. Resolved decisions (already agreed)

| ID | Decision | Resolution |
|----|----------|------------|
| D-01 | Backend stack | **Node.js + TypeScript + NestJS** (Modular Monolith). |
| D-02 | Frontend stack | **React + TypeScript + Vite**. |
| D-03 | ORM / DB access | **Prisma** on **PostgreSQL**. |
| D-04 | Auth mechanism | Self-hosted **JWT Access + Refresh tokens**, Password/PIN hashing, session/revocation support. No third-party OAuth at this stage. |
| D-05 | RBAC | Dynamic DB-driven **Roles + granular Permissions**. Roles are NOT hard-coded into business logic. |
| D-06 | API style & versioning | **REST**, routes under **`/api/v1`**. |
| D-07 | Validation | **DTO + class-validator / class-transformer**, global ValidationPipe. |
| D-08 | Docs | **OpenAPI / Swagger** at `/api/docs`. |
| D-09 | Tests | **Jest + Supertest**. |
| D-10 | Deployment | Render-friendly but **portable**; **Docker-ready**. |
| D-11 | Architecture | **Modular Monolith** — modules communicate via services / internal event bus, never by reaching into another module's tables. |

## B. Assumed (low-risk defaults chosen in Phase 0 — call out if you disagree)

| ID | Assumption | Notes |
|----|-----------|-------|
| A-01 | `credentialMode` supports PASSWORD / PIN / BOTH | The User schema supports numeric PIN for floor workers (PDA), separately from password. |
| A-02 | `permission` shape is `resource.action` (e.g. `locations.manage`) | Matches the permission catalog in the spec. |
| A-03 | `AuditAction` enum includes operational placeholders (ITEM_RECEIVED, ORDER_PACKED, …) | Defined now for forward-compat but **never emitted** in Phase 0. |
| A-04 | A minimal `warehouses` table exists in Phase 0 | Only identification/config of the managed warehouse — **not** an operational workflow. |

## C. OPEN DECISIONS (must be resolved before/as the next phase begins)

| ID | Question | Why it matters | Suggested options |
|----|----------|----------------|-------------------|
| D-20 | **Multi-warehouse support?** | Does the system manage a single physical warehouse or several (e.g. main + satellite)? Affects whether `warehouse_id` becomes a mandatory FK on every operational row in Phase 1+. | (a) Single-warehouse now, add `warehouse_id` when needed; (b) Multi-warehouse from day one. |
| D-21 | **Rate limiting store** | Phase 0 uses an in-memory limiter (per-instance). In multi-instance production, how is brute-force protection shared? | (a) Introduce Redis; (b) use a DB-backed counter; (c) accept per-instance for single-process Render. |
| D-22 | **Database configuration migrations** | Where are non-Postgres config values (tax, units, currencies) stored? Phase 0 seeds nothing; `system_settings` is available. | (a) DB `system_settings`; (b) env-only; (c) hybrid. |
| D-23 | **Refresh token rotation & reuse detection** | Phase 0 rotates on refresh but does not detect reuse of an old (already-rotated) token. Define the anti-reuse policy. | (a) Detect reuse → revoke whole session; (b) ignore. |
| D-24 | **Production domain / subdomain** | Spec says *not final*. Confirm `warehouse.ayrovi.com` (or alternative) before wiring CORS, HTTPS and env. | TBD. |
| D-25 | **Machine-to-machine / API Clients auth** | `api_clients` schema exists; no auth flow is wired. Decide the grant type (client-credentials) and when to enable it. | (a) Client-credentials JWT under `/api/v1/auth/client`; (b) defer. |
| D-26 | **Audit log retention / partitioning** | `audit_logs` grows over time. Decide retention, archival, and whether to partition by time. | (a) Partition by month; (b) simple index + retention job. |
| D-27 | **User deletion semantics** | Phase 0 soft-disables users (prevents data loss). Decide whether hard-delete is ever allowed. | (a) Soft-disable only (current); (b) hard-delete for non-system users with audit. |
| D-28 | **Email / password reset** | Is password recovery via email in scope for the internal staff app, and via what provider? | TBD — no email provider wired in Phase 0. |
| D-29 | **Employee code format** | Phase 0 seeds `ADMIN001`; the format is loosely validated (`[A-Za-z0-9._-]+`). Confirm the canonical format / whether it's auto-generated. | TBD. |

---

### How to use this log

- Before starting **Phase 1 — Warehouse Foundation & Physical Structure**, review
  section **C**. Anything still **OPEN** that affects Phase 1 data model must be
  answered first.
- Any new decision encountered during building should be added here rather than
  silently decided in code.

---

## D. PHASE 1 — DECISIONS (all RESOLVED by the Phase 1 Approval; recorded here for traceability)

| ID | Question | Decision (approved) |
|----|----------|---------------------|
| D-30 | Location Code format | **LOCKED**: `{WAREHOUSE}-{ZONE}-{AISLE}-{RACK}-{LEVEL}`, uppercase, hyphen-separated, auto-derived from the parent chain, read-only and stable after operations begin. Example: `TUN-MAIN-SHOES-A01-R02-L03`. |
| D-31 | Primary key naming | **Keep UUID `id`** across the codebase; business `code` fields remain the human/business identifiers. |
| D-32 | Phase-0 warehouse status & legacy permissions | Migrate `OPERATIONAL → ACTIVE`; migrate legacy `warehouse.view/manage` and `locations.*` into the new granular permission model and re-map roles **idempotently** (safe to re-run; legacy keys removed only after successful re-mapping). |
| D-33 | Barcode value | **`barcodeValue = locationCode`** by default; no hashing. Must remain unique and stable. |
| D-34 | WAREHOUSE_MANAGER create access | **NO create**. Only `view`, `update`, `activate`, `deactivate` on the physical structure. |
| D-35 | Hard deletion | **No hard delete in Phase 1.** Use deactivation/status management; preserve historical records. |
| D-36 | Level code | Auto-derived from `levelNumber` (`1→L01`, `2→L02`, …). |
| D-37 | Bulk structure generation | **Deferred**; domain kept extensible for future bulk creation. |
| D-38 | Company entity | **Deferred.** Warehouse remains the top-level entity of this module. Company/CRM relationship defined later during integration architecture. |

> D-20 (Multi-warehouse) is now **RESOLVED as "Multi-warehouse from day one"** — every physical node carries an explicit `warehouseId`, and zone codes are unique per warehouse.

---

## E. PHASE 2 — DECISIONS (Product & Order Item Identity Foundation)

> Design proposal: `docs/PHASE-2-DESIGN-PROPOSAL.md` (§26). D-40 → D-43 were
> approved **individually** during the design-review session; D-44 → D-59
> were approved as a **single batch** closing the comprehensive architectural
> review — with explicit rulings: D-50 = Phase-3 prerequisite · D-53 = format
> locked (`PI-XXXXXXXX`) · D-55 = immutable product identity · D-56 =
> **Option B (content-aware idempotency)** · D-57 = **strict cap**. Nothing
> was resolved silently or advanced automatically.
> **This approves the DESIGN only — implementation requires a separate,
> explicit order.**

| ID | Question | Decision |
|----|----------|----------|
| D-40 | **Product Identity** | **✅ APPROVED (Phase 2 Design Review).** A Product in Warehouse Core is identified by **`(store, externalProductCode)`** — the combination must be UNIQUE. `SHEIN + 12345678 = Product A` and `TEMU + 12345678 = Product B` are **different Product records** even when the external code is identical. Approved requirements: (1) the external product identity remains **stable**; (2) Warehouse Core is **NOT** responsible for the external stores' complete product catalogs; (3) **NO** pricing, customer-facing catalog logic, product marketing data, or store scraping in Phase 2; (4) the Product entity is suitable for future data ingestion from **OCR, CRM/order systems, external integrations, and future import services**; (5) Warehouse Core remains the **operational source of truth** for warehouse-side product identity; (6) Warehouse Core database tables are **NOT directly coupled** to CRM or OCR — future external systems communicate through defined **API/integration boundaries**; (7) the existing Phase 0/1 **modular-monolith architecture is preserved**; (8) implementation is **not started yet**. |
| D-41 | **WarehouseOrder as lightweight CRM projection** | **✅ APPROVED (as proposed, without modification).** الشروط المعتمدة حرفياً: • WarehouseOrder يبقى **Lightweight Projection** داخل Warehouse Core، وليس نسخة ثانية من CRM. • `externalOrderReference` يكون **UNIQUE** ويمثل المرجع الخارجي المستقر للطلب، ويُستخدم كأساس للـ idempotency. • `externalCustomerReference` يبقى مجرد **مرجع خارجي للحريف**، وليس Customer Record داخل Warehouse Core. • `source` = ADMIN / CRM / OCR / API. • `status` في Phase 2 = OPEN / CANCELLED. • `warehouseId` يبقى اختيارياً إلى حين حسم **D-50**. • `note` مسموح كملاحظة تشغيلية للمستودع. • **لا تُخزّن** داخل WarehouseOrder بيانات الحريف الكاملة (الاسم، العنوان، الهاتف، المحادثات، المدفوعات، البيانات التسويقية أو أي CRM profile). • **CRM / نظام الطلبات الخارجي يبقى صاحب البيانات الأصلية** للحريف والطلب. • أي حاجة مستقبلية لبيانات الشحن أو عنوان الحريف في Packing/Shipping تُحل عبر **API/integration boundary** في المرحلة المناسبة، ولا يُكسر D-41 بإعادة نسخ بيانات CRM إلى Warehouse Core. • OCR مستقبلاً يمكنه إرسال مراجع الطلب والحريف والبيانات التشغيلية المطلوبة عبر API دون تحويل Warehouse Core إلى CRM. **التنفيذ مؤجّل** (لا code/schema/migration/database/deployment). |
| D-42 | **External Customer Reference only (no CRM data)** | **✅ APPROVED (as proposed, without modification).** الشروط المعتمدة حرفياً: • `externalCustomerReference` **فقط** داخل `warehouse_orders`. • **لا Customer model.** • **لا `customers` table.** • **لا Customer Record** داخل Warehouse Core. • المرجع **Opaque**: Warehouse Core لا يفسّر المرجع ولا يتحقق من وجوده في النظام الخارجي. • المرجع **String فقط**: MinLength(1)، MaxLength(120). • **Non-unique index** لأن الحريف يمكن أن يملك عدة طلبات. • **لا نفترض أي format خاص بـ CRM.** • المرجع يُستخدم **للتتبع والربط فقط**، بينما بيانات الحريف الأصلية تبقى في النظام المالك الخارجي. • **OCR وCRM مستقبلاً يتعاملان مع هذا المرجع عبر API.** • أي حاجة مستقبلية لاسم/عنوان/بيانات الشحن تُحل عبر **Integration/API Boundary** في المرحلة المناسبة، **ولا ننشئ Customer entity داخل Warehouse Core بسببها**. **التنفيذ مؤجّل** (لا code/schema/migration/database/deployment). |
| D-43 | **Unique PhysicalItem per physical piece** | **✅ APPROVED (as proposed, without modification).** الشروط المعتمدة حرفياً: • **PhysicalItem = صف مستقل لكل قطعة فعلية متوقعة.** • لكل PhysicalItem **UUID داخلي مستقل**. • **`itemCode` فريد وثابت وغير قابل للتعديل**، وتفاصيل صياغته تبقى لـ **D-53**. • كل PhysicalItem ينتمي إلى **OrderItem واحد فقط**. • **لا توجد إعادة إسناد للقطعة عبر API في Phase 2**. • `externalItemReference` **اختياري وفريد ضمن OrderItem**. • `requestedQuantity` تحدد عدد القطعات المتوقعة، **مع احترام D-57 لاحقاً**. • **لا يتم تحويل النموذج إلى inventory quantity model.** **التنفيذ مؤجّل** (لا code/schema/migration/database/deployment). |
| D-44 | Store + External Product Code namespace | **✅ APPROVED (batch review — as proposed).** `UNIQUE(store, externalProductCode)`؛ `store` موحّد بحروف كبيرة — تطبيق مباشر لهوية D-40 المعتمدة. |
| D-45 | EXPECTED as initial PhysicalItem state | **✅ APPROVED (as proposed).** `EXPECTED` الحالة الابتدائية؛ الانتقال الوحيد في Phase 2 هو `→ CANCELLED`. |
| D-46 | currentLocationId nullable until Stowing | **✅ APPROVED (as proposed).** `currentLocationId` يبقى NULL ولا يُكتب عبر أي API في Phase 2. |
| D-47 | Operational state transitions deferred | **✅ APPROVED (as proposed).** كل الانتقالات التشغيلية مؤجلة لمراحلها؛ حارس Phase 2 يرد **409** على أي انتقال لا يملكه. |
| D-48 | `productType` representation | **✅ APPROVED (as proposed).** نص حر الآن؛ تصنيف مضبوط لاحقاً فقط إذا طلبت الفلترة ذلك فعلياً (migration إضافية). |
| D-49 | Customer display-name snapshot | **✅ APPROVED.** «لا يتم تخزين اسم الحريف أو أي PII داخل Warehouse Core. يبقى `externalCustomerReference` فقط، وأي عرض مستقبلي لبيانات الحريف يكون عبر API boundary.» |
| D-50 | Order↔warehouse binding | **✅ APPROVED.** «`warehouseId` يكون اختيارياً عند إنشاء WarehouseOrder. لكن يصبح **إلزامياً قبل تنفيذ أول Receiving في Phase 3**. سُجّل كـ **prerequisite واضح لـ Phase 3** حتى لا يُنسى» (قسم «Phase 3 prerequisites» في وثيقة التصميم). |
| D-51 | External reference policies | **✅ APPROVED (as proposed).** «المراجع الخارجية للسطر/القطعة **اختيارية**، و**فريدة ضمن الأب** عند وجودها، مع **توصية إلزامية** للمصادر التكاملية بإرسالها دائماً.» |
| D-52 | Exceptional PhysicalItem states | **✅ APPROVED (as proposed).** «لا MISSING/LOST/DAMAGED في Phase 2. **CANCELLED فقط** للحالات الاستثنائية الحالية.» |
| D-53 | Human piece label | **✅ APPROVED (as proposed).** «`itemCode` بصيغة **PI-XXXXXXXX**، فريد وثابت وغير قابل للتعديل، **ولا يكون Primary Key**. UUID يبقى الهوية الداخلية. لا نفتح نقاشاً جديداً حول صيغة itemCode في هذه المرحلة.» |
| D-54 | WarehouseOrder terminal states | **✅ APPROVED (as proposed).** «WarehouseOrder في Phase 2 يحتوي **OPEN/CANCELLED فقط**. لا COMPLETED أو حالات fulfillment أخرى الآن.» |
| D-55 | Mutability of `store` / `externalProductCode` | **✅ APPROVED (immutable).** «`store` + `externalProductCode` هما هوية المنتج **وثابتان بعد الإنشاء**. لا يُسمح بتعديلهما. إذا اكتُشف خطأ، يتم **deactivate للسجل الخاطئ وإنشاء سجل صحيح جديد مع Audit**. هذا ينطبق أيضاً على أخطاء OCR.» |
| D-56 | Duplicate `externalOrderReference` behavior | **✅ APPROVED — OPTION B.** «عند إعادة إرسال نفس `externalOrderReference`: **إذا كان المحتوى متطابقاً → 200 idempotent replay. إذا كان المحتوى مختلفاً → 409 Conflict.** لا يتم تجاهل اختلاف المحتوى بصمت. تُستخدم **آلية واضحة لمقارنة محتوى الطلب/payload بما يكفي لاكتشاف الاختلاف** (التنفيذ التصميمي: hash كانوني SHA-256 مخزّن في `contentHash` — §17 من وثيقة التصميم). **التصحيح بعد ذلك يتم عبر مسار تحديث صريح ومُدقّق.** مهم جداً: *لا نريد Replay أعمى يخفي تصحيحاً أو تغييراً في طلب موجود.* |
| D-57 | Piece-count cap vs `requestedQuantity` | **✅ APPROVED — STRICT CAP.** «`requestedQuantity` هو **السقف الصارم** لعدد PhysicalItems. لا يمكن إنشاء PhysicalItems أكثر من `requestedQuantity`. إذا احتجنا زيادة، يجب **أولاً تنفيذ تحديث صريح ومُدقّق** لـ `requestedQuantity`، ثم إنشاء القطع الإضافية. **لا يوجد تجاوز صامت أو warning-only.**» |
| D-58 | Duplicate lines without `externalLineReference` | **✅ APPROVED (as proposed).** «**السماح** بتكرار نفس Product داخل نفس WarehouseOrder عندما لا يوجد `externalLineReference`. **لا نفرض `UNIQUE(orderId, productId)`**، لأن ذلك قد يمنع أسطر طلب شرعية.» |
| D-59 | `OrderSource` values & extension policy | **✅ APPROVED (as proposed).** «OrderSource في Phase 2: **ADMIN / CRM / OCR / API**. أي مصدر جديد مستقبلاً يحتاج **قراراً صريحاً وmigration مناسبة**.» |
| D-64 | **External Reference Normalization** | **✅ APPROVED (Option A — Point #5 review).** الشروط المعتمدة حرفياً: • `store`: سياسة D-44 القائمة تبقى «**trim + UPPERCASE**». • `externalProductCode`: «**trim + UPPERCASE**». • `externalOrderReference`: «**trim + UPPERCASE**». • `externalCustomerReference`: «**trim + UPPERCASE**». • `externalLineReference` / `externalItemReference`: «**trim-only**». التوحيد يُطبَّق على حافة الـ DTO، فتضرب التصادمات المختلفة-بالحالة-فقط قيود C1/C2 بالشكل الكانوني → **409** مع id الموجود، وتدخل إعادة-الإرسال المختلفة-بالحالة مقارنة D-56B طبيعياً — **لا كيان ثانٍ أبداً**. **التنفيذ مؤجّل** (لا code/schema/migration/database/deployment). |
| D-65 | **contentHash Lifecycle — living hash** | **✅ APPROVED (Option A1 — Point #6 review).** الشروط المعتمدة حرفياً: • `contentHash` **هاش حيّ** يمثّل **المحتوى الفعّال الحالي** المملوك-للمصدر. • **يُعاد حسابه داخل نفس المعاملة** عند كل تعديل مؤثر بالمحتوى: `POST /warehouse-orders/:orderId/items` · `PATCH /order-items/:id` (تغيير الكمية) · `POST /order-items/:id/cancel` · إنشاء قطعة ذات `externalItemReference` · `POST /physical-items/:id/cancel` — **بالإضافة إلى** PATCH الطلب (المعتمد أصلاً). • **الأسطر الملغاة تُستبعد** من الشكل الكانوني. • **باقي التركيبة كما اعتُمدت في D-56B دون إعادة تصميم.** إعادة إرسال مطابقة للمحتوى الفعّال الحالي → 200؛ بالمحتوى القديم → 409 `ORDER_CONTENT_CONFLICT` — في الاتجاهين، عبر عمر الطلب كاملاً. المراجع تُوحَّد-بالحالة (D-64) قبل الهاش/المقارنة. **التنفيذ مؤجّل** (لا code/schema/migration/database/deployment). |
