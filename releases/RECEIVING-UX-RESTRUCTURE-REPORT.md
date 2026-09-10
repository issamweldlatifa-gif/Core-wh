# AYROVI WHS — Worker App: RECEIVING UX RESTRUCTURE
**الإصدار:** 1.7.1 (versionCode 62) · **Commit:** `3dcade7` · **Branch:** `master`

> مدموج فوق عمل الفريق الجديد (SHIPPING + ARCHIVE/TRACE بـ 5 commits) عبر rebase — محطاتهم أصبحت تظهر في HOME الجديدة (STATIONS) مع الحفاظ على مساراتها واختباراتها.

## ما نُفّذ (نفس الأمر حرفيًا)

### HOME (الشاشة الرئيسية الجديدة)
```
AYROVI
[ RECEIVING ]        ← المدخل الرئيسي
[ OCR ]  [ QR CODE ]
[ RAPPORT ]  [ SETTINGS ]
```
- ✅ أيقونة Settings حُذفت من الـ Header نهائيًا (`showSettingsIcon=false`)
- ✅ Settings entry point واحد وواضح من Home (نفس الحوار الحالي بدون تغيير محتواه)
- ✅ باقي المحطات المكلَّف بها العامل (Temp Storage / Sorting / Packing) + التعليمات + REFRESH/SIGN OUT محفوظة كما هي

### RECEIVING (Work Center)
- يفتح **مباشرة** على المحتوى: مجموعات **TO DO / ISSUES / DONE**
- مبنية من البيانات الموجودة فقط: الـ home feed (بطاقات مفتوحة) + جلسة الاستقبال المفتوحة (tally التي يستعملها التقرير أصلًا) + حالة NEEDS_REVIEW + حالة الخطأ على الجهاز
- كل بطاقة تفتح الـ workflow الحالي (PRODUCT/CARTON lane scanner) — لا START/CONFIRM جديد
- بطاقتا PRODUCT/CARTON المباشرتان + RAPPORT باقيتان (لا ميزة حُذفت)

### QR CODE (وصول مباشر §9)
- HOME → QR CODE → **الماسح يفتح مباشرة** (بدون Receiving/Product/Carton)
- مسح منتج → نفس مسار PRODUCT الحالي حرفيًا · مسح كرتون → نفس مسار CARTON
- كود غير معروف → **NOT MATCHED + "The failure was logged."** (سجل مرة واحدة) → BACK — نفس عقد الخطأ الحالي

### OCR (§14)
- يفتح سير OCR الحالي (نفس واجهة الاختيار/الكاميرا/الكتابة) عبر قالب مركّب `AutoScanTemplate` = نفس قالبَي المنتج/الكرتون بدون أي أشكال جديدة

### غير المُمس (§17)
Business logic · Backend/API · Scanner logic (CT40/Phone/Honeywell/Zebra) · Success flow · Error flow · Failure logging · الصلاحيات · الإشعارات — **بدون أي تغيير سلوكي**.

## نتائج التحقق (نفس أوامر CI في `.github/workflows/android-build.yml`)
| الفحص | النتيجة |
|---|---|
| `:worker-core:test` + `:scanner-core:test` | ✅ **130/130 (بعد الدمج: اختبارات SHIPPING/TRACE الجديدة من الفريق + اختبارات AUTO)** (114 موجودة + 6 اختبارات AUTO جديدة) |
| `:app:assembleDebug` | ✅ BUILD SUCCESSFUL |
| `:app:lintDebug` | ✅ 0 أخطاء |
| `:app:assembleDebugAndroidTest` | ✅ BUILD SUCCESSFUL |
| التحقق من محتوى APK | ✅ كل وسوم/رسائل التغيير موجودة في dex التطبيق (classes4/10) بما فيها نصوص NOT MATCHED و"failure was logged" الحرفية |

## APK
- **الملف:** `releases/AYROVI-Worker-v1.7.1-62-debug.apk` (QA artifact — debug-signed حسب سياسة المستودع)
- الإصدارات الرسمية عبر pipeline التوقيع/MDM الخاصة بالمنظمة بعد بوابات الإنتاج

## النشر (متبقٍ على قدرتك)
1. `git push origin master` (يتطلب بيانات اعتماد GitHub — لم تكن متاحة هنا)
2. CI سيبني ويرفع الـ APK تلقائيًا عند الـ push
3. سطر واحد إذا رغبت: `git remote set-url origin git@github.com:issamweldlatifa-gif/Core-wh.git` ثم push

## ملاحظة تقنية
حالة الحفظ داخل مسار AUTO تُعاد إلى الماسح نفسه (وليس إلى مسار منتج/كرتون) عبر `autoLane` — نجاح أو فشل تحقق. اختبار الموحّدات يثبت ذلك.
