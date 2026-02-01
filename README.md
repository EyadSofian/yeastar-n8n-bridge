# 🌉 Yeastar-n8n Bridge Server

Bridge server that connects Yeastar PBX with n8n for automated call recording processing, transcription, and analysis.

## 📋 Overview

This bridge server acts as a middleware between:
- **Yeastar PBX** (receives webhooks when calls end)
- **n8n** (processes recordings with AI/automation workflows)

```
Yeastar PBX → Webhook → This Bridge → Downloads Recording → Sends to n8n → AI Processing
```

## ✨ Features

- ✅ **Automatic webhook handling** from Yeastar PBX
- ✅ **Recording download** via Yeastar API or direct URL
- ✅ **Seamless forwarding** to n8n workflows
- ✅ **Token auto-refresh** (optional) for long-running deployments
- ✅ **Detailed logging** for debugging
- ✅ **Health checks** and monitoring endpoints
- ✅ **Error handling** and graceful shutdown

## 🚀 Quick Start

### 1. Prerequisites

- Node.js 18+ installed
- Yeastar PBX with API access
- n8n instance running
- Railway account (for deployment)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/yeastar-n8n-bridge.git
cd yeastar-n8n-bridge

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit .env with your configuration
nano .env
```

### 3. Configuration

Edit `.env` file with your settings:

```env
# Server
PORT=3000

# n8n Webhook URL
N8N_WEBHOOK_URL=https://your-n8n.com/webhook/audio-processing

# Yeastar Configuration
YEASTAR_BASE_URL=https://your-pbx.ras.yeastar.com
YEASTAR_API_TOKEN=your_access_token

# Optional: Auto-refresh tokens
TOKEN_REFRESH_ENABLED=false
YEASTAR_CLIENT_ID=your_client_id
YEASTAR_CLIENT_SECRET=your_client_secret
```

### 4. Get Yeastar API Token

#### Method 1: Using curl

```bash
curl -X POST https://your-pbx.ras.yeastar.com/openapi/v1.0/get_token \
  -H "Content-Type: application/json" \
  -H "User-Agent: OpenAPI" \
  -d '{
    "username": "YOUR_CLIENT_ID",
    "password": "YOUR_CLIENT_SECRET"
  }'
```

#### Method 2: Using the PBX Web Interface

1. Login to Yeastar PBX
2. Go to **Integrations → API**
3. Create a new Application
4. Note the **Client ID** and **Client Secret**
5. Use them to get the access token (expires in 30 minutes)

### 5. Run Locally

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

Server will start on `http://localhost:3000`

### 6. Test the Bridge

```bash
# Health check
curl http://localhost:3000/

# Test endpoint
curl -X POST http://localhost:3000/test \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}'
```

## 🚂 Deploy to Railway

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/yeastar-n8n-bridge.git
git push -u origin main
```

### 2. Deploy on Railway

1. Login to [railway.app](https://railway.app)
2. Click **New Project** → **Deploy from GitHub repo**
3. Select your repository
4. Railway will auto-detect the Node.js project

### 3. Set Environment Variables on Railway

Go to your project → **Variables** → Add these:

```
N8N_WEBHOOK_URL=https://n8n.engosoft.com/webhook/audio-processing
YEASTAR_BASE_URL=https://engosoft-pbx.ras.yeastar.com
YEASTAR_API_TOKEN=your_token_here
TOKEN_REFRESH_ENABLED=true
YEASTAR_CLIENT_ID=your_client_id
YEASTAR_CLIENT_SECRET=your_client_secret
```

### 4. Generate Railway Domain

1. Go to **Settings** → **Networking**
2. Click **Generate Domain**
3. Copy the URL (e.g., `https://yeastar-n8n-bridge-production.up.railway.app`)

## ⚙️ Configure Yeastar Webhook

1. Login to Yeastar PBX
2. Go to **Integrations → API**
3. Edit your Application
4. Set **Webhook URL**: `https://your-railway-app.railway.app/yeastar-webhook`
5. Subscribe to **NewCdr** event
6. Save

## 🔧 n8n Workflow Setup

### Create Webhook Node

1. In n8n, create a new workflow
2. Add **Webhook** node:
   - HTTP Method: `POST`
   - Path: `audio-processing`
   - Respond: `Immediately`

3. Add **OpenAI** node:
   - Resource: `Audio`
   - Operation: `Transcribe`
   - Model: `whisper-1`
   - File: From binary data → `file`

4. Add your storage node (Google Sheets, Database, etc.)

5. **Activate** the workflow

6. Copy the webhook URL and set it in Railway's `N8N_WEBHOOK_URL` variable

## 📡 API Endpoints

### `GET /`
Health check endpoint

**Response:**
```json
{
  "status": "OK",
  "service": "Yeastar-n8n Bridge Server",
  "version": "1.0.0",
  "timestamp": "2025-02-01T12:00:00.000Z"
}
```

### `POST /yeastar-webhook`
Main webhook endpoint for Yeastar PBX

**Request Body:** (from Yeastar)
```json
{
  "call_id": "1738436262.123",
  "recording_url": "https://...",
  "duration": "120",
  "caller_number": "+201234567890",
  "callee_number": "6001"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Recording processed and sent to n8n",
  "call_id": "1738436262.123",
  "processing_time_ms": 1234
}
```

### `POST /test`
Test endpoint for debugging

### `POST /manual-trigger`
Manually trigger processing with a recording URL

## 📊 Monitoring & Logs

### View Railway Logs

```bash
# In Railway dashboard
Service → Logs
```

Look for:
- ✅ `Received webhook from Yeastar`
- ✅ `Downloaded audio: X bytes`
- ✅ `Successfully sent to n8n`

### Common Log Messages

```
✅ Server running on port 3000
📞 Received webhook from Yeastar
📥 Downloading recording for call: 1738436262.123
✅ Audio downloaded: 123456 bytes
📤 Sending to n8n: https://...
✅ Successfully sent to n8n
```

## 🔍 Troubleshooting

### Problem: Yeastar not sending webhooks

**Solutions:**
1. Check webhook URL is correct in Yeastar
2. Verify API application is enabled
3. Ensure NewCdr event is subscribed
4. Check Yeastar logs for webhook delivery errors

### Problem: Recording download fails

**Solutions:**
1. Verify `YEASTAR_API_TOKEN` is valid (tokens expire after 30 minutes)
2. Enable `TOKEN_REFRESH_ENABLED=true` for auto-refresh
3. Check API permissions include "Call Recording (read)"

### Problem: n8n not receiving data

**Solutions:**
1. Verify `N8N_WEBHOOK_URL` is correct
2. Check n8n workflow is **Active**
3. Test n8n webhook directly with curl
4. Check n8n execution logs

### Problem: 401 Unauthorized errors

**Solutions:**
1. Token expired - refresh it or enable auto-refresh
2. Check Client ID and Secret are correct
3. Verify API application has required permissions

## 🔐 Security Notes

- Never commit `.env` file to Git
- Rotate API tokens regularly
- Use HTTPS for all webhook URLs
- Enable token auto-refresh for production
- Monitor Railway logs for suspicious activity

## 📝 Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: 3000) |
| `N8N_WEBHOOK_URL` | Yes | Your n8n webhook endpoint |
| `YEASTAR_BASE_URL` | Yes | Yeastar PBX base URL |
| `YEASTAR_API_TOKEN` | Yes* | API access token |
| `TOKEN_REFRESH_ENABLED` | No | Auto-refresh tokens (default: false) |
| `YEASTAR_CLIENT_ID` | Yes** | OAuth client ID |
| `YEASTAR_CLIENT_SECRET` | Yes** | OAuth client secret |
| `ENABLE_LOGGING` | No | Enable detailed logs (default: true) |

\* Required if TOKEN_REFRESH_ENABLED is false  
\** Required if TOKEN_REFRESH_ENABLED is true

## 🛠️ Development

```bash
# Install dependencies
npm install

# Run in development mode (auto-reload)
npm run dev

# Run tests (if you add them)
npm test
```

## 📄 License

MIT License - feel free to use this in your projects!

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📧 Support

For issues and questions:
- Check the troubleshooting section above
- Review Railway logs for error messages
- Open an issue on GitHub

## 🎯 Roadmap

- [ ] Add support for real-time WebSocket audio streaming
- [ ] Built-in retry mechanism for failed n8n deliveries
- [ ] Queue system for high-volume scenarios
- [ ] Dashboard for monitoring call processing
- [ ] Support for multiple n8n webhooks
- [ ] Advanced filtering and routing rules

---

Made with ❤️ for automating call transcription workflows
