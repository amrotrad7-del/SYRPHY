# نقل SYRPHY إلى Cloudflare — مجاني وسخي (100,000 طلب/يوم)

## المرة الوحدة بس — 4 خطوات:

### 1) ارفع الملفات على GitHub
1. افتح github.com وسجل حساب مجاني
2. زر + (فوق) → New repository → الاسم: syrphy → Create
3. بصفحة المستودع: "uploading an existing file" → اسحب **كل ملفات هالمجلد**
   (مع مجلد functions كامل) → Commit changes

### 2) اربطه بـ Cloudflare Pages
1. dash.cloudflare.com → سجل حساب مجاني
2. Workers & Pages → Create → Pages → **Connect to Git**
3. اختار مستودع syrphy → Build settings اتركها فاضية كلها → Save and Deploy

### 3) قاعدة البيانات D1
1. من القائمة: Storage & Databases → **D1 SQL Database** → Create → الاسم: syrphy-db
2. ارجع لمشروع Pages → Settings → **Bindings** → Add → D1 database:
   - Variable name: **DB**  (بالظبط هيك، أحرف كبيرة)
   - D1 database: syrphy-db → Save

### 4) تفعيل الإشعارات (خطوة صغيرة)
Pages → Settings → Runtime → **Compatibility flags** → أضف: `nodejs_compat`
(للـ Production والـ Preview)

### أعد النشر
Deployments → Retry deployment (أو أي commit جديد)

## خلص 🎉
- موقعك: https://syrphy.pages.dev (أو الاسم يلي اخترته)
- كل شي نفسه: المدير 1573 · المستخدم 15733 · الدفتر /daftar.html
- الجدول بينشئ حاله — ما في SQL يدوي
- التحديثات لاحقاً: عدّل الملفات بمستودع GitHub (زر ✏️ أو ارفع فوقها) — بينشر لحاله

## ملاحظة
المنتجات القديمة بقاعدة Neon ما بتنتقل لحالها — أعد إضافتها من لوحة المدير
(أو قلي وبعملك أداة نقل تلقائية).
.
