# 📘 دليل الإعداد بالعربي

## الخطوات الكاملة لربط Yeastar بـ n8n

---

## 1️⃣ رفع المشروع على GitHub

### أ. إنشاء Repository جديد

1. روح [github.com](https://github.com)
2. اضغط **+** → **New repository**
3. اسم الـ Repository: `yeastar-n8n-bridge`
4. اختار **Public** أو **Private**
5. **لا تضيف** README أو .gitignore أو License
6. اضغط **Create repository**

### ب. رفع الملفات

#### الطريقة الأولى: GitHub Desktop
```
1. حمّل GitHub Desktop من: desktop.github.com
2. افتحه واعمل Sign in
3. File → Add Local Repository
4. اختار مجلد المشروع
5. اعمل Commit: "Initial commit"
6. Publish Repository
```

#### الطريقة الثانية: Command Line
```bash
cd yeastar-n8n-bridge
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/USERNAME/yeastar-n8n-bridge.git
git push -u origin main
```

✅ **المشروع دلوقتي على GitHub!**

---

## 2️⃣ Deploy على Railway

### أ. إنشاء Project

1. روح [railway.app](https://railway.app)
2. Sign in with GitHub
3. **New Project** → **Deploy from GitHub repo**
4. اختار `yeastar-n8n-bridge`
5. اضغط **Deploy Now**

⏳ انتظر دقيقة... Railway بيبني المشروع

### ب. إضافة Environment Variables

```
اضغط على الـ service → Variables

أضف المتغيرات التالية:

N8N_WEBHOOK_URL = https://n8n.engosoft.com/webhook/audio-processing

YEASTAR_BASE_URL = https://engosoft-pbx.ras.yeastar.com

YEASTAR_API_TOKEN = [هتجيبه من الخطوة التالية]

TOKEN_REFRESH_ENABLED = true

YEASTAR_CLIENT_ID = [من Yeastar API]

YEASTAR_CLIENT_SECRET = [من Yeastar API]
```

### ج. Generate Domain

```
Settings → Networking → Generate Domain

النتيجة:
https://yeastar-n8n-bridge-production.up.railway.app

احفظ الرابط ده!
```

✅ **Railway شغال!**

---

## 3️⃣ إعداد Yeastar PBX

### أ. تفعيل API

```
1. Login: https://engosoft-pbx.ras.yeastar.com
2. Integrations → API
3. Enable API: ON
```

### ب. إنشاء Application

```
اضغط Add:

Application Name: n8n Bridge
Permissions:
  ✅ Call Recording (read)
  ✅ CDR (read)
  
احفظ التطبيق

هتحصل على:
- Client ID: abc123...
- Client Secret: xyz789...

انسخهم!
```

### ج. الحصول على Access Token

استخدم curl أو Postman:

```bash
curl -X POST https://engosoft-pbx.ras.yeastar.com/openapi/v1.0/get_token \
  -H "Content-Type: application/json" \
  -H "User-Agent: OpenAPI" \
  -d '{
    "username": "CLIENT_ID_بتاعك",
    "password": "CLIENT_SECRET_بتاعك"
  }'
```

النتيجة:
```json
{
  "access_token": "xyz123abc456...",
  "expires_in": 1800
}
```

### د. إضافة Webhook URL

```
Integrations → API → Application Settings
اختار التطبيق اللي عملته

Webhook Event Push:
  URL: https://your-railway-app.railway.app/yeastar-webhook
  
Events:
  ✅ NewCdr

احفظ
```

✅ **Yeastar جاهز!**

---

## 4️⃣ إعداد n8n Workflow

### أ. إنشاء Workflow جديد

```
1. Login: https://n8n.engosoft.com
2. + New workflow
3. الاسم: "Yeastar Call Transcription"
```

### ب. إضافة Webhook Node

```
ابحث عن: Webhook
اسحبه للـ canvas

الإعدادات:
  HTTP Method: POST
  Path: audio-processing
  Respond: Immediately
  Response Code: 200

احفظ واضغط Execute Node

انسخ الـ Webhook URL
```

### ج. إضافة OpenAI Node

```
ابحث عن: OpenAI
وصّله بالـ Webhook

الإعدادات:
  Resource: Audio
  Operation: Transcribe
  Model: whisper-1
  
  File:
    - Binary Data: ON
    - Binary Property: file
  
  Language: ar (أو en)
  
  API Key: [OpenAI API Key بتاعك]
```

### د. إضافة Google Sheets Node (اختياري)

```
ابحث عن: Google Sheets
وصّله بالـ OpenAI

الإعدادات:
  Resource: Sheet
  Operation: Append
  
  Spreadsheet: [اختار الملف]
  Sheet: [اختار الورقة]
  
  Columns:
    call_id: {{$json.call_id}}
    transcript: {{$json.text}}
    duration: {{$json.duration}}
    caller: {{$json.caller_number}}
    date: {{$json.start_time}}
```

### هـ. تفعيل Workflow

```
اضغط Active من فوق (الزرار الأخضر)
```

✅ **n8n Workflow جاهز!**

---

## 5️⃣ الاختبار النهائي

### أ. تحديث Railway Variables

ارجع لـ Railway → Variables:
```
N8N_WEBHOOK_URL = [الـ URL من n8n]
```

احفظ - الـ service هيعمل restart تلقائي

### ب. اختبار Health Check

افتح في البراوزر:
```
https://your-railway-app.railway.app/
```

لو شفت:
```json
{
  "status": "OK",
  "service": "Yeastar-n8n Bridge Server"
}
```

يبقى تمام! ✅

### ج. عمل مكالمة تجريبية

```
1. اتصل من أي extension على Yeastar
2. اتكلم شوية (10 ثواني)
3. اقفل الخط
```

### د. تتبع المسار

#### شوف Railway Logs:
```
Service → Logs

هتشوف:
📞 Received webhook from Yeastar
📥 Downloading recording...
✅ Downloaded audio: 123456 bytes
📤 Sending to n8n...
✅ Successfully sent to n8n
```

#### شوف n8n Executions:
```
n8n → Executions

هتشوف الـ workflow اتنفذ ✅
```

#### شوف Google Sheets:
```
افتح الملف - هتلاقي سطر جديد!
```

---

## 🎉 مبروك! النظام شغال 100%

### الخلاصة:

```
✅ Railway Bridge شغال
✅ Yeastar بيبعت webhooks
✅ n8n بيستقبل ويعالج
✅ الصوت بيتحول لنص
✅ النتيجة بتتحفظ
```

---

## 🔧 Troubleshooting (حل المشاكل)

### مشكلة: Railway مش شغال

```
الحل:
1. شوف Logs في Railway
2. تأكد من Environment Variables صح
3. تأكد من package.json موجود
```

### مشكلة: Yeastar مش بيبعت webhook

```
الحل:
1. تأكد من Webhook URL صحيح
2. تأكد من NewCdr event مفعّل
3. جرب /test endpoint أولاً
4. شوف Yeastar logs
```

### مشكلة: Token expired

```
الحل:
1. تأكد من TOKEN_REFRESH_ENABLED = true
2. تأكد من Client ID و Secret صح
3. أو اعمل refresh يدوي كل 25 دقيقة
```

### مشكلة: n8n مش بيستقبل

```
الحل:
1. تأكد من Workflow active
2. تأكد من Webhook URL في Railway صح
3. اضغط Execute Node في الـ Webhook
4. جرب تبعت POST request يدوي
```

---

## 📞 محتاج مساعدة؟

```
1. شوف Railway Logs
2. شوف n8n Executions
3. شوف Yeastar API logs
4. ابعت الـ logs في issue على GitHub
```

---

**Good luck! 🚀**
