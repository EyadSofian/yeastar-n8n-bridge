require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Readable } = require('stream');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CONFIG = {
  PORT: process.env.PORT || 3000,
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  YEASTAR_BASE_URL: process.env.YEASTAR_BASE_URL || 'https://engosoft-pbx.ras.yeastar.com',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  TRANSCRIPTION_LANGUAGE: process.env.TRANSCRIPTION_LANGUAGE || 'ar',
  YEASTAR_CLIENT_ID: process.env.YEASTAR_CLIENT_ID || '',
  YEASTAR_CLIENT_SECRET: process.env.YEASTAR_CLIENT_SECRET || '',
  ENABLE_LOGGING: process.env.ENABLE_LOGGING !== 'false'
};

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

// ✅ NEW APPROACH: Get fresh token for EVERY request
async function getFreshToken(requestId) {
  log('info', `🔑 [${requestId}] Getting FRESH token for this request`);
  
  try {
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
      timeout: 10000
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token request failed: HTTP ${response.status} - ${errorText}`);
    }
    
    const data = await response.json();
    
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`Token API error ${data.errcode}: ${data.errmsg}`);
    }
    
    if (!data.access_token) {
      throw new Error('No access_token in response');
    }
    
    log('success', `[${requestId}] Got fresh token (expires in ${data.access_token_expire_time}s)`);
    
    return data.access_token;
    
  } catch (error) {
    log('error', `[${requestId}] Failed to get fresh token:`, { error: error.message });
    throw error;
  }
}

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Yeastar-n8n Bridge - Fresh Token Per Request',
    version: '4.0.0-fresh-token',
    timestamp: new Date().toISOString(),
    config: {
      n8n_configured: !!CONFIG.N8N_WEBHOOK_URL,
      yeastar_configured: !!(CONFIG.YEASTAR_CLIENT_ID && CONFIG.YEASTAR_CLIENT_SECRET),
      openai_configured: !!CONFIG.OPENAI_API_KEY,
      transcription_language: CONFIG.TRANSCRIPTION_LANGUAGE
    }
  });
});

app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    checks: {
      yeastar_credentials: !!(CONFIG.YEASTAR_CLIENT_ID && CONFIG.YEASTAR_CLIENT_SECRET),
      openai_key: !!CONFIG.OPENAI_API_KEY,
      n8n_webhook: !!CONFIG.N8N_WEBHOOK_URL
    }
  };
  
  const allHealthy = Object.values(health.checks).every(v => v);
  res.status(allHealthy ? 200 : 503).json(health);
});

app.post('/yeastar-webhook', async (req, res) => {
  const startTime = Date.now();
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    log('info', `📞 [${requestId}] Webhook received`);
    log('debug', `[${requestId}] Payload:`, req.body);
    
    const callData = extractCallData(req.body);
    
    if (!callData.hasRecording) {
      log('warning', `[${requestId}] No recording for call ${callData.call_id}`);
      return res.json({ 
        success: true, 
        message: 'No recording to process',
        call_id: callData.call_id
      });
    }
    
    log('info', `[${requestId}] Recording: ${callData.recording_filename}`);
    
    // ✅ CRITICAL: Get FRESH token for this specific request
    const freshToken = await getFreshToken(requestId);
    
    // ✅ Download recording immediately with fresh token
    log('info', `[${requestId}] Downloading with fresh token...`);
    const audioBuffer = await downloadRecordingWithFreshToken(callData, freshToken, requestId);
    
    log('success', `[${requestId}] Downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Respond to Yeastar
    res.json({
      success: true,
      message: 'Recording downloaded, processing...',
      call_id: callData.call_id,
      request_id: requestId,
      audio_size_mb: (audioBuffer.length / 1024 / 1024).toFixed(2),
      download_time_ms: Date.now() - startTime
    });
    
    // Process async
    processRecordingAsync(audioBuffer, callData, requestId).catch(error => {
      log('error', `[${requestId}] Async processing error:`, { error: error.message });
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

function extractCallData(webhookPayload) {
  const recordingFileName = webhookPayload.recording || 
                           webhookPayload.recordingfile || 
                           null;
  
  return {
    call_id: webhookPayload.call_id || 'unknown',
    recording_filename: recordingFileName,
    duration: webhookPayload.call_duration || '0',
    talk_duration: webhookPayload.talk_duration || '0',
    caller_number: webhookPayload.call_from || '',
    callee_number: webhookPayload.call_to || '',
    start_time: webhookPayload.time_start || new Date().toISOString(),
    end_time: webhookPayload.end_time || new Date().toISOString(),
    status: webhookPayload.status || 'ANSWERED',
    call_type: webhookPayload.type || 'Unknown',
    trunk_name: webhookPayload.dst_trunk_name || webhookPayload.src_trunk_name || '',
    hasRecording: !!recordingFileName
  };
}

// ✅ Download with fresh token (no token expiry issues!)
async function downloadRecordingWithFreshToken(callData, token, requestId) {
  if (!callData.recording_filename) {
    throw new Error('No recording filename');
  }
  
  log('debug', `[${requestId}] Step 1: Get download URL`);
  
  // Step 1: Get download URL
  const metaUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?file=${encodeURIComponent(callData.recording_filename)}&access_token=${token}`;
  
  const metaResponse = await fetch(metaUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Yeastar-Bridge/4.0' }
  });
  
  if (!metaResponse.ok) {
    const errorText = await metaResponse.text();
    throw new Error(`Get URL failed: HTTP ${metaResponse.status} - ${errorText}`);
  }
  
  const metaData = await metaResponse.json();
  
  log('debug', `[${requestId}] Meta response:`, metaData);
  
  if (metaData.errcode && metaData.errcode !== 0) {
    throw new Error(`Yeastar error ${metaData.errcode}: ${metaData.errmsg}`);
  }
  
  if (!metaData.download_resource_url) {
    throw new Error('No download_resource_url in response');
  }
  
  log('success', `[${requestId}] Got URL: ${metaData.download_resource_url}`);
  log('debug', `[${requestId}] Step 2: Download file`);
  
  // Step 2: Download file
  const downloadUrl = `${CONFIG.YEASTAR_BASE_URL}${metaData.download_resource_url}?access_token=${token}`;
  
  const audioResponse = await fetch(downloadUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'Yeastar-Bridge/4.0' }
  });
  
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Download failed: HTTP ${audioResponse.status} - ${errorText}`);
  }
  
  const buffer = await audioResponse.buffer();
  
  // Validate
  if (buffer.length < 1000) {
    const bodyText = buffer.toString('utf-8');
    throw new Error(`Invalid audio file (${buffer.length} bytes): ${bodyText}`);
  }
  
  log('debug', `[${requestId}] File info:`, {
    size_bytes: buffer.length,
    size_mb: (buffer.length / 1024 / 1024).toFixed(2),
    content_type: audioResponse.headers.get('content-type')
  });
  
  return buffer;
}

async function processRecordingAsync(audioBuffer, callData, requestId) {
  try {
    log('info', `[${requestId}] Starting transcription`);
    
    const transcription = await transcribeAudio(audioBuffer, callData, requestId);
    
    log('success', `[${requestId}] Transcription: ${transcription.text?.length || 0} chars`);
    
    if (CONFIG.N8N_WEBHOOK_URL) {
      log('info', `[${requestId}] Sending to n8n`);
      await sendToN8n(transcription, callData, requestId);
      log('success', `[${requestId}] Sent to n8n`);
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
  
  log('info', `[${requestId}] Transcribing with Whisper`);
  
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
  form.append('response_format', 'json');
  
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    body: form,
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${CONFIG.OPENAI_API_KEY}`
    }
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI error: ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  
  log('success', `[${requestId}] Transcription result:`, {
    text_length: result.text?.length,
    language: result.language
  });
  
  return result;
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
  
  const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`n8n error: ${response.status} - ${errorText}`);
  }
  
  const contentType = response.headers.get('content-type');
  if (contentType?.includes('application/json')) {
    return await response.json();
  } else {
    return { message: await response.text() };
  }
}

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /yeastar-webhook'
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

const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  log('success', '🚀 Yeastar Bridge (Fresh Token Per Request) v4.0');
  console.log('='.repeat(70));
  log('info', `📡 Port: ${CONFIG.PORT}`);
  log('info', `🔗 Webhook: /yeastar-webhook`);
  log('info', `🔗 Health: /health`);
  console.log('='.repeat(70));
  log('info', `✅ n8n: ${CONFIG.N8N_WEBHOOK_URL || '⚠️ NOT SET'}`);
  log('info', `✅ Yeastar: ${CONFIG.YEASTAR_BASE_URL}`);
  log('info', `✅ Credentials: ${CONFIG.YEASTAR_CLIENT_ID ? '✅ SET' : '⚠️ NOT SET'}`);
  log('info', `✅ OpenAI: ${CONFIG.OPENAI_API_KEY ? '✅ SET' : '⚠️ NOT SET'}`);
  log('info', `✅ Language: ${CONFIG.TRANSCRIPTION_LANGUAGE}`);
  log('info', `🔑 Strategy: Fresh token per request (NO token caching)`);
  console.log('='.repeat(70) + '\n');
});

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
