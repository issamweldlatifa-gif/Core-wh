# AYROVI — خطة المرحلة 2 (نظام الدفعات) — v3
**الحالة:** شريحة العقد (Backend+DB) + شريحة مولّد الباركود (الموبايل) **مكتملة وCI أخضر** — الفرع `feature/ayrovi-batch`
**التاريخ:** 2026-09-11 · هذا الإصدار يتبع أمر التنفيذ (25 قسمًا) + قرار هوية المنتج الملزم

---

## 1) الأدلة (CI أخضر على الفرع)

| المسار | التشغيل | النتيجة | ما أثبته |
|---|---|---|---|
| Backend CI | 34627806415 | ✅ success | 24 suite / **237 اختبار** خضراء (منها 17 عقد الدفعات + حرّاس النطاق) على `e722e8e` |
| Android Native Build | 34631098356 | ✅ success | scanner-core 46 + worker-core 120 + **`:app:testDebugUnitTest` (أول مرة في CI)** — roundtrip التشفير↔فك التشفير نجح + **محاكي UI** نجح، على `b6274c4` |

Commits: `e722e8e` (عقد الدفعات) → `7134473` → `d4bdf66` → `1b808e9` → `881abbf` → **`b6274c4`** (الموبايل).
ملاحظة صدق: Backend CI انطلق تلقائيًا؟ لا — الفرع `feature/*` لا يُشغّل CI الواجهي؛ تم التشغيل يدويًا (workflow_dispatch) لكلا المسارين، والمحاكي بـ `run_emulator_tests:true`.

## 2) ما نُفّذ — العقد (Backend)

- **Prisma:** `CardType += BATCH_CARD`؛ Enums: `BatchStatus(7)` / `BatchIdentifierType(SKU|BARCODE|REFERENCE|QR|MANUAL)` / `BatchItemStatus(REGISTERED|RECEIVED)`؛ Models: `BatchCustomer` (needsReview=true افتراضيًا) · `AyroviUnit` (code@unique + originalBarcode/Sku/Reference **حرفيًا**) · `Batch` (batchCode@unique, source=WORKER_APP_BATCH, totalExpected/totalScanned, customerId FK SetNull, idempotencyKey@unique, طوابع الدورة كاملة + voidedById/voidReason) · `BatchItem` (unitId@unique FK Restrict, identifierType/Value/normalizedIdentifier, status, idempotencyKey@unique, metadata).
- **Migration:** `20260911120000_batch_contract` — **إضافية خالص** (لا تلمس الجداول القائمة إطلاقًا؛ تحقّقت بـ `migrate diff`).
- **آلة الحالات:** `CREATED → SUBMITTED → ACCEPTED → SENT_TO_RECEIVING → RECEIVING_IN_PROGRESS` + `void` من كل حالة غير نهائية؛ النهايات `{}`؛ انتقال غير معرّف = رمي `FORBIDDEN_BATCH_TRANSITION`.
- **الأكواد:** دفعة `AYB-YYYYMMDD-NNNNN` (تسلسل يومي من أعلى كود قائم + مشي 64 عند التضارب) · وحدة `AYP-NNNNNNNNN` (عالمي) · اختبار `AYBTEST-`/`AYPTEST-`.
- **العلم:** `batch.enabled` — غائب = **OFF**، صريح true/"true" = ON (عبر SystemSetting القائم).
- **الصلاحيات:** `batch.view/create/execute/accept/send/receive/void` على RBAC القائم + مزروعة في seed (7 صفوف).
- **DTOs:** إنشاء/إرسال/قرار + `idempotencyKey` **إلزامية** على create وadd-item (الباقي مع شريحة الخدمة — متعمد). قاعدة: identifierValue مطلوبة إلا في MANUAL، و**MANUAL لا يخترع أصلًا أبدًا**.

## 3) ما نُفّذ — الموبايل (إضافي فقط، لا يلمس منطق v1.7.x)

- `com.google.zxing:core:3.5.3` — **ترميز فقط**؛ ML Kit يبقى القارئ الوحيد (سطح المسح الواحد لم يتغير).
- `BatchBarcodeRenderer` (نقي JVM بلا android.*): `unitLabel` (يحمل AYP + الأصل حرفيًا + العميل + الدفعة كسطور مقروءة) و`batchLabel` (يحمل AYB). MANUAL = بلا سطور أصل مخترعة (مرفوض بـ require).
- اختبارات roundtrip حقيقية: ما يُطبع **يفكّ** بالضبط إلى هوية AYROVI نفسها (أُثبتت بيئيًا ثم في CI). تحويل كبير: صندوق `.git` تراجع مرتين أثناء الدورة — استُرجع من المستودع البعيد (البعيد هو المرجع).
- إصدار الفرع: **versionCode 68 / 1.8.0-batch.1** (قاعدة الإصدار: أي تغيير runtime ⇒ ترقيم + APK جديد عند التسليم).

## 4) هوية المنتج (ملزمة — قرار المستخدم)

`السطر الأصلي (verbatim) → AyroviUnit (AYP مستقل بكود/باركود خاص به) → عضوية BatchItem → سياق العميل/الوارد/الشحنة`.
الدفعة = هوية جماعية فقط؛ باركود الدفعة لا يحمل SKU أبدًا؛ باركود المنتج لا يُستخدم كهوية دفعة. إنشاء العميل من **العامل** في التطبيق (needsReview للمراجعة الإدارية).

## 5) قرارات معلّقة للمستخدم (لا تُسدّل من عندي)

1. **الطابعة:** الافتراضي Android Print Framework (طباعة من التطبيق لأي طابعة). إن كان هناك طابعة ملصقات محددة (Zebra/…) فذكّرني لأضبط القالب.
2. **المحطة:** لن تُنشأ محطة BATCH تلقائيًا — سأفحص إعادة استخدام DISPATCH أولًا (كما في الأمر).
3. **Render بيئة الاختبار:** autoDeploy يتابع `master` — نشر بيئة اختبار الفرع يحتاج خطوة منك (أو أوثّق الدمج اللاحق).

## 6) الشرائح المتبقية (نفس الأمر، بالترتيب)

1. **الخدمات + Controllers** (create/submit/accept/send/start/complete/void/add-item/receive + idempotency submit/complete/send + التدقيق عبر البنية القائمة).
2. **Admin UI** (بطاقة BATCH_CARD، مراجعة needsReview، قبول/إرسال/طباعة).
3. **تطبيق العامل** (إنشاء عميل → دفعة → إضافة وحدات AYP → تصدير/طباعة الملصقات → إرسال).
4. **الاستلام** (فحص AYP → 10/10 → completed → تقرير) — كل مسح = وحدة واحدة؛ SKU×10 = 10 عناصر (التكرار ليس تكرارًا). **+ التحقق الإلزامي: إعادة استخدام محطة DISPATCH بدل إنشاء محطة BATCH جديدة.**
5. **E2E + تقرير + Release** (فرنسا 10 منتجات/دفعة واحدة؛ تونس فتح→مسح→اكتمال؛ A+B بالتوازي؛ بيانات AYBTEST-/AYPTEST- قابلة للتصفير).

**قاعدة البوابة:** لا انتقال لشريحة جديدة باختبارات حمراء — الوضع الآن أخضر بالكامل على الفرع.
