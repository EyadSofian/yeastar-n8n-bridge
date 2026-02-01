# 🧪 Testing Guide

## Local Testing

### 1. Start the Server

```bash
npm start
```

### 2. Test Health Check

```bash
curl http://localhost:3000/
```

Expected response:
```json
{
  "status": "OK",
  "service": "Yeastar-n8n Bridge Server",
  "version": "1.0.0"
}
```

### 3. Test Endpoint

```bash
curl -X POST http://localhost:3000/test \
  -H "Content-Type: application/json" \
  -d '{"test": "hello from curl"}'
```

Expected response:
```json
{
  "status": "OK",
  "message": "Test successful",
  "received_data": {
    "test": "hello from curl"
  }
}
```

## Testing Yeastar Webhook

### Simulate Yeastar Webhook (Method 1: With Recording URL)

```bash
curl -X POST http://localhost:3000/yeastar-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "call_id": "test_123",
    "recording_url": "https://file-examples.com/wp-content/uploads/2017/11/file_example_WAV_1MG.wav",
    "duration": "30",
    "caller_number": "201234567890",
    "callee_number": "6001",
    "start_time": "2025-02-01T10:00:00Z",
    "end_time": "2025-02-01T10:00:30Z"
  }'
```

### Simulate Yeastar Webhook (Method 2: Minimal Data)

```bash
curl -X POST http://localhost:3000/yeastar-webhook \
  -H "Content-Type: application/json" \
  -d '{
    "call_id": "1738436262.123",
    "recording_id": "rec_123",
    "duration": "120"
  }'
```

## Testing with Postman

### Import this Collection:

```json
{
  "info": {
    "name": "Yeastar Bridge Tests",
    "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"
  },
  "item": [
    {
      "name": "Health Check",
      "request": {
        "method": "GET",
        "header": [],
        "url": {
          "raw": "http://localhost:3000/",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": [""]
        }
      }
    },
    {
      "name": "Test Endpoint",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"test\": \"data\"\n}"
        },
        "url": {
          "raw": "http://localhost:3000/test",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": ["test"]
        }
      }
    },
    {
      "name": "Webhook Test",
      "request": {
        "method": "POST",
        "header": [
          {
            "key": "Content-Type",
            "value": "application/json"
          }
        ],
        "body": {
          "mode": "raw",
          "raw": "{\n  \"call_id\": \"test_123\",\n  \"recording_url\": \"https://file-examples.com/wp-content/uploads/2017/11/file_example_WAV_1MG.wav\",\n  \"duration\": \"30\"\n}"
        },
        "url": {
          "raw": "http://localhost:3000/yeastar-webhook",
          "protocol": "http",
          "host": ["localhost"],
          "port": "3000",
          "path": ["yeastar-webhook"]
        }
      }
    }
  ]
}
```

## Testing on Railway

### 1. Test Deployed Health Check

```bash
curl https://your-app.railway.app/
```

### 2. Test from Yeastar

Configure Yeastar webhook to point to:
```
https://your-app.railway.app/yeastar-webhook
```

Make a test call on Yeastar and watch Railway logs.

## Monitoring Logs

### Railway Logs

```
Service → Logs (in Railway dashboard)
```

Look for these patterns:

✅ **Success:**
```
✅ Server running on port 3000
📞 Received webhook from Yeastar
✅ Downloaded audio: 123456 bytes
✅ Successfully sent to n8n
```

❌ **Errors:**
```
❌ Failed to download recording: HTTP 401
❌ n8n webhook failed: HTTP 500
```

### n8n Logs

```
Workflow → Executions
```

Check for successful executions with audio file data.

## Common Test Scenarios

### Scenario 1: Valid Recording with Direct URL

**Input:**
```json
{
  "call_id": "123",
  "recording_url": "https://example.com/recording.wav",
  "duration": "60"
}
```

**Expected:** ✅ Success - Audio downloaded and sent to n8n

### Scenario 2: Recording via API (Token Required)

**Input:**
```json
{
  "call_id": "456",
  "recording_id": "rec_789",
  "duration": "120"
}
```

**Expected:** ✅ Success if token valid, ❌ 401 if expired

### Scenario 3: No Recording Available

**Input:**
```json
{
  "call_id": "999",
  "duration": "30"
}
```

**Expected:** ✅ Success response but no processing

### Scenario 4: Invalid n8n URL

**Setup:** Set wrong N8N_WEBHOOK_URL

**Expected:** ❌ Error "n8n webhook failed"

## Performance Testing

### Test Multiple Concurrent Calls

```bash
# Install hey (HTTP load testing tool)
# brew install hey (Mac)
# apt-get install hey (Linux)

hey -n 10 -c 2 -m POST \
  -H "Content-Type: application/json" \
  -d '{"call_id":"perf_test","recording_url":"https://example.com/test.wav"}' \
  http://localhost:3000/yeastar-webhook
```

## Troubleshooting Tests

### Issue: Connection Refused

**Solution:**
```bash
# Check if server is running
netstat -an | grep 3000

# Restart server
npm start
```

### Issue: 401 Unauthorized

**Solution:**
```bash
# Refresh Yeastar token
# Or enable TOKEN_REFRESH_ENABLED=true
```

### Issue: n8n Not Receiving

**Solution:**
```bash
# Test n8n webhook directly
curl -X POST https://n8n.engosoft.com/webhook/audio-processing \
  -F "file=@test.wav" \
  -F "call_id=direct_test"
```

## Automated Testing (Future)

```bash
# Install test dependencies
npm install --save-dev jest supertest

# Run tests
npm test
```

Example test structure:
```javascript
// tests/webhook.test.js
const request = require('supertest');
const app = require('../server');

describe('Webhook Endpoint', () => {
  it('should return 200 for valid webhook', async () => {
    const response = await request(app)
      .post('/yeastar-webhook')
      .send({
        call_id: 'test_123',
        recording_url: 'https://example.com/test.wav'
      });
    
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });
});
```

---

**Happy Testing! 🧪**
