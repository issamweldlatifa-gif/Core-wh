# 🔧 تقرير الفحص والإصلاحات — AYROVI Warehouse Core (Core-wh)

**التاريخ:** 2026-09-02
**المستودع:** https://github.com/issamweldlatifa-gif/Core-wh.git
**النطاق:** Backend (NestJS + Prisma + PostgreSQL) + Frontend (React + Vite) + Docker + نشر Render

---

## 1) ملخص تنفيذي

| البند | قبل الفحص | بعد الإصلاح |
|---|---|---|
| بناء الـ Backend (`nest build`) | ✅ يعمل | ✅ يعمل |
| بناء الـ Frontend (`vite build`) | ✅ يعمل | ✅ يعمل |
| فحص الأنواع `tsc` (backend) | ❌ ~60 خطأ في ملفات `.spec.ts` | ✅ 0 أخطاء |
| اختبارات الوحدة (unit) | ✅ 38/38 | ✅ 38/38 |
| اختبارات e2e | ✅ 49/49 | ✅ 49/49 |
| `npm run db:seed` | ❌ يفشل (لا يقرأ `.env`) | ✅ يعمل |
| ثغرات أمنية (frontend) | ⚠️ 4 (منها 1 عالية) | ✅ 0 |
| ثغرات أمنية (backend — إنتاج) | 🔴 15 (1 حرجة، 6 عالية) | ✅ 1 متوسطة فقط (تتطلب ترقية NestJS v12 الكاسرة) |
| بروكسي nginx للـ API في Docker | ❌ معطّل تماماً (يرجع JSON وهمي) | ✅ يمرر إلى backend:3000 |
| مسار `/api` المجرد في وضع SPA | ❌ يرجع صفحة SPA بدل الـ API | ✅ يصل إلى Nest |
| خيار `SWAGGER_ENABLED` | ❌ موثّق لكن غير مقروء إطلاقاً | ✅ يُحترم فعلياً |
| أسرار JWT | 🔴 fallback صامت إلى `.env.example` | ✅ فشل فوري عند غيابها |
| Rate limiter خلف بروكسي | ❌ يحجب كل المستخدمين معاً | ✅ `trust proxy` مفعّل |

**النتيجة النهائية: السيرفر يعمل الآن كاملاً (SPA + API) على المنفذ 3000 مع قاعدة بيانات PostgreSQL حقيقية، وكل الاختبارات (87) ناجحة.**

---

## 2) المشاكل المكتشفة والإصلاحات المنفَّذة

### 🔴 حرجة — أمان

#### 2.1 fallback صامت لأسرار JWT إلى `.env.example`
- **الملف:** `backend/src/app.module.ts`
- **المشكلة:** `envFilePath: ['.env', '../.env', '.env.example']` — إذا نسي المشغّل ملف `.env` في الإنتاج، يعمل النظام بمفاتيح توقيع JWT **منشورة علناً في GitHub** (`replace_with_a_long_random_access_secret`). أي مهاجم يستطيع تزوير توكنات SUPER_ADMIN.
- **الإصلاح:**
  1. حذف `.env.example` من قائمة التحميل.
  2. إضافة فحص fail-fast في `main.ts`: يرفض الإقلاع إذا كان `JWT_ACCESS_SECRET` أو `JWT_REFRESH_SECRET` مفقوداً أو ما زال placeholder.
  3. تحميل `dotenv` في أول سطر من `main.ts` (لأن `JwtStrategy` يقرأ `process.env` في الـ constructor قبل أن يعمل ConfigModule).

#### 2.2 ثغرة node-tar الحرجة + 6 ثغرات عالية في تبعيات الإنتاج
- **المشكلة:** `bcrypt@5` يسحب `tar` مصاباً بثغرات حرجة (Arbitrary File Overwrite / Path Traversal)، مع ثغرات عالية في `js-yaml` (prototype pollution)، `lodash` (code injection عبر `_.template`)، `multer` (5 ثغرات DoS)، `body-parser`, `qs`, `file-type`.
- **الإصلاح:**
  - ترقية `bcrypt` إلى `^6.0.0` (تم التحقق: التجزئة والمقارنة تعملان، وكلمات المرور القديمة متوافقة — تسجيل الدخول ناجح).
  - إضافة `overrides` في `backend/package.json`:
    `js-yaml ^4.3.2`, `lodash ^4.17.23`, `multer ^2.3.0`, `body-parser ^1.20.6`, `qs ^6.16.0`, `file-type ^21.3.4`, `tar ^7.5.3`.
  - **النتيجة:** من 15 ثغرة إنتاجية إلى **1 متوسطة فقط** (في `@nestjs/core@10` نفسه — إصلاحها يتطلب الترقية الكاسرة إلى NestJS 12، موصى بها كخطوة لاحقة مخططة، ليست إصلاحاً آلياً آمناً).

#### 2.3 ثغرات الواجهة الأمامية (react-router / vite-esbuild)
- **المشكلة:** `react-router-dom@6` مصاب بـ Open Redirect (CVE-2025-68470 bypass — **عالية**)، و`vite@5`/esbuild يسمح لأي موقع بقراءة ردود خادم التطوير.
- **الإصلاح:** ترقية إلى `react-router-dom@7.18.3` + `vite@7.3.6` + `@vitejs/plugin-react@5.2.0` + `@types/node@20` (كان `^26` — إصدار لا يطابق Node 20 المستخدم).
- **التحقق:** `tsc` نظيف، `vite build` ناجح، جميع استيرادات react-router المستخدمة متوافقة مع v7 بدون تعديل كود. **`npm audit`: 0 ثغرات.**

### 🟠 عالية — مسارات ووظائف معطّلة

#### 2.4 بروكسي nginx للـ API معطّل بالكامل (Docker)
- **الملف:** `docker/nginx.conf`
- **المشكلة:** كتلة `location /api/` كانت ترجع `return 200 '{"status":"ok","service":"frontend"}'` بدل تمرير الطلب — أي أن **الواجهة الأمامية في Docker لا تستطيع الوصول إلى الـ API إطلاقاً** (كل الطلبات ترجع JSON وهمياً).
- **الإصلاح:** تفعيل `proxy_pass http://backend:3000;` مع ترويسات `X-Forwarded-*` الصحيحة.

#### 2.5 مسار `/api` المجرد يبتلعه fallback الـ SPA
- **الملف:** `backend/src/main.ts`
- **المشكلة:** الشرط كان `req.path.startsWith('/api/')` فقط، فطلب `GET /api` (بدون شرطة نهائية) يرجع `index.html` بدل الوصول إلى Nest.
- **الإصلاح:** `if (req.path === '/api' || req.path.startsWith('/api/')) return next();`

#### 2.6 سكربت الـ seed لا يقرأ `.env`
- **الملف:** `backend/prisma/seed.ts`
- **المشكلة:** `npm run db:seed` يفشل بـ "Environment variable not found: DATABASE_URL" لأن `PrismaClient` لا يحمّل `.env` تلقائياً (فقط Prisma CLI يفعل). هذا يعني أن `start.sh` في نشر Render يعتمد على متغيرات البيئة الخارجية فقط، والتشغيل المحلي كان مكسوراً.
- **الإصلاح:** تحميل `dotenv` في بداية `seed.ts` (من `backend/.env` ثم fallback إلى جذر المشروع).

#### 2.7 Rate limiter يعاقب جميع المستخدمين معاً خلف أي بروكسي
- **الملفات:** `backend/src/main.ts` + `common/guards/rate-limit.guard.ts`
- **المشكلة:** خلف Render/nginx يكون `req.ip` هو IP البروكسي نفسه لكل الطلبات، فبعد 20 محاولة دخول **من أي مستخدمين** يُحجب الجميع 15 دقيقة.
- **الإصلاح:** `app.set('trust proxy', 1)` — الآن `req.ip` هو IP العميل الحقيقي من `X-Forwarded-For`.

### 🟡 متوسطة — إعدادات وأدوات

#### 2.8 `SWAGGER_ENABLED` موثّق لكن غير مُنفَّذ
- **المشكلة:** المتغير موجود في `.env.example` و `render.yaml`، لكن `main.ts` لم يقرأه أبداً — توثيق الـ API كان مكشوفاً دائماً حتى لو عطّله المشغّل.
- **الإصلاح:** Swagger يُبنى فقط إذا لم تكن القيمة `false`.

#### 2.9 ~60 خطأ TypeScript في `tsc --noEmit` (backend)
- **المشكلة:** `tsconfig.json` يستخدم `types: ["node"]` بدون `jest` بينما يشمل ملفات `.spec.ts` → أي `Cannot find name 'describe'/'it'/'expect'` في كل ملف اختبار. البناء كان ينجح فقط لأن `tsconfig.build.json` يستثنيها، لكن فحص الأنواع الكامل والمحررات كانت مليئة بالأخطاء.
- **الإصلاح:** إضافة `"jest"` إلى `types`. النتيجة: `tsc --noEmit` نظيف 100%.

#### 2.10 إعداد ts-jest مهجور (deprecated)
- **الملفات:** `backend/package.json` + `backend/test/jest-e2e.json`
- **المشكلة:** تحذير `Define ts-jest config under globals is deprecated` عند كل تشغيل.
- **الإصلاح:** نقل الإعداد إلى الصيغة الحديثة `transform: ["ts-jest", { tsconfig }]`. لا مزيد من التحذيرات.

#### 2.11 `VITE_API_PROXY_TARGET` من `.env` لا يعمل في vite.config.ts
- **المشكلة:** `process.env.VITE_API_PROXY_TARGET` غير مُعبّأ من ملف `.env` داخل `vite.config.ts` (Vite يحقن متغيرات env في كود العميل فقط) — القيمة الموثقة في `frontend/.env.example` كانت بلا أثر.
- **الإصلاح:** استخدام `loadEnv(mode, ...)` الرسمية.

#### 2.12 نسخة SPA قديمة/يتيمة داخل `backend/public`
- **المشكلة:** المستودع يحوي بناءً قديماً من "المرحلة 1" (ملفا asset فقط مقابل 20+ حالياً) — تشغيل الـ backend محلياً كان يقدّم واجهة قديمة لا تحتوي الترمينال ولا مركز التحكم.
- **الإصلاح:** إعادة بنائها من `frontend/dist` الحالي (بعد ترقيات الأمان).

---

## 3) التحقق النهائي (كل الفحوص أعيدت بعد الإصلاحات)

```
✅ backend:  tsc --noEmit ................. 0 أخطاء
✅ backend:  nest build .................. ناجح
✅ backend:  jest (unit) ................. 38/38
✅ backend:  jest e2e (بقاعدة PostgreSQL حقيقية) ... 49/49
✅ backend:  npm audit --omit=dev ........ 1 متوسطة فقط (NestJS core v10)
✅ frontend: tsc --noEmit ................ 0 أخطاء
✅ frontend: vite build (v7) ............. ناجح
✅ frontend: npm audit ................... 0 ثغرات
✅ prisma:   10 هجرات مطبقة بنجاح + seed كامل
✅ تشغيل حي: /api/v1/system/health → {"status":"ok","database":"up"}
✅ دخول ADMIN001 (201) ودخول WORKER001 (201) — bcrypt 6 متوافق
✅ SPA تعمل على / و /terminal/receiving، و /api يصل إلى Nest
```

## 4) توصيات لاحقة (لم تُنفَّذ لأنها قرارات كاسرة/تصميمية)

1. **ترقية NestJS 10 → 12** لإغلاق آخر ثغرة متوسطة (`GHSA-36xv-jgw5-4q75`) — تتطلب اختبار رجعية كاملاً.
2. **نقل توكنات JWT من `localStorage` إلى كوكيز `httpOnly`** — الوضع الحالي مكشوف لـ XSS (قرار معماري موثق أصلاً في OPEN-DECISIONS).
3. **Rate limiting بمخزن مشترك (Redis)** عند التوسع لأكثر من نسخة واحدة.
4. إزالة `backend/public` من git وتوليده في CI فقط (يتولد من `build.sh` على أي حال).
5. تفعيل ESLint فعلياً — السكربتات `lint` موجودة في كلا الحزمتين لكن `eslint` غير مثبت كتبعية.
