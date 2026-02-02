require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Readable } = require('stream');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment variables
const CONFIG = {
  PORT: process.env.PORT || 3000,
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  YEASTAR_BASE_URL: process.env.YEASTAR_BASE_URL || 'https://engosoft-pbx.ras.yeastar.com',
  YEASTAR_API_TOKEN: process.env.YEASTAR_API_TOKEN || '',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  TRANSCRIPTION_LANGUAGE: process.env.TRANSCRIPTION_LANGUAGE || 'ar',
  ENABLE_LOGGING: process.env.ENABLE_LOGGING !== 'false',
  TOKEN_REFRESH_ENABLED: process.env.TOKEN_REFRESH_ENABLED === 'true',
  YEASTAR_CLIENT_ID: process.env.YEASTAR_CLIENT_ID || '',
  YEASTAR_CLIENT_SECRET: process.env.YEASTAR_CLIENT_SECRET || '',
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '60000')
};

// Token state management
let tokenState = {
  token: CONFIG.YEASTAR_API_TOKEN,
  lastRefresh: null,
  refreshAttempts: 0,
  isRefreshing: false
};

// Logging helper
function log(level, message, data = null) {
  if (!CONFIG.ENABLE_LOGGING && level === 'debug') return;
  
  const timestamp = new Date().toISOString();
  const emoji = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌',
    debug: '🔍'
  }[level] || '📝';
  
  console.log(`${emoji} [${timestamp}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

// Token refresh with retry logic
async function refreshYeastarToken(isRetry = false) {
  if (!CONFIG.TOKEN_REFRESH_ENABLED) return;
  
  if (tokenState.isRefreshing && !isRetry) {
    log('debug', 'Token refresh already in progress');
    return;
  }
  
  tokenState.isRefreshing = true;
  
  try {
    log('info', `🔄 Refreshing Yeastar token (attempt ${tokenState.refreshAttempts + 1})`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const response = await fetch(`${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/get_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'OpenAPI'
      },
      body: JSON.stringify({
        username: CONFIG.YEASTAR_CLIENT_ID,
        password: CONFIG.YEASTAR_CLIENT_SECRET
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: HTTP ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.errcode !== 0) {
      throw new Error(`Token refresh error: ${data.errmsg}`);
    }
    
    if (!data.access_token) {
      throw new Error('No access_token in response');
    }
    
    tokenState.token = data.access_token;
    tokenState.lastRefresh = new Date();
    tokenState.refreshAttempts = 0;
    CONFIG.YEASTAR_API_TOKEN = data.access_token;
    
    log('success', '🔑 Token refreshed successfully', {
      expires_in: data.access_token_expire_time,
      last_refresh: tokenState.lastRefresh.toISOString()
    });
    
    // Schedule next refresh (25 minutes)
    setTimeout(() => refreshYeastarToken(), 25 * 60 * 1000);
    
  } catch (error) {
    tokenState.refreshAttempts++;
    
    log('error', '❌ Token refresh failed', {
      error: error.message,
      attempt: tokenState.refreshAttempts
    });
    
    if (tokenState.refreshAttempts < 3) {
      const retryDelay = Math.min(1000 * Math.pow(2, tokenState.refreshAttempts), 30000);
      log('info', `⏳ Retrying in ${retryDelay}ms`);
      setTimeout(() => refreshYeastarToken(true), retryDelay);
    } else {
      log('error', '🚨 Token refresh failed after 3 attempts');
      tokenState.refreshAttempts = 0;
    }
  } finally {
    tokenState.isRefreshing = false;
  }
}

// Start token refresh if enabled
if (CONFIG.TOKEN_REFRESH_ENABLED) {
  refreshYeastarToken();
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Yeastar-n8n Bridge with OpenAPI v1.0',
    version: '3.5.0-openapi',
    timestamp: new Date().toISOString(),
    config: {
      n8n_configured: !!CONFIG.N8N_WEBHOOK_URL,
      yeastar_configured: !!tokenState.token,
      openai_configured: !!CONFIG.OPENAI_API_KEY,
      transcription_language: CONFIG.TRANSCRIPTION_LANGUAGE,
      token_refresh: CONFIG.TOKEN_REFRESH_ENABLED,
      last_token_refresh: tokenState.lastRefresh?.toISOString() || 'never'
    }
  });
});

app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    checks: {
      api_token: !!tokenState.token,
      openai_key: !!CONFIG.OPENAI_API_KEY,
      n8n_webhook: !!CONFIG.N8N_WEBHOOK_URL
    }
  };
  
  const allHealthy = Object.values(health.checks).every(v => v);
  res.status(allHealthy ? 200 : 503).json(health);
});

// Main webhook endpoint
app.post('/yeastar-webhook', async (req, res) => {
  const startTime = Date.now();
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    log('info', `📞 [${requestId}] Webhook received from Yeastar`);
    log('debug', `[${requestId}] Payload:`, req.body);
    
    const callData = extractCallData(req.body);
    
    if (!callData.hasRecording) {
      log('warning', `[${requestId}] No recording for call ${callData.call_id}`);
      return res.json({ 
        success: true, 
        message: 'No recording to process',
        call_id: callData.call_id,
        request_id: requestId
      });
    }
    
    log('info', `📥 [${requestId}] Downloading: ${callData.recording_filename}`);
    
    // Download with OpenAPI two-step process
    const audioBuffer = await downloadRecordingOpenAPI(callData, requestId);
    
    log('success', `[${requestId}] Downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Respond to Yeastar quickly
    res.json({
      success: true,
      message: 'Recording downloaded, processing...',
      call_id: callData.call_id,
      request_id: requestId,
      audio_size_mb: (audioBuffer.length / 1024 / 1024).toFixed(2)
    });
    
    // Process asynchronously
    processRecordingAsync(audioBuffer, callData, requestId).catch(error => {
      log('error', `[${requestId}] Async processing failed:`, { error: error.message });
    });
    
  } catch (error) {
    log('error', `[${requestId}] Error:`, {
      error: error.message,
      stack: CONFIG.ENABLE_LOGGING ? error.stack : undefined
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      request_id: requestId
    });
  }
});

app.post('/test', (req, res) => {
  log('info', '🧪 Test endpoint');
  res.json({
    status: 'OK',
    message: 'Test successful',
    received: req.body
  });
});

app.post('/admin/refresh-token', async (req, res) => {
  try {
    await refreshYeastarToken(true);
    res.json({
      success: true,
      last_refresh: tokenState.lastRefresh?.toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function extractCallData(webhookPayload) {
  const recordingFileName = webhookPayload.recording || 
                           webhookPayload.recordingfile || 
                           null;
  
  return {
    call_id: webhookPayload.call_id || 
             webhookPayload.callid || 
             webhookPayload.uniqueid || 
             'unknown',
    
    recording_filename: recordingFileName,
    
    duration: webhookPayload.call_duration || 
              webhookPayload.duration || 
              webhookPayload.billsec || 
              '0',
    
    talk_duration: webhookPayload.talk_duration || '0',
    
    caller_number: webhookPayload.call_from || 
                   webhookPayload.caller_number || 
                   webhookPayload.src || 
                   '',
    
    callee_number: webhookPayload.call_to || 
                   webhookPayload.callee_number || 
                   webhookPayload.dst || 
                   '',
    
    start_time: webhookPayload.time_start || 
                webhookPayload.start_time || 
                new Date().toISOString(),
    
    end_time: webhookPayload.end_time || 
              new Date().toISOString(),
    
    status: webhookPayload.status || 'ANSWERED',
    
    call_type: webhookPayload.type || 'Unknown',
    
    trunk_name: webhookPayload.dst_trunk_name || 
                webhookPayload.src_trunk_name || '',
    
    hasRecording: !!recordingFileName
  };
}

// ✅ NEW: OpenAPI v1.0 Two-Step Download Process
async function downloadRecordingOpenAPI(callData, requestId) {
  if (!callData.recording_filename) {
    throw new Error('No recording filename provided');
  }
  
  if (!tokenState.token) {
    throw new Error('No API token available');
  }
  
  log('info', `🔗 [${requestId}] Step 1: Getting download URL (30-min validity)`);
  
  const controller1 = new AbortController();
  const timeout1 = setTimeout(() => controller1.abort(), 30000);
  
  try {
    // Step 1: Get download URL (valid for 30 minutes)
    const metaResponse = await fetch(
      `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?file=${encodeURIComponent(callData.recording_filename)}&access_token=${tokenState.token}`,
      {
        method: 'GET',
        headers: {
          'User-Agent': 'Yeastar-n8n-Bridge/3.5'
        },
        signal: controller1.signal
      }
    );
    
    clearTimeout(timeout1);
    
    if (!metaResponse.ok) {
      const errorText = await metaResponse.text();
      
      // Check for token expiration
      if (metaResponse.status === 401 || errorText.includes('TOKEN EXPIRED')) {
        log('warning', `[${requestId}] Token expired, refreshing...`);
        
        if (CONFIG.TOKEN_REFRESH_ENABLED) {
          await refreshYeastarToken(true);
          // Retry with new token
          return await downloadRecordingOpenAPI(callData, requestId);
        } else {
          throw new Error('Token expired and auto-refresh is disabled');
        }
      }
      
      throw new Error(`Failed to get download URL: HTTP ${metaResponse.status} - ${errorText}`);
    }
    
    const metaData = await metaResponse.json();
    
    log('debug', `[${requestId}] Meta response:`, metaData);
    
    if (metaData.errcode && metaData.errcode !== 0) {
      // Handle specific error codes
      if (metaData.errcode === 10004) {
        log('warning', `[${requestId}] Token expired (errcode 10004), refreshing...`);
        
        if (CONFIG.TOKEN_REFRESH_ENABLED) {
          await refreshYeastarToken(true);
          return await downloadRecordingOpenAPI(callData, requestId);
        }
      }
      
      throw new Error(`Yeastar API error ${metaData.errcode}: ${metaData.errmsg}`);
    }
    
    if (!metaData.download_resource_url) {
      throw new Error('No download_resource_url in response');
    }
    
    log('success', `[${requestId}] Got download URL: ${metaData.download_resource_url}`);
    log('info', `📥 [${requestId}] Step 2: Downloading audio file`);
    
    // Step 2: Download the actual file (30-minute window)
    const fullDownloadUrl = `${CONFIG.YEASTAR_BASE_URL}${metaData.download_resource_url}?access_token=${tokenState.token}`;
    
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), CONFIG.REQUEST_TIMEOUT);
    
    const audioResponse = await fetch(fullDownloadUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Yeastar-n8n-Bridge/3.5'
      },
      signal: controller2.signal
    });
    
    clearTimeout(timeout2);
    
    if (!audioResponse.ok) {
      const errorText = await audioResponse.text();
      throw new Error(`Download failed: HTTP ${audioResponse.status} - ${errorText}`);
    }
    
    const buffer = await audioResponse.buffer();
    
    // Validate file size
    if (buffer.length < 1000) {
      const bodyText = buffer.toString('utf-8');
      log('error', `[${requestId}] File too small (${buffer.length} bytes):`, bodyText);
      throw new Error(`Invalid audio file: ${bodyText}`);
    }
    
    log('debug', `[${requestId}] Download complete`, {
      size_bytes: buffer.length,
      size_mb: (buffer.length / 1024 / 1024).toFixed(2),
      content_type: audioResponse.headers.get('content-type')
    });
    
    return buffer;
    
  } catch (error) {
    clearTimeout(timeout1);
    
    if (error.name === 'AbortError') {
      throw new Error('Download timeout');
    }
    
    throw error;
  }
}

// Async processing after download
async function processRecordingAsync(audioBuffer, callData, requestId) {
  try {
    log('info', `🎤 [${requestId}] Starting transcription`);
    
    const transcription = await transcribeAudio(audioBuffer, callData, requestId);
    
    log('success', `[${requestId}] Transcription complete: ${transcription.text?.length || 0} chars`);
    
    if (CONFIG.N8N_WEBHOOK_URL) {
      log('info', `📤 [${requestId}] Sending to n8n`);
      await sendToN8n(transcription, callData, requestId);
      log('success', `[${requestId}] Sent to n8n successfully`);
    }
    
  } catch (error) {
    log('error', `[${requestId}] Processing error:`, { error: error.message });
    throw error;
  }
}

async function transcribeAudio(audioBuffer, callData, requestId) {
  if (!CONFIG.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured');
  }
  
  log('info', `🎙️ [${requestId}] Transcribing with Whisper`);
  
  const form = new FormData();
  
  const stream = new Readable();
  stream.push(audioBuffer);
  stream.push(null);
  
  form.append('file', stream, {
    filename: `call_${callData.call_id}.wav`,
    contentType: 'audio/wav',
    knownLength: audioBuffer.length
  });
  
  form.append('model', 'whisper-1');
  form.append('language', CONFIG.TRANSCRIPTION_LANGUAGE);
  form.append('response_format', 'verbose_json');
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  
  try {
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      body: form,
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI error: HTTP ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    log('success', `[${requestId}] Transcription success`, {
      text_length: result.text?.length,
      language: result.language,
      duration: result.duration
    });
    
    return result;
    
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('Transcription timeout');
    }
    throw error;
  }
}

async function sendToN8n(transcription, callData, requestId) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    return { skipped: true };
  }
  
  const data = {
    call_id: callData.call_id,
    transcript: transcription.text,
    language: transcription.language,
    duration: transcription.duration || callData.duration,
    talk_duration: callData.talk_duration,
    caller_number: callData.caller_number,
    callee_number: callData.callee_number,
    start_time: callData.start_time,
    end_time: callData.end_time,
    status: callData.status,
    call_type: callData.call_type,
    trunk_name: callData.trunk_name,
    transcription_date: new Date().toISOString(),
    word_count: transcription.text ? transcription.text.split(/\s+/).length : 0,
    request_id: requestId
  };
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`n8n error: HTTP ${response.status} - ${errorText}`);
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
      return await response.json();
    } else {
      return { message: await response.text() };
    }
    
  } catch (error) {
    clearTimeout(timeout);
    if (error.name === 'AbortError') {
      throw new Error('n8n timeout');
    }
    throw error;
  }
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /yeastar-webhook',
      'POST /test',
      'POST /admin/refresh-token'
    ]
  });
});

app.use((err, req, res, next) => {
  log('error', 'Unhandled error:', { error: err.message });
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  log('success', '🚀 Yeastar-n8n Bridge Started (OpenAPI v1.0)');
  console.log('='.repeat(70));
  log('info', `📡 Port: ${CONFIG.PORT}`);
  log('info', `🔗 Webhook: /yeastar-webhook`);
  log('info', `🔗 Health: /health`);
  console.log('='.repeat(70));
  log('info', `✅ n8n: ${CONFIG.N8N_WEBHOOK_URL || '⚠️ NOT SET'}`);
  log('info', `✅ Yeastar: ${CONFIG.YEASTAR_BASE_URL}`);
  log('info', `✅ Token: ${tokenState.token ? '✅ SET' : '⚠️ NOT SET'}`);
  log('info', `✅ OpenAI: ${CONFIG.OPENAI_API_KEY ? '✅ SET' : '⚠️ NOT SET'}`);
  log('info', `✅ Language: ${CONFIG.TRANSCRIPTION_LANGUAGE}`);
  log('info', `✅ Auto-Refresh: ${CONFIG.TOKEN_REFRESH_ENABLED ? 'ON' : 'OFF'}`);
  console.log('='.repeat(70) + '\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('info', 'SIGTERM - shutting down...');
  server.close(() => {
    log('success', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('info', 'SIGINT - shutting down...');
  server.close(() => {
    log('success', 'Server closed');
    process.exit(0);
  });
});
