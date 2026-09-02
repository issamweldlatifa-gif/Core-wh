# AYROVI WAREHOUSE — FULL DISCOVERY & AUDIT REPORT
**تقرير الاستكشاف والتدقيق الشامل — قراءة فقط (READ-ONLY)**

- Repository: `https://github.com/issamweldlatifa-gif/Core-wh.git`
- Audited commit: `c50342e` — "fix(prod): in-process schema self-repair at app entrypoint" (HEAD الحالي)
- Audit date: 2026-09-02 (محدَّث بعد commits eceec62 و c50342e)
- Rule applied: **كل ادعاء مدعوم بدليل من الكود (ملف + سطر). أي شيء لا دليل عليه يُكتب: `UNKNOWN — EVIDENCE NOT FOUND`. لا اقتراحات، لا إصلاحات، لا اختراع Workflows.**

---

## 1. Executive Summary — الملخص التنفيذي

المشروع هو **نظام إدارة مستودع (Warehouse OS)** باسم AYROVI Warehouse Core، مبني كـ **Modular Monolith**: NestJS 10 + Prisma 5 + PostgreSQL في الخلفية، React 18 + Vite 7 SPA في الواجهة، بهوية بصرية "Terminal" (أسود/أخضر فسفوري/خط Mono).

**ما هو حقيقي وشغّال فعلاً (مثبت بالكود والاختبارات):**
- المصادقة (JWT + Refresh + PIN/Password)، RBAC كامل (7 أدوار، ~60 صلاحية granular).
- البنية الفيزيائية الكاملة للمستودع: Warehouse → Zone → Aisle → Rack → Level → Location (CRUD + تفعيل/تعطيل).
- استقبال بطاقات CRM عبر API خارجي (Expected Arrivals + Shipments + Cartons) بمصادقة `x-api-key` و idempotency.
- **Receiving Workflow كامل**: جلسات، مسح كراتين (كاميرا/مسدس/يدوي)، عد وحدات المنتجات، توقف/استئناف، Discrepancies، إغلاق.
- **Putaway Workflow كامل**: طابور كراتين RECEIVED، مسح كرتونة + موقع، سجل حركة append-only (CartonPlacement).
- **Admin Control Center**: Overview، Workers، Sessions drill-down، Stations، Exceptions، Corrections مدقّقة (before/after snapshots).
- Audit Log شامل (110+ نوع حدث معرّف، والتسجيل فعلي داخل نفس الـ transactions).

**ما هو هيكل بدون Workflow (Schema/صلاحيات فقط):**
- Products / WarehouseOrders / OrderItems / PhysicalItems — الجداول والصلاحيات موجودة، **لا يوجد أي Controller أو Service أو شاشة** لها.
- Sorting و Packing — مسجّلان في TASK_REGISTRY بـ `ready: false` بلا Route وبلا شاشة.
- Picking / Shipping / Returns / Inventory counting — صلاحيات seed فقط، لا كود.

**لا يوجد**: WebSocket/Realtime حقيقي، نظام إشعارات، تكامل شحن فعلي، مفهوم "Card" داخلي (البطاقات تأتي من CRM خارجي فقط)، أي صور/أصول ثابتة في الريبو.

الحكم الإجمالي: **قاعدة إنبوند (Receiving → Putaway) مكتملة وحقيقية ومختبرة (38 unit + 49 e2e ناجحة)؛ كل ما بعد التخزين (Picking/Packing/Shipping) غير موجود بعد** — وهذا موثّق داخل الكود نفسه كقرار مقصود (Phase-based).

---

## 2. Repo & Architecture — بنية المشروع

**الأرقام:** 244 ملف مُتتبَّع في git، ~15,656 سطر TypeScript/TSX. لا توجد ملفات صور/أصول ثنائية إطلاقاً (`git ls-files | grep -iE '\.(png|jpg|svg|...)'` → صفر نتيجة).

```
Core-wh/
├── backend/                  NestJS 10.4 + Prisma 5.22 (PostgreSQL)
│   ├── prisma/schema.prisma  1,301 سطر — 30 model، 30+ enum
│   ├── prisma/seed.ts        صلاحيات + 7 أدوار + بنية TUN-MAIN + محطات + عاملَين
│   ├── src/modules/          auth, users, roles, permissions, warehouse(6 موارد),
│   │                         expected-arrivals, shipments, receiving, putaway,
│   │                         operations(stations/terminal/corrections), audit, system
│   ├── src/integrations/crm/ بوابة CRM (x-api-key) — customer-cards + shipment-cards
│   ├── src/events/           EventEmitterModule — بنية جاهزة، "no workflow events yet"
│   └── public/               نسخة build من الواجهة (تُقدَّم كـ SPA من نفس الخادم)
├── frontend/                 React 18.3 + Vite 7 + react-router-dom 7
│   ├── src/App.tsx           كل الـ Routes (انظر §3)
│   ├── src/shell/            GlobalShell (هيدر عام + nav بالصلاحيات)
│   ├── src/terminal/         Worker Terminal (WorkerShell, ReceivingTask, PutawayTask)
│   ├── src/admin/            Admin Control Center (6 صفحات)
│   ├── src/modules/          warehouse(7 شاشات), expected-arrivals, receiving api,
│   │                         receiving-terminal (scanner + OCR + feedback)
│   └── src/styles/           os-theme.css + index.css (نظام التصميم)
├── docker/nginx.conf         proxy /api → backend:3000
├── docs/                     ARCHITECTURE, PHASE-1/2 proposals, WAREHOUSE-OS-STATUS,
│                             RECEIVING-TERMINAL, OPEN-DECISIONS, REPAIR-REPORT
├── build.sh / start.sh       بناء وتشغيل Render (migrate deploy + فحص drift ذاتي)
└── render.yaml               تعريف خدمة Render
```

**طبقات حماية انحراف السكيما (ثلاث طبقات مستقلة — أُضيفت تباعاً بعد انقطاع الإنتاج):**
1. هجرة إصلاح معلَّقة بالسجل: `backend/prisma/migrations/20260902100000_repair_warehouse_os_drift/migration.sql` — كلها أوامر إضافية محمية (IF NOT EXISTS / duplicate_object).
2. فحص drift في `start.sh` (migrate diff + Node probe fallback → db push) — يعمل فقط إذا كان Start Command هو `./start.sh`.
3. **إصلاح ذاتي داخل التطبيق**: `backend/src/bootstrap-schema-repair.ts` (251 سطر) يُستدعى من `main.ts:17,24` قبل إقلاع Nest — probe واحد لـ 9 كائنات؛ عند النقص يطبّق 65 أمر SQL محمياً؛ لا يمنع الإقلاع عند الفشل. هذه الطبقة هي الوحيدة المضمونة التنفيذ مهما كان Start Command (وهي التي أعادت الإنتاج للعمل فعلياً).

**نمط المعمارية (دليل):**
- Global guards: `backend/src/app.module.ts:58-59` — `JwtAuthGuard` + `PermissionsGuard` كـ `APP_GUARD` (كل endpoint محمي افتراضياً إلا `@Public()`).
- كل الـ API تحت البادئة `/api` وإصدار `v1`. قائمة الـ controllers: aisles, audit, auth, expected-arrivals, integrations/arrivals, levels, locations, operations, permissions, putaway, racks, receiving, roles, shipments, stations, system, system/api-clients, terminal, users, warehouses, zones.
- Event bus: `backend/src/events/events.module.ts:11-12` — نصياً: *"Phase 0: no workflow events are emitted yet — the infrastructure is what we are shipping"*. grep على `emit(` في `src/` لا يُظهر أي إصدار حدث فعلي خارج تعريف الموديول. **البنية موجودة، الاستخدام صفر.**

---

## 3. Complete Screen Inventory — جرد الشاشات الكامل

المصدر الوحيد للـ routes: `frontend/src/App.tsx` (كامل الملف). الحالة: **Complete / Partial / Mock / Missing**.

| # | الشاشة | Route | الغرض | المستخدم | البيانات (API) | الحالة |
|---|--------|-------|-------|----------|----------------|--------|
| 1 | Login | `/login` | دخول برمز موظف + كلمة سر/PIN | الجميع | `POST /v1/auth/login` (`identifier`/`secret`) | **Complete** — `pages/Login.tsx` |
| 2 | Dashboard | `/` | مراقبة + تنقّل، محتوى حسب الدور (Admin/Worker) | الجميع | `terminalApi.context()` أو `adminApi.overview()` | **Complete** — `pages/Dashboard.tsx:21-25` يقسم حسب `operations.view` |
| 3 | Profile | `/profile` | هوية المستخدم وصلاحياته | الجميع | `GET /v1/auth/me` | **Complete** — `pages/Profile.tsx` |
| 4 | Worker Terminal Home | `/terminal` | موجّه مهام العامل (§3): استئناف > مهمة واحدة > اختيار | العامل | `GET /v1/terminal/context` | **Complete** — `terminal/WorkerTerminalHome.tsx:25-29` |
| 5 | Receiving Task | `/terminal/receiving` | مساحة الاستلام الكاملة (مسح/عد/استثناءات/إغلاق) | INBOUND_WORKER+ | 12 endpoint تحت `/v1/receiving/*` | **Complete** — `terminal/ReceivingTask.tsx` (521 سطر) |
| 6 | Putaway Task | `/terminal/putaway` | تخزين الكراتين المستلمة في مواقع حقيقية | INBOUND_WORKER+ | 9 endpoints تحت `/v1/putaway/*` | **Complete** — `terminal/PutawayTask.tsx` (413 سطر) |
| 7 | Control Center | `/admin` | نظرة حية: محطات/جلسات/استثناءات/مقاييس اليوم | Admin/Manager | `GET /v1/operations/overview` | **Complete** — `admin/pages/ControlCenter.tsx` |
| 8 | Workers | `/admin/workers` (+`/:id`) | العمال ونشاط اليوم + drill-down | Admin/Manager | `GET /v1/operations/workers[/:id]` | **Complete** — `admin/pages/Workers.tsx` |
| 9 | Session Detail | `/admin/sessions/:id` | تفكيك جلسة + timeline + تصحيحات | Admin/Manager | `GET /v1/operations/sessions/:id` | **Complete** — `admin/pages/SessionDetail.tsx` |
| 10 | Stations | `/admin/stations` | سجل المحطات: إنشاء/تعيين عامل/تغيير حالة | Admin | `GET/POST /v1/stations`, `/:id/assign`, `/:id/status` | **Complete** — `admin/pages/Stations.tsx:21-119` |
| 11 | Exceptions | `/admin/exceptions` | مركز الاستثناءات (discrepancies) + حل مدقّق | Admin/Manager | `GET /v1/operations/exceptions` | **Complete** — `admin/pages/Exceptions.tsx` |
| 12 | Corrections | `/admin/corrections` | سجل التصحيحات المطبقة (before/after) | Admin/Manager | `GET /v1/operations/corrections` | **Complete** — `admin/pages/Corrections.tsx` + `CorrectionDialog.tsx` |
| 13 | Expected Arrivals | `/expected-arrivals` | بطاقات الوصول القادمة من CRM + تفاصيل | من له `expected_arrivals.view` | `GET /v1/expected-arrivals[/:idOrCode]` | **Complete** — `modules/expected-arrivals/ExpectedArrivals.tsx:34,52` |
| 14 | Structure Explorer | `/warehouse/structure` | شجرة البنية الفيزيائية | من له `warehouses.view` | endpoints البنية الست | **Complete** — `modules/warehouse/StructureExplorer.tsx` |
| 15–20 | Warehouses/Zones/Aisles/Racks/Levels/Locations | `/warehouse/{...}` | CRUD لكل مستوى من البنية | Admin/Manager | `/v1/warehouses`, `/v1/zones`, ... (7+6+6+6+6+9 endpoints) | **Complete** — `modules/warehouse/*.tsx` |
| 21 | Users | `/users` | عرض + إنشاء مستخدمين | `users.view` | `GET/POST /v1/users` — `pages/Users.tsx:28` | **Partial** — الإنشاء موجود؛ التعديل موجود في API (`PATCH /v1/users/:id` في `users.controller.ts:41`) لكن **لا واجهة تعديل/تعطيل** في الشاشة |
| 22 | Roles | `/roles` | عرض + إنشاء أدوار | `roles.view` | `GET/POST /v1/roles` — `pages/Roles.tsx:27` | **Partial** — نفس الملاحظة: `PATCH /v1/roles/:id` موجود API فقط |
| 23 | Audit Log | `/audit` | آخر 100 حدث تدقيق | `audit.view` | `GET /v1/audit?take=100` — `pages/Audit.tsx:18` | **Partial** — قراءة فقط، بلا فلاتر/بحث/ترقيم صفحات في الواجهة |
| 24 | System Settings | `/system` | إعدادات + صحة + API clients | `system.view` | `GET /v1/system/settings`, `/health`, `/system/api-clients` — `pages/System.tsx:6-8` | **Partial** — عرض فقط؛ `POST settings` و إدارة api-clients موجودة API بلا واجهة كتابة |

**Redirects (ليست شاشات):** `/warehouse/receiving` و `/receiving` → `/terminal/receiving` (App.tsx:78-79)؛ `/admin/{arrivals,receiving,structure,users,roles,audit,system}` → الصفحات القديمة المكافئة (App.tsx:117-123)؛ `*` → `/`.

**شاشات مُعلنة وغير موجودة (Missing):**
- `/terminal/sorting` — في TASK_REGISTRY (`terminal.service.ts:43-49`, `ready:false`) **بلا Route وبلا component**. تظهر في مُنتقي المهام كبطاقة معطّلة "SOON" (`WorkerTerminalHome.tsx:66,75-77`).
- `/terminal/packing` — نفس الوضع (`terminal.service.ts:58-65`).
- لا توجد أي شاشة Mock (لا بيانات وهمية في أي شاشة — كل شاشة تقرأ API حقيقي).

---

## 4. Roles & Workers — الأدوار والعمال

**الأدوار السبعة كلها حقيقية ومعرّفة في `backend/prisma/seed.ts` (بلوك ROLES):**

| الدور | isSystem | خلاصة الصلاحيات (من seed.ts) |
|-------|----------|------------------------------|
| SUPER_ADMIN | ✔ | كل الصلاحيات (`permissions: ALL`) |
| WAREHOUSE_ADMIN | ✔ | بنية كاملة + Phase2 كامل + كل execute/manage + users/roles/system/api_clients manage + operations.correct + stations.manage |
| WAREHOUSE_MANAGER | ✔ | بنية: view/update/activate/deactivate **بدون create** (D-34) + execute للعمليات + operations.view/correct + stations.view **بدون stations.manage** |
| INBOUND_WORKER | ✔ | view للبنية + `receiving.view/execute` + `stowing.view/execute` + arrivals/shipments view + stations.view — **عمداً بلا `operations.*`** (تعليق صريح في seed.ts:225-228) |
| PICKER | ✔ | view للبنية + `picking.view/execute` — **لا يوجد أي workflow للـ picking، فالدور عملياً بلا مهمة قابلة للتنفيذ** |
| PACKER | ✔ | view للبنية + `packing.view/execute` — نفس الملاحظة (packing غير مبني) |
| VIEWER | ✔ | قراءة فقط لكل شيء + audit.view |

**Worker → Role → Screen → Permissions → Tasks (المسار الفعلي في الكود):**
1. Login (`auth.controller.ts:23`) → JWT يحمل الصلاحيات المجمّعة من أدوار المستخدم.
2. الواجهة تسأل `GET /v1/terminal/context` (`operations.controller.ts:37` — بلا `@RequirePermissions`, لأي مستخدم مسجّل).
3. `terminal.service.ts:80` يرشّح TASK_REGISTRY بصلاحيات المستخدم ويعيد: tasks + station + activeSession + activePutaway + resume.
4. التوجيه: عمل جارٍ → استئناف؛ مهمة واحدة جاهزة → فتح مباشر؛ عدة → picker؛ صفر → "NO TASK ASSIGNED" (`WorkerTerminalHome.tsx:25-42`).
5. حماية مزدوجة: PermissionGate في الواجهة (App.tsx:35-65) + `PermissionsGuard` في الخادم لكل endpoint.
6. قاعدة "العامل لا يرى الإدارة أبداً": App.tsx:52-56 يعيد العامل إلى `/terminal` بدل صفحة رفض.

**عمال الـ seed:** `WORKER001` (Ahmed Ben Salah, INBOUND_WORKER, معيَّن على ST-REC-01) — `seed.ts:473-500`. و `ADMIN001` (SUPER_ADMIN). **بيانات حسابات الإنتاج: UNKNOWN — EVIDENCE NOT FOUND** (حسابات مخصصة على Render لا نملكها).

---

## 5. Warehouse Structure — البنية الفيزيائية (من الكود)

التسلسل الإلزامي (schema.prisma:378-516، كل علاقة `onDelete: Restrict`):

```
Warehouse (code فريد عالمياً, مثال TUN-MAIN)
└── Zone (code فريد داخل المستودع, مثال SHOES)
    └── Aisle (code فريد داخل الزون, مثال A01)
        └── Rack (code فريد داخل الممر, مثال R01)
            └── Level (code فريد داخل الرف + levelNumber رقمي, مثال L03)
                └── Location — locationCode فريد عالمياً بصيغة
                    TUN-MAIN-SHOES-A01-R02-L03 (سطر 496: "read-only")
                    + barcodeValue (= locationCode افتراضاً, D-33) + qrValue اختياري
```

- `Location.locationType`: STORAGE | RECEIVING | SORTING | PACKING | RETURNS | QC | STAGING (سطر 365-373).
- `Location.status`: ACTIVE | INACTIVE | BLOCKED — الـ Putaway يرفض INACTIVE/BLOCKED (`putaway.service.ts` تعليق السطور 20-21 + flash `LOCATION_UNAVAILABLE`).
- سعة الموقع: `maxWeight/maxVolume/maxUnits` موجودة كـ **metadata فقط** — تعليق صريح سطر 502: *"Capacity metadata ONLY — no capacity/counting engine (deferred)"*.
- بيانات الـ seed: مستودع TUN-MAIN بزونات SHOES وCLOTHING (`seed.ts:400-441`، موسومة "TEST SEED").
- المحطات (Station, schema:1174-1205): ST-REC-01/02 (RECEIVING)، ST-SRT-01 (SORTING)، ST-PCK-01 (PACKING) — `seed.ts:452-462`. لا توجد محطة PUTAWAY في الـ seed رغم وجود القيمة في enum `StationDepartment`.

---

## 6. Tasks System — نظام المهام ودورة حياته

**المصدر الوحيد للحقيقة:** `TASK_REGISTRY` في `backend/src/modules/operations/terminal.service.ts:34-66`:

| Task | Path | Department | Permission | ready |
|------|------|-----------|------------|-------|
| receiving | /terminal/receiving | RECEIVING | receiving.execute | **true** |
| sorting | /terminal/sorting | SORTING | stowing.execute | **false** |
| putaway | /terminal/putaway | PUTAWAY | stowing.execute | **true** |
| packing | /terminal/packing | PACKING | packing.execute | **false** |

- لا يوجد جدول Tasks في قاعدة البيانات؛ "المهمة" مفهوم وقت-تشغيل = صلاحية + مسار + جلسة مفتوحة إن وجدت.
- دورة الحياة الفعلية للمهمة هي دورة حياة **الجلسة**: ReceivingSession (RECEIVING→PAUSED→COMPLETED/COMPLETED_WITH_DISCREPANCY/CANCELLED، schema:737-743) و PutawaySession (ACTIVE→PAUSED→COMPLETED/CANCELLED، schema:1122-1127).
- الاستئناف: `context()` يعيد `resume` — أحدث عمل مفتوح يفوز (receiving أو putaway).
- ملاحظة تناقض مقصود موثّق: sorting يستعمل صلاحية `stowing.execute` نفسها التي يستعملها putaway — أي عامل putaway سيرى بطاقة Sorting معطلة دائماً.

---

## 7. Cards / Orders / Packages — البطاقات والطلبات

**لا يوجد مفهوم "Card" ككيان داخلي في النظام.** كلمة Card تظهر حصراً في سياق التكامل الخارجي:
- **Customer Arrival Card**: حمولة JSON من AYROVI Arrival CRM تصل عبر `POST /api/integrations/arrivals/customer-cards` (`crm-arrivals.controller.ts:35`) وتُخزَّن كـ **ExpectedArrival** (idempotent على `customerArrivalCardId` — schema:797).
- **Shipment Card**: نفس الفكرة → **WarehouseShipment + WarehouseCarton** (idempotent على `externalShipmentId` — schema:863).

**Orders**: موديلات `WarehouseOrder`/`OrderItem`/`PhysicalItem` موجودة في السكيما (schema:607-682) بحالات Phase-2 فقط (OPEN/CANCELLED; PhysicalItem يولد EXPECTED). **لكن**: `grep prisma.product|warehouseOrder|orderItem|physicalItem` في `backend/src` → **صفر نتيجة خارج السكيما**. أي: **لا API، لا Service، لا شاشة** لهذه الكيانات. صلاحياتها موجودة في seed فقط.

**Packages/الطرود**: أقرب مفهوم هو **WarehouseCarton** (schema:939-983) وهو حقيقي ومستعمل في Receiving وPutaway. لا يوجد مفهوم طرد خروج (outbound package) — Packing غير مبني.

---

## 8. Receiving Workflow — خطوة بخطوة كما هو مطبَّق فعلاً

الملفات: `backend/src/modules/receiving/receiving.service.ts` (552 سطر)، `receiving.controller.ts` (12 endpoint)، الواجهة `frontend/src/terminal/ReceivingTask.tsx`.

1. **قائمة الوصولات** — `GET /receiving/arrivals` (`listForReceiving`, service:411) تعيد وصولات بحالة EXPECTED/RECEIVING/PAUSED.
2. **فتح/استئناف** — الواجهة تجرب `GET arrivals/:idOrCode/active` أولاً ثم `POST arrivals/:idOrCode/start` (ReceivingTask.tsx:96-104). `start()` (service:73-148): يرفض وصولاً مغلقاً، يفرض **جلسة نشطة واحدة لكل وصول**، ينشئ صفوف ReceivingProduct من بنود التوقع (SKU مفقود → NEEDS_REVIEW)، يحوّل ExpectedArrival إلى RECEIVING، يسجّل RECEIVING_STARTED، يربط بالمحطة (`resolveStationId`, service:34).
3. **مسح كرتونة** — `POST sessions/:id/scan-carton` (service:149). ثلاث قنوات إدخال تصب في مسار واحد: كاميرا (ContinuousScanner: BarcodeDetector أصلي أو ZXing fallback + OCR Tesseract محلي عند الفشل)، مسدس keyboard-wedge (تصنيف بسرعة الضغطات — ReceivingTask.tsx:222-238)، إدخال يدوي. النتائج flash: CARTON_IDENTIFIED / UNKNOWN_CARTON / DUPLICATE_CARTON / WRONG_SHIPMENT.
4. **تأكيد الكرتونة** — عند CARTON_IDENTIFIED تُرسل الواجهة تلقائياً `POST sessions/:id/receive-carton` (ReceivingTask.tsx:125-133، "auto-submit §24") مع `operationId` فريد للـ idempotency (schema:1041: `operationId @unique`). الكرتونة → RECEIVED.
5. **استلام منتجات** — `POST sessions/:id/receive-product` بSKU + كمية (service:266). SKU غير متوقع → discrepancy نوع UNEXPECTED_PRODUCT، لا يُسقط صامتاً.
6. **توقف/استئناف** — `pause`/`resume` (service:322-343) تعكس الحالة على الجلسة **وعلى ExpectedArrival** (PAUSED/RECEIVING).
7. **Flag** — `POST sessions/:id/flag` (service:345) ينشئ discrepancy يدوي (IDENTIFICATION_ERROR أو UNKNOWN_CARTON).
8. **حل الاستثناءات** — `POST discrepancies/:id/resolve` يتطلب `receiving.resolve_discrepancy` (controller:116؛ service:355 يرمي Forbidden لغير المشرف).
9. **الإغلاق** — `POST sessions/:id/complete` (service:373-408): `reconcile()` يحسب النواقص/الزيادات؛ **وجود discrepancies مفتوحة + actor بلا صلاحية المشرف → رفض 403**. الإغلاق: COMPLETED أو COMPLETED_WITH_DISCREPANCY، والوصول → RECEIVED أو RECEIVED_WITH_DISCREPANCY، والأسطر الناقصة → SHORT.
10. **تغذية راجعة**: أصوات Web Audio (feedback.ts — نجاح/خطأ/إنجاز) + اهتزاز + شريط حالة في WorkerShell footer.

كل خطوة تُسجَّل في AuditLog داخل نفس الـ transaction (أمثلة: service:138, 327, 392).

---

## 9. حالة بقية الـ Workflows

| Workflow | الحالة | الدليل |
|----------|--------|--------|
| **Receiving** | ✅ موجود كامل | §8 أعلاه |
| **Sorting** | ❌ غير موجود (هيكل فقط) | TASK_REGISTRY `ready:false`؛ لا route/شاشة/service. موثّق سبب التأجيل حرفياً في `docs/WAREHOUSE-OS-STATUS.md:268-273`: التعريف التجاري غير محسوم ("sort to zone? to carrier? to order?") |
| **Storage/Putaway** | ✅ موجود كامل | `putaway.service.ts` (395 سطر): queue (كراتين RECEIVED بلا موقع)، scan-carton، scan-location (يرفض INACTIVE/BLOCKED)، place (transaction: يغلق placement سابق بـ releasedAt ويضيف جديداً، carton → STORED + currentLocationId)، pause/resume/complete |
| **Picking** | ❌ غير موجود | صلاحيات `picking.view/execute` في seed فقط؛ صفر كود |
| **Packing** | ❌ غير موجود | TASK_REGISTRY `ready:false`؛ صلاحيات فقط؛ محطة ST-PCK-01 في seed بلا استخدام |
| **Shipping (خروج)** | ❌ غير موجود | `shipments` module هو **قراءة الشحنات الواردة فقط** (GET ×2 في `shipments.controller.ts:17,34`)؛ لا dispatch |
| **Returns** | ❌ غير موجود | لا يوجد إلا `LocationType.RETURNS` كقيمة enum |
| **Inventory (جرد/كميات)** | ❌ غير موجود | صلاحيات `inventory.view/manage` بلا أي كود؛ تعليق schema:502 يؤجل محرك السعة/العد |
| **Exceptions** | ✅ موجود (نطاق الاستلام) | ReceivingDiscrepancy + شاشة `/admin/exceptions` + `resolve-exception` المدقق (`operations.controller.ts:184+`) |

---

## 10. Data Model — خريطة النموذج والعلاقات

30 موديل في `backend/prisma/schema.prisma` (1,301 سطر):

- **Identity/RBAC**: User ↔ UserRole ↔ Role ↔ RolePermission ↔ Permission؛ Session (refresh tokens)؛ AuditLog؛ SystemSetting؛ ApiClient (secret مخزّن SHA-256 — `integration-api.guard.ts:20`).
- **البنية**: Warehouse→Zone→Aisle→Rack→Level→Location (كلها Restrict — لا حذف لعقدة لها أبناء/مخزون).
- **Phase 2 (خامل)**: Product ↔ OrderItem ↔ WarehouseOrder؛ PhysicalItem (↔ Location اختياري، لا يُكتب أبداً في هذه المرحلة — schema:667 "Phase 2 provides NO API that writes this column").
- **Inbound**: ExpectedArrival ←1:N— ExpectedArrivalItem؛ ExpectedArrival ←1:N— WarehouseShipment ←1:N (Cascade)— WarehouseCarton.
- **Receiving**: ReceivingSession (↔ ExpectedArrival Cascade، ↔ Shipment SetNull، ↔ Station SetNull) ←1:N— ReceivingCarton / ReceivingProduct (unique [sessionId, sku]) / ReceivingDiscrepancy.
- **Putaway**: PutawaySession (↔ User worker SetNull، ↔ Station SetNull) ←1:N— CartonPlacement (↔ Carton Cascade، ↔ Location **Restrict** — "موقع فيه مخزون لا يُحذف"، schema:975).
- **Corrections**: OperationCorrection — مراجع مرنة (entityType/entityId) + originalSnapshot/newSnapshot Json ثابتة (schema:1263-1300).

**فلسفة موثّقة في السكيما**: لا حذف نهائي (D-35 deactivate-don't-delete)؛ التاريخ append-only (CartonPlacement، OperationCorrection)؛ SetNull لإبقاء التاريخ عند حذف محطة/مستخدم.

---

## 11. Statuses & Transitions — كل الحالات ومن يغيّرها

| الكيان | الحالات | الانتقالات المطبقة فعلاً + الفاعل |
|--------|---------|----------------------------------|
| ExpectedArrival | EXPECTED, RECEIVING, PAUSED, RECEIVED, RECEIVED_WITH_DISCREPANCY (schema:698) | CRM يخلق EXPECTED؛ العامل عبر start/pause/resume/complete (`receiving.service.ts:138,327,338,392`) |
| ReceivingSession | RECEIVING, PAUSED, COMPLETED, COMPLETED_WITH_DISCREPANCY, CANCELLED (schema:737) | العامل (execute)؛ الإغلاق مع استثناءات مفتوحة يتطلب المشرف. **CANCELLED معرَّفة لكن لا يوجد endpoint إلغاء جلسة استلام — إلا عبر Corrections (VOID/REOPEN)** |
| WarehouseCarton | EXPECTED→RECEIVED (استلام)→STORED (putaway)؛ FLAGGED, WRONG_SHIPMENT (schema:728) | العامل. **FLAGGED وWRONG_SHIPMENT**: تُسجَّلان في ReceivingCarton.status/discrepancies؛ كتابة الحالة على WarehouseCarton نفسه: UNKNOWN — EVIDENCE NOT FOUND |
| ReceivingProduct | EXPECTED, PARTIALLY_RECEIVED, RECEIVED, SHORT, OVERAGE, UNEXPECTED, NEEDS_REVIEW (schema:764) | يحسبها `reconcile()` (service:441) آلياً |
| Discrepancy | OPEN→RESOLVED/REJECTED (schema:786) | المشرف (`resolve_discrepancy`) أو الإداري عبر corrections. **REJECTED**: لا يوجد مسار كود يكتبها — UNKNOWN — EVIDENCE NOT FOUND |
| PutawaySession | ACTIVE, PAUSED, COMPLETED, CANCELLED (schema:1122) | العامل (stowing.execute). **CANCELLED: لا endpoint يكتبها** |
| PhysicalItem | 8 حالات محجوزة (schema:572-581) | **لا شيء يكتبها** — تعليق صريح: أي انتقال غير EXPECTED/CANCELLED يُرفض 409 حتى مرحلته (D-47) |
| User | ACTIVE, DISABLED, LOCKED (schema:36) | Admin عبر PATCH users. LOCKED: آلية القفل — UNKNOWN — EVIDENCE NOT FOUND |
| Station | ACTIVE, INACTIVE, MAINTENANCE (schema:1198) | Admin (`stations.manage`) عبر `POST /stations/:id/status` |
| WarehouseOrder/OrderItem | OPEN, CANCELLED (schema:558-568) | لا API إطلاقاً (كيانات خاملة) |

**تناقضات/فجوات حالات مرصودة:** (1) قيم enum معرّفة بلا كاتب: ReceivingSession.CANCELLED، PutawaySession.CANCELLED، DiscrepancyStatus.REJECTED، CartonStatus.FLAGGED/WRONG_SHIPMENT على الكيان الرئيسي، كل حالات PhysicalItem غير EXPECTED/CANCELLED. (2) ShipmentTrackingStatus (schema:716) لا يحدَّث أبداً بعد الاستقبال من CRM — لا يوجد تكامل ناقل.

---

## 12. UI/UX Audit — هوية "التيرمنال" أسود/أخضر

**نظام التصميم مزدوج المصدر (وهذه أهم ملاحظة اتساق):**
1. `frontend/src/styles/os-theme.css` (210 سطر) — النظام "الرسمي" الموثّق: `:root` للمقاسات، `.theme-worker` (أخضر مع glow) و`.theme-admin` (بلا glow)، ومكونات `os-*` (os-card, os-btn, os-tag...).
2. `frontend/src/styles/index.css` (191 سطر) — طبقة أقدم بنفس الألوان لكن بمتغيرات مختلفة الأسماء (`--accent`, `--bg-elev`, `.card`, `.tag`) تستعملها الصفحات القديمة (Users/Roles/Audit/System/Login/warehouse)، **بالإضافة إلى مجموعة "Classic white GUI windows"** (`--gui-window-bg: #f0f0f0`, خط Arial) للنوافذ الحوارية.

**الألوان الفعلية (متطابقة بين الطبقتين):** خلفية `#0c0c0c`، سطح `#0f0f0f`/`#161616`، أخضر فسفوري `#00ff66`، نص `#ffffff`، خافت `#9a9a9a`/`#9e9e9e`، تحذير `#ffb020`، خطأ `#ff3b30`/`#ff5c5c`، معلومات `#38bdf8`، حدود `#333333`.

**Typography:** `'Courier New', Courier, ui-monospace, ... 'Noto Sans Arabic', 'Cairo', 'Tajawal', monospace` — مع تعليق صريح أن العربية يجب ألا تسقط على mono بلا تشكيل (os-theme.css:14-16). زوايا حادة `border-radius: 0` ("old systems"). سرعة الانتقالات 140ms. الـ glow محجوز للحالات التشغيلية المهمة فقط (§33).

**الاتساق:** شاشات Terminal/Admin الجديدة تستعمل `os-*` بانضباط؛ الصفحات القديمة تستعمل `.card/.tag`. النتيجة بصرياً متقاربة (نفس الألوان) لكن **مفردات CSS منقسمة إلى نظامين** + ملفات css لكل شاشة (global-shell, admin-shell, terminal-shell, receiving-task, putaway-task, dashboard, scanner ≈ 865 سطر إضافي).

**حالات الخطأ (Error states):** شاشات العمل الحرجة الثلاث تعرض عند فشل التحميل رسالة خطأ + زر `↻ RETRY` بدل بيانات مضللة: Dashboard (عامل `Dashboard.tsx:48` وأدمن `:149`)، Putaway (`PutawayTask.tsx:238` — مع تعليق صريح بعدم عرض "0 CARTONS" عند فشل التحميل)، Receiving (`ReceivingTask.tsx:280`). بقية الصفحات (admin/pages عبر useAsync، والصفحات القديمة) تعرض رسالة الخطأ نصاً مع زر reload يدوي في الهيدر حيث وُجد.

**RTL/تعريب:** لا يوجد أي دعم RTL أو نصوص عربية في الواجهة — كل النصوص إنجليزية uppercase. الخطوط العربية موجودة في سلسلة fallback فقط.

---

## 13. Screenshots / Assets — الأصول في الريبو

**لا توجد أي صور أو لقطات شاشة أو شعارات أو أيقونات في المستودع** (`git ls-files` على امتدادات الصور → صفر). الشعار "AYROVI / Warehouse" نصّي بالكامل (Login.tsx:36-38، WorkerShell.tsx:79). الأصوات مولّدة برمجياً بـ Web Audio بلا ملفات (feedback.ts:4-5 — "no audio file, no network").

---

## 14. Realtime & Monitoring — ما هو حي فعلاً وما هو UI فقط

- **لا يوجد WebSocket / SSE / polling دوري للبيانات.** grep على `setInterval|WebSocket|EventSource|socket.io|refetchInterval` في الواجهة → نتيجة واحدة فقط: ساعة الهيدر كل 10 ثوانٍ (`GlobalShell.tsx:29`) — وهي لا تجلب بيانات.
- شاشات "Live" في Control Center هي **fetch-on-mount + زر reload يدوي** (`useAsync` — `admin/pages/useAsync.ts`). كلمة "Live" في التعليقات (`operations.service.ts:15` "Live floor overview") تعني "لقطة حالية من قاعدة البيانات" لا بثاً حياً.
- مؤشر ONLINE/OFFLINE في WorkerShell حقيقي لكنه يقيس اتصال المتصفح فقط (navigator.onLine — WorkerShell.tsx:59-67)، لا صحة الخادم.
- `GET /v1/system/health` موجود (system.controller.ts:18) وتعرضه صفحة System عند فتحها فقط.
- بنية الأحداث الداخلية (EventEmitter) موجودة وغير مستعملة (§2).

**الخلاصة: المراقبة "شبه حية" — صحيحة البيانات لحظة الطلب، بلا تحديث تلقائي.**

---

## 15. Notifications & Alerts — الإشعارات

- **لا يوجد نظام إشعارات** (لا email، لا push، لا WhatsApp، لا in-app notification center). `docs/../integrations/README.md` يذكر `notifications/` كمجلد **مستقبلي** صراحة ضمن "Explicitly out of scope for Phase 0".
- ما هو موجود فعلاً: تنبيهات لحظية داخل الشاشة النشطة فقط — أصوات beep + اهتزاز + flash banners في التيرمنال (feedback.ts، ReceivingTask report())؛ عدّادات الاستثناءات في Control Center (تُرى عند الدخول فقط).

---

## 16. Audit & Traceability — التدقيق والتتبع

هذه أقوى منطقة في النظام:
- **AuditLog** يغطي 110+ نوع حدث (enum AuditAction — schema:48-156): من login إلى PUTAWAY_COMPLETED. التسجيل يتم داخل نفس الـ transaction للعملية (`audit.service.ts:29-31` يقبل `tx`؛ أمثلة الاستدعاء في receiving.service داخل `$transaction`).
- **Idempotency تشغيلي**: `ReceivingCarton.operationId @unique` (schema:1041) — المسحة الفيزيائية تعالَج مرة واحدة؛ الواجهة تولّد `freshOperationId()` لكل عملية.
- **مصدر كل مسحة محفوظ**: ScanType (QR/BARCODE/MANUAL) + ScanSource (CAMERA/EXTERNAL_SCANNER/MANUAL) على ReceivingCarton وCartonPlacement (cartonSource/locationSource).
- **تاريخ المواقع append-only**: CartonPlacement — النقل الثاني يغلق السجل الأول (releasedAt) ولا يعيد كتابته (schema:1103 + putaway.service place()) — سؤال "أين كانت الكرتونة الثلاثاء الماضي" قابل للإجابة.
- **Corrections**: كل تصحيح إداري يحفظ snapshot قبل/بعد + سبب إلزامي + IP (OperationCorrection schema:1263-1300؛ endpoints `operations.controller.ts:166+`: reverse-carton, correct-quantity, resolve-exception).
- **تتبع التكامل**: ExpectedArrival يحفظ apiClientId + idempotencyKey + receivedViaApiAt.
- حدود: واجهة الـ Audit تعرض آخر 100 سجل فقط بلا فلترة (§3 بند 23)؛ لا يوجد audit لقراءات (view) — وهذا معتاد.

---

## 17. Missing / Incomplete — الناقص مرتباً P0–P3

*(ترتيب بحسب أثر تشغيلي، بلا اقتراح حلول — رصد فقط)*

**P0 — يمنع عمليات أساسية معلنة في الهيكل:**
- لا Outbound إطلاقاً: Picking / Packing / Shipping غير مبنية رغم وجود الأدوار (PICKER/PACKER) والصلاحيات والمحطة ST-PCK-01. دورا PICKER وPACKER لا يملكان أي شاشة قابلة للعمل (سيريان "NO TASK ASSIGNED" لأن TASK_REGISTRY لا يتضمن picking أصلاً وpacking `ready:false`).
- Sorting معلن في مُنتقي المهام (SOON) وغير قابل للبناء دون قرار تجاري (موثّق في WAREHOUSE-OS-STATUS.md:268).

**P1 — فجوات في وحدات موجودة:**
- كيانات Phase 2 (Products/Orders/PhysicalItems) بلا أي API/UI رغم كون صلاحياتها موزعة على كل الأدوار.
- لا محتوى داخل الكراتين بعد التخزين: الربط PhysicalItem↔Location لا يُكتب أبداً؛ المخزون الحقيقي هو "كراتين في مواقع" فقط.
- تتبع الناقل (ShipmentTrackingStatus) يبقى على قيمة CRM الأولى إلى الأبد.
- لا واجهة تعديل/تعطيل مستخدم أو دور (API موجود، UI ناقصة) — §3 بنود 21-22.

**P2 — نواقص إدارية/تشغيلية:**
- لا إلغاء (CANCELLED) لجلسات الاستلام/التخزين من أي واجهة.
- Audit UI بلا فلاتر/ترقيم؛ System settings وAPI clients قراءة فقط في الواجهة.
- لا تحديث تلقائي لأي شاشة مراقبة (§14).
- لا محطات PUTAWAY/INVENTORY/DISPATCH في الـ seed رغم وجودها في enum.

**P3 — تحسينات مؤجلة موثقة:**
- محرك سعة المواقع (maxUnits...) معطّل بالتصميم (schema:502).
- إشعارات خارجية، تكامل ناقلين، OCR سحابي — كلها "out of scope" معلن.
- توحيد نظامي CSS (os-* مقابل card/tag القديمة).

---

## 18. Contradictions & Risks — التناقضات والمخاطر

1. **مسارات معلنة بلا وجهة**: TASK_REGISTRY يعلن `/terminal/sorting` و `/terminal/packing` ولا Route لهما في App.tsx — الواجهة تحمي نفسها بتعطيل الزر (`disabled={!t.ready}`)، لكن أي انتقال مباشر للمسار يسقط على catch-all `*` → `/` (App.tsx:146).
2. **صلاحية sorting = stowing.execute**: خلط دلالي؛ لو فُعِّل sorting يوماً بـ ready:true فسيُفتح تلقائياً لكل عمال الـ putaway.
3. **أدوار بلا وظيفة**: PICKER/PACKER قابلان للإسناد من شاشة Users لكن صاحبهما يصل إلى Terminal فارغ.
4. **قيم enum ميتة** (بلا كاتب): انظر §11 — خطر على التقارير المستقبلية إن افترضت اكتمال دورات الحياة.
5. **ازدواج نظام الثيم** (§12): تغيير لون مستقبلي يتطلب تعديل ملفين متوازيين.
6. **صلاحيات في الواجهة لا يقابلها مفتاح خلفي مستخدم**: nav `warehouses.view` (NavItems.ts:26) صحيح، لكن أزرار admin تعيد التوجيه لصفحات قديمة خارج ثيم admin — موثّق كقرار مقصود (WAREHOUSE-OS-STATUS.md:275-278).
7. **بيانات seed في الإنتاج**: seed.ts يعمل عند كل إقلاع (start.sh) — البنية TUN-MAIN والعامل WORKER001 موسومة "TEST SEED" لكنها ستُنشأ في أي بيئة لا تحويها. كلمات السر الافتراضية (`ChangeMe!2024`, `Worker!2024`) قابلة للتخصيص عبر env فقط.
8. **مخاطر تشغيل سابقة (حُلّت نهائياً في c50342e وتبقى درساً)**: انحراف سكيما الإنتاج مع سجل هجرات "نظيف"، مع اكتشاف أن Start Command على Render يتجاوز `start.sh` فلا تعمل أي هجرات عند النشر — الحل النهائي إصلاح ذاتي داخل التطبيق (`bootstrap-schema-repair.ts`) يعمل قبل إقلاع Nest مهما كان أمر التشغيل. **يبقى خطر قائم**: طالما Start Command في لوحة Render ليس `./start.sh`، فإن `prisma migrate deploy` و seed لا يعملان عند النشر — أي هجرة مستقبلية جديدة لن تُطبَّق تلقائياً إلا إذا أُضيفت لقائمة REPAIR_STATEMENTS أو صُحِّح أمر التشغيل (UNKNOWN — لا يمكن التحقق من إعدادات لوحة Render من داخل الريبو).
9. **لا بيانات mock ولا هاردكود بيانات عرض** في أي شاشة — grep على mock/TODO/FIXME في src → صفر نتيجة فعلية.
10. **`/terminal/context` بلا `@RequirePermissions`** (operations.controller.ts:37) — محمي بـ JWT العام فقط؛ سلوك مقصود (كل مستخدم يحتاج سياقه) لكنه يستحق الرصد.

---

## 19. Role → Screen Matrix — مصفوفة الدور/الشاشة

مشتقة حصراً من صلاحيات seed.ts + شروط App.tsx/NavItems/AdminShell (✔ = يصل، ✖ = محجوب):

| الشاشة (الصلاحية الحارسة) | SUPER_ADMIN | WH_ADMIN | WH_MANAGER | INBOUND_WORKER | PICKER | PACKER | VIEWER |
|---|---|---|---|---|---|---|---|
| Dashboard (—) | ✔ admin-view | ✔ admin-view | ✔ admin-view | ✔ worker-view | ✔ worker-view | ✔ worker-view | ✔ worker-view |
| /terminal (—) | ✔ | ✔ | ✔ | ✔ | ✔ (فارغ) | ✔ (packing SOON فقط) | ✔ (فارغ) |
| /terminal/receiving (receiving.execute) | ✔ | ✔ | ✔ | ✔ | ✖ | ✖ | ✖ |
| /terminal/putaway (stowing.execute) | ✔ | ✔ | ✔ | ✔ | ✖ | ✖ | ✖ |
| /admin* (operations.view) | ✔ | ✔ | ✔ | ✖ (يُعاد لـ /terminal) | ✖ | ✖ | ✖ |
| /admin/stations (stations.view) | ✔ | ✔ (إدارة) | ✔ (عرض فقط — بلا manage) | ✖ ضمن /admin | ✖ | ✖ | ✖ |
| Corrections (operations.correct للكتابة) | ✔ | ✔ | ✔ | ✖ | ✖ | ✖ | ✖ |
| /expected-arrivals (expected_arrivals.view) | ✔ | ✔ | ✔ | ✔ | ✖ | ✖ | ✔ |
| /warehouse/* (warehouses.view) | ✔ full | ✔ full | ✔ بلا create | ✔ عرض | ✔ عرض | ✔ عرض | ✔ عرض |
| /users (users.view / manage للكتابة) | ✔ | ✔ | ✔ عرض | ✖ | ✖ | ✖ | ✖ |
| /roles (roles.view) | ✔ | ✔ | ✔ عرض | ✖ | ✖ | ✖ | ✖ |
| /audit (audit.view) | ✔ | ✔ | ✔ | ✖ | ✖ | ✖ | ✔ |
| /system (system.view) | ✔ | ✔ | ✔ عرض | ✖ | ✖ | ✖ | ✖ |

ملاحظة دقيقة: INBOUND_WORKER يملك `stations.view` فيدخل نظرياً `/admin/stations`؟ **لا** — كل شجرة `/admin` محروسة أولاً بـ `operations.view` (App.tsx:107-109)، فالعامل لا يصل رغم امتلاكه stations.view (تُستعمل له عبر terminal/context فقط). متسق مع تعليق seed.ts:225-228.

---

## 20. Warehouse Workflow Map — خريطة التدفق والتسليمات

```
[AYROVI Arrival CRM]                                   (خارجي — x-api-key)
   │ POST /integrations/arrivals/customer-cards  → ExpectedArrival (EXPECTED)
   │ POST /integrations/arrivals/shipment-cards  → WarehouseShipment + Cartons (EXPECTED)
   ▼
[INBOUND_WORKER @ محطة RECEIVING] — /terminal/receiving
   start → scan cartons → receive products → (اختلافات؟ ترفع OPEN discrepancy)
   complete → Arrival: RECEIVED / RECEIVED_WITH_DISCREPANCY · Cartons: RECEIVED
   ▼ التسليمة #1: كراتين RECEIVED تظهر تلقائياً في putaway queue
[INBOUND_WORKER (نفس الدور) @ putaway] — /terminal/putaway
   scan carton → scan location → place → Carton: STORED @ Location
   (CartonPlacement ledger يحفظ التاريخ)
   ▼ التسليمة #2 (مقطوعة): ██ لا يوجد ما بعد التخزين ██
   Sorting: غير مبني · Picking: غير مبني · Packing: غير مبني · Shipping out: غير مبني

بالتوازي:
[WAREHOUSE_MANAGER/ADMIN] — /admin
   يراقب overview/workers/sessions ويحل exceptions ويطبّق corrections مدققة
   (reverse carton / correct quantity / resolve exception)
[المشرف] — resolve_discrepancy إلزامي لإغلاق استلام فيه اختلافات
```

نقطة التسليم الوحيدة المؤتمتة بين مرحلتين هي Receiving→Putaway (عبر حالة RECEIVED في الطابور — `putaway.service.ts queue()`). لا يوجد أي handoff آخر.

---

## 21. Design System Baseline — خط الأساس الحالي (توثيق فقط)

**Tokens الموجودة حالياً حرفياً** (بلا اقتراحات):

| Token | القيمة | المصدر |
|-------|--------|--------|
| bg / surface / surface-2 | #0c0c0c / #0f0f0f / #161616 | os-theme.css:40-42 |
| primary (phosphor green) | #00ff66 (secondary #00e05a) | os-theme.css:43-44 |
| text / muted | #ffffff / #9a9a9a | os-theme.css:45-46 |
| success / warning / error / info | #00ff66 / #ffb020 / #ff3b30 / #38bdf8 | os-theme.css:47-50 |
| border | #333333 | os-theme.css:51 |
| spacing scale | 4/8/12/16/24/32/48 px (--os-s1..s7) | os-theme.css:22-28 |
| radius | 0px (حاد دائماً) | os-theme.css:30-31 |
| motion | 140ms (--os-speed) | os-theme.css:33 |
| خط | Courier New → ui-monospace → Noto Sans Arabic/Cairo/Tajawal | os-theme.css:13-19 |
| glow (worker فقط) | 0 0 18px rgba(0,255,102,.35) | os-theme.css:54 |
| GUI windows (نوافذ قديمة) | #f0f0f0 خلفية، Arial | index.css:19-24 |

مكونات المفردات: `os-card`, `os-card-title`, `os-btn` (+primary/ok/err حسب الملف الكامل), `os-tag--ok/err/warn/info/muted`, `os-grid`, `os-empty`, `os-muted` — والطبقة القديمة `.card`, `.tag.accent/green/red/yellow`, `.btn.btn-primary`. الثيمان `.theme-worker`/`.theme-admin` متطابقا الألوان حالياً ويختلفان في الكثافة (padding) والـ glow فقط.

---

## 22. Code Evidence Index — فهرس الأدلة

كل ادعاء في هذا التقرير يستند إلى المواضع التالية (ملف:سطر):

| الادعاء | الدليل |
|---------|--------|
| الحراسة العالمية JWT+Permissions | `backend/src/app.module.ts:58-59` |
| TASK_REGISTRY والحالات ready | `backend/src/modules/operations/terminal.service.ts:34-66`; ترشيح الصلاحيات `:80` |
| كل الـ routes | `frontend/src/App.tsx:72-147`؛ redirects `:78-79,117-123`؛ حماية العامل `:52-56` |
| الأدوار السبعة وصلاحياتها | `backend/prisma/seed.ts` بلوك ROLES (~:166-268)؛ الصلاحيات `:57-129` + STRUCTURE_PERMISSIONS `:39-50` |
| البنية الفيزيائية والقيود | `backend/prisma/schema.prisma:378-516`؛ locationCode `:496`؛ سعة metadata فقط `:502` |
| Phase 2 خامل | schema `:530-546` (SCOPE GUARD) و `:667`؛ غياب أي `prisma.product|order...` في src (grep صفر) |
| Receiving lifecycle كامل | `receiving.service.ts:73` start، `:149` scan، `:231` receive-carton، `:266` receive-product، `:322/:333` pause/resume، `:345` flag، `:355` resolve (Forbidden)، `:373-408` complete + بوابة المشرف `:380-382` |
| Idempotency المسح | schema `:1041` operationId @unique؛ `ReceivingTask.tsx` freshOperationId |
| قنوات الإدخال الثلاث + wedge classifier | `ReceivingTask.tsx:222-246`؛ `ContinuousScanner.tsx:333-342` (BarcodeDetector/zxing)؛ OCR محلي `ocr-client.ts:1-47` |
| Putaway append-only | `putaway.service.ts:14-21` (التعليق)، `place()` `:257-354`، queue `:117` |
| Corrections مدققة | `operations.controller.ts:157-190`؛ `corrections.service.ts` (361 سطر)؛ snapshots schema `:1290-1292` |
| بوابة CRM وidempotency | `crm-arrivals.controller.ts:19-60`؛ `integration-api.guard.ts:15-27` (SHA-256) |
| لا realtime | grep setInterval/WebSocket → `GlobalShell.tsx:29` فقط؛ `useAsync.ts` fetch-on-mount |
| لا أحداث domain | `events/events.module.ts:11-12` |
| لا إشعارات | `backend/src/integrations/README.md` (out of scope) |
| لا أصول صور | `git ls-files` مرشّح بامتدادات الصور → 0 |
| نظام التصميم | `styles/os-theme.css:12-56`؛ الطبقة القديمة `styles/index.css:1-25` |
| Sorting مؤجل بقرار | `docs/WAREHOUSE-OS-STATUS.md:266-273` |
| الإصلاح الذاتي للسكيما داخل التطبيق | `backend/src/bootstrap-schema-repair.ts:37` (PROBE_SQL)، `:55` (REPAIR_STATEMENTS — 65 أمراً)، `:185` (repairSchemaDriftIfNeeded)؛ الاستدعاء `backend/src/main.ts:17,24` |
| هجرة إصلاح الانحراف | `backend/prisma/migrations/20260902100000_repair_warehouse_os_drift/migration.sql` |
| أزرار RETRY في حالات فشل التحميل | `pages/Dashboard.tsx:48,149`؛ `terminal/PutawayTask.tsx:238` (+تعليق عدم عرض "0" مضلِّل `:243-244`)؛ `terminal/ReceivingTask.tsx:280` |
| الاختبارات | 38/38 unit + 49/49 e2e ناجحة على هذا الـ commit (نُفّذت محلياً أثناء التدقيق) |

---

## 23. Final Assessment — التقييم النهائي

**CURRENT STATE:** نظام إنبوند مستودعي حقيقي ومكتمل من بوابة CRM حتى التخزين على الرف، مع طبقة إدارة وتدقيق قوية، مبني على مراحل (Phases) موثّقة داخل الكود، ويتوقف عمداً عند حدود واضحة.

**WHAT IS REAL (مستعمل ومختبر):** Auth/RBAC، البنية الفيزيائية الكاملة، بوابة CRM (arrivals/shipments/cartons)، Receiving بكل تفاصيله، Putaway بسجل حركة تاريخي، Stations، Terminal context routing، Admin Control Center، Exceptions/Corrections، AuditLog transactional، السكانر (كاميرا/مسدس/يدوي/OCR محلي).

**PARTIAL:** شاشات Users/Roles/System/Audit (قراءة/إنشاء بلا تعديل من الواجهة رغم وجود الـ API)؛ مراقبة بلا تحديث تلقائي؛ Discrepancy REJECTED وإلغاء الجلسات معرّفة بلا مسار.

**MISSING:** Sorting، Picking، Packing، Shipping الصادر، Returns، جرد/كميات المخزون، محتوى الكراتين (PhysicalItem placement)، أي API/UI لكيانات Products/Orders، realtime، إشعارات، تكامل ناقلين، أدوار PICKER/PACKER بلا أي عمل فعلي.

**MUST NOT CHANGE (ثوابت يعتمد عليها النظام):**
- عقود الـ idempotency: `customerArrivalCardId`, `externalShipmentId`, `externalCartonId`, `operationId`.
- مبدأ append-only: CartonPlacement (releasedAt) وOperationCorrection (snapshots) — لا إعادة كتابة تاريخ.
- سياسة Restrict/SetNull في السكيما (لا حذف بنية فيها مخزون؛ لا فقدان تاريخ عند حذف محطة/مستخدم).
- بوابة المشرف على إغلاق استلام فيه اختلافات (`receiving.resolve_discrepancy`).
- قاعدة "العامل لا يرى الإدارة" (حراسة مزدوجة واجهة+خلفية).
- طبقات إصلاح السكيما الثلاث: `bootstrap-schema-repair.ts` (داخل التطبيق — الطبقة الفعّالة في الإنتاج) + هجرة الإصلاح `20260902100000` + فحص drift في start.sh (درس انقطاع الإنتاج).
- صيغة locationCode المقروءة-فقط `WH-ZONE-AISLE-RACK-LEVEL`.

**NEEDS REDESIGN / DECISION (رصد بلا اقتراح تنفيذ):**
- تعريف Sorting تجارياً قبل أي بناء (السؤال المفتوح موثّق في الريبو نفسه).
- مصير أدوار PICKER/PACKER وصلاحيات outbound ما دامت الـ workflows غائبة.
- توحيد طبقتي CSS (os-* مقابل القديمة) قبل أي توسّع واجهات.
- ربط sorting بصلاحية مستقلة بدل `stowing.execute`.
- سياسة تشغيل seed في الإنتاج (بيانات TEST SEED وكلمات السر الافتراضية).

---

## 24. No-Guessing Declaration — إقرار عدم التخمين

- كل بند أعلاه مأخوذ من قراءة مباشرة للملفات على commit `c50342e` (HEAD)، وكل ادعاء له مرجع ملف/سطر في §22.
- المواضع التي لم يوجد لها دليل صُرِّح بها نصاً: **UNKNOWN — EVIDENCE NOT FOUND** (بيانات حسابات الإنتاج؛ آلية LOCKED للمستخدم؛ أي كاتب لحالات REJECTED/CANCELLED/FLAGGED المذكورة في §11؛ كتابة CartonStatus.WRONG_SHIPMENT على الكيان الرئيسي).
- لم يُعدَّل أي ملف في المستودع أثناء هذا التدقيق، ولم يُخترع أي workflow غير موجود، ولم تُقترح إصلاحات تنفيذية — التقرير وصفي بالكامل بانتظار مراجعتك قبل أي خطوة تالية.

*— نهاية التقرير —*
