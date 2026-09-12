# AYROVI — المرحلة 2 (نظام الدفعات) — تقرير التسليم النهائي
**التاريخ:** 2026-09-12 · **الفرع المرجعي:** `master` @ **`e42437b`** · **الحالة: جميع الشرائح الخمس منجزة وCI أخضر على master**

---

## 1) روابط التسليم (أمر التنفيذ §25)

| البند | القيمة |
|---|---|
| **Commit SHA** | `e42437b` (master — دمج سريع نظيف من `feature/ayrovi-batch` بلا أي تعارض) |
| **GitHub Release (دائم)** | https://github.com/issamweldlatifa-gif/Core-wh/releases/tag/worker-apk-e42437b |
| **APK (رابط دائم)** | https://github.com/issamweldlatifa-gif/Core-wh/releases/download/worker-apk-e42437b/ayrovi-worker-v1.8.0-batch.3-70.apk |
| **APK** | `ayrovi-worker-v1.8.0-batch.3-70.apk` — versionCode **70** / versionName **1.8.0-batch.3** (80MB، موقّع debug-key — نفس قناة v1.7.6) |
| **Render** | autoDeploy يتابع `master` → النشر انطلق تلقائيًا بدفع master؛ فحص الصحة: `GET /api/v1/system/health` — **رابط الخدمة عندك في لوحة Render** (المخمّن `ayrovi-warehouse-core.onrender.com` ردّ 404 — أكّد لي الرابط الصحيح أو حدّث الدومين) |
| **Backend CI (master)** | ✅ success — 266 اختبار (incl. 46 في batches) + build |
| **Android (master)** | ✅ success — run 34666267500: تجميع + `:app:testDebugUnitTest` + **محاكي UI** + R8 |

## 2) ما تسلّمه (خمس شرائح، كلها بوابة خضراء)

1. **العقد** — سكيما (Batch/AyroviUnit AYP/BatchCustomer/BatchItem) + migration إضافية خالص + آلة حالات + أكواد AYB/AYP + علم `batch.enabled` (OFF افتراضيًا) + صلاحيات batch.*
2. **الخدمات + Controllers** — 10+ نقاط نهاية، idempotency على create/add-item/submit/send/complete، تزامن محروس (BATCH_RACE_RETRY)، تدقيق ذري 9 أحداث، بلا حذف حقيقي
3. **Admin UI** — `/admin/batches`: مراجعة needsReview → قبول → طباعة ملصق الدفعة → إرسال → إلغاء بسبب إلزامي (بمفردات النظام الموحدة، بلا تبعيات جديدة)
4. **تطبيق العامل — BUILD** — إنشاء العميل داخل التطبيق، كل مسح = وحدة AYP، MANUAL بلا أصل مخترع، طباعة ملصقات AYP عبر Android Print Framework، إرسال آمن-إعادة (v69)
5. **تطبيق العامل — BATCH IN** — قائمة انتظار → فحص AYP (الصدى no-op من الخادم، العدادات حقيقة الخادم) → إكمال 10/10 (v70)

**فحص المحطة (قيد الأمر):** منجز — DISPATCH صادر فقط ولا يستضيف استلامًا واردًا؛ مهام batch/batch-in **بلا محطة**؛ لم تُنشأ أي محطة BATCH.

## 3) سجل الاختبارات

- Backend: **26 suite / 266 اختبار** خضراء على master (عقد 17 + عمليات 23 + سجل المهام 6 + حراس النطاق)
- worker-core: **136/136** محليًا عبر kotlinc مستقل (حتى لا نلمس قاعدة «لا gradle محليًا») — الاختبارات القديمة الـ120 لم تتراجع إطلاقًا
- Frontend: 142/142 vitest + tsc 0 + build ✓ (شريحة Admin)
- CI: خضراء على الفرع ثم **على master** بعد الدمج (backend + android + محاكي)
- أخطاء أمسكتها CI وأُصلحت بالجذر: اقتباس SQL بالـ migration، import متسلسل ×2، API طباعة، نطاق متغير، تاريخ منتصف الليل في اختبار التسلسل

## 4) متبقٍّ عليك (خطواتك فقط)

1. **Render:** أكّد لي رابط الخدمة (أو افتح اللوحة — النشر انطلق تلقائيًا بدفع master) ثم نفحص `/api/v1/system/health` معًا.
2. **تشغيل العلم:** `batch.enabled` افتراضيًا OFF — عندما تريد تفعيل النظام فعليًا: Settings → أضف/حدّث `batch.enabled = true` (من Admin → System).
3. **اختبارك على الجهاز الحقيقي:** ثبّت الـ APK من رابط الـ Release، وسِناريو الأمر: فرنسا (10 منتجات→10 وحدات→دفعة→قبول→طباعة→إرسال) وتونس (فتح→مسح→10/10→إكمال→تقرير) + دفعتان A+B بالتوازي.
4. **بيانات الاختبار:** البادئات `AYBTEST-`/`AYPTEST-` قابلة للتصفير — DataControl القائم هو من ينفّذ (بلا حذف حقيقي).

## 5) الهوية (تذكير ملزم)
السطر الأصلي حرفيًا → `AyroviUnit` (AYP مستقل بكوده/باركوده) → عضوية BatchItem → سياق العميل/الدفعة/الشحنة. باركود الدفعة لا يحمل SKU أبدًا، وباركود المنتج لا يُستخدم كهوية دفعة.
