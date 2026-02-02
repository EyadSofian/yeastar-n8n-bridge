require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');

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
  YEASTAR_CLIENT_SECRET: process.env.YEASTAR_CLIENT_SECRET || ''
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

// Token refresh function
async function refreshYeastarToken() {
  if (!CONFIG.TOKEN_REFRESH_ENABLED) return;
  
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
      })
    });
    
    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }
    
    const data = await response.json();
    CONFIG.YEASTAR_API_TOKEN = data.access_token;
    
    log('success', 'Yeastar API token refreshed successfully');
    setTimeout(refreshYeastarToken, 25 * 60 * 1000);
    
  } catch (error) {
    log('error', 'Failed to refresh Yeastar token', { error: error.message });
  }
}

if (CONFIG.TOKEN_REFRESH_ENABLED) {
  refreshYeastarToken();
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Yeastar-n8n Bridge Server with OpenAI Transcription',
    version: '3.0.0',
    timestamp: new Date().toISOString(),
    config: {
      n8n_configured: !!CONFIG.N8N_WEBHOOK_URL,
      yeastar_configured: !!CONFIG.YEASTAR_API_TOKEN,
      openai_configured: !!CONFIG.OPENAI_API_KEY,
      transcription_language: CONFIG.TRANSCRIPTION_LANGUAGE,
      token_refresh: CONFIG.TOKEN_REFRESH_ENABLED
    }
  });
});

app.post('/yeastar-webhook', async (req, res) => {
  const startTime = Date.now();
  
  try {
    log('info', '📞 Received webhook from Yeastar');
    log('debug', 'Webhook payload', req.body);
    
    const callData = extractCallData(req.body);
    
    log('debug', 'Extracted call data', {
      call_id: callData.call_id,
      hasRecording: callData.hasRecording,
      recording_filename: callData.recording_filename,
      recording_url: callData.recording_url ? 'present' : 'null'
    });
    
    if (!callData.hasRecording) {
      log('warning', 'No recording available for this call', { 
        call_id: callData.call_id,
        status: callData.status,
        call_type: callData.call_type
      });
      return res.json({ 
        success: true, 
        message: 'Call received but no recording to process',
        call_id: callData.call_id
      });
    }
    
    log('info', `📥 Downloading recording for call: ${callData.call_id}`, {
      filename: callData.recording_filename
    });
    
    const audioBuffer = await downloadRecording(callData);
    log('success', `Audio downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    log('info', '🎤 Transcribing audio with OpenAI Whisper...');
    const transcription = await transcribeAudio(audioBuffer, callData);
    log('success', `Transcription completed: ${transcription.text?.length || 0} characters`);
    
    log('info', `📤 Sending transcription to n8n`);
    const n8nResult = await sendToN8n(transcription, callData);
    log('success', 'Successfully sent to n8n');
    
    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Recording transcribed and sent to n8n',
      call_id: callData.call_id,
      processing_time_ms: processingTime,
      audio_size_bytes: audioBuffer.length,
      transcript_length: transcription.text?.length || 0
    });
    
  } catch (error) {
    log('error', 'Error processing webhook', {
      error: error.message,
      stack: error.stack
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/test', (req, res) => {
  log('info', '🧪 Test endpoint called');
  res.json({
    status: 'OK',
    message: 'Test successful',
    received_data: req.body,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

function extractCallData(webhookPayload) {
  // Extract recording filename
  const recordingFileName = webhookPayload.recording || 
                           webhookPayload.recordingfile || 
                           null;
  
  // Build full recording URL if filename exists
  let recordingUrl = webhookPayload.recording_url || null;
  
  // If no direct URL but we have a filename, construct the API URL
  if (!recordingUrl && recordingFileName && CONFIG.YEASTAR_API_TOKEN) {
    recordingUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?filename=${encodeURIComponent(recordingFileName)}&access_token=${CONFIG.YEASTAR_API_TOKEN}`;
  }
  
  return {
    call_id: webhookPayload.call_id || 
             webhookPayload.callid || 
             webhookPayload.uniqueid || 
             'unknown',
    
    recording_url: recordingUrl,
    
    recording_id: webhookPayload.recording_id || 
                  webhookPayload.recordingid || 
                  null,
    
    recording_filename: recordingFileName,
    
    duration: webhookPayload.call_duration || 
              webhookPayload.duration || 
              webhookPayload.billsec || 
              '0',
    
    talk_duration: webhookPayload.talk_duration || '0',
    
    caller_number: webhookPayload.call_from || 
                   webhookPayload.caller_number || 
                   webhookPayload.src || 
                   webhookPayload.from || 
                   '',
    
    callee_number: webhookPayload.call_to || 
                   webhookPayload.callee_number || 
                   webhookPayload.dst || 
                   webhookPayload.to || 
                   '',
    
    start_time: webhookPayload.time_start || 
                webhookPayload.start_time || 
                webhookPayload.calldate || 
                new Date().toISOString(),
    
    end_time: webhookPayload.end_time || 
              new Date().toISOString(),
    
    status: webhookPayload.status || 
            webhookPayload.disposition || 
            'ANSWERED',
    
    call_type: webhookPayload.type || 'Unknown',
    
    trunk_name: webhookPayload.dst_trunk_name || 
                webhookPayload.src_trunk_name || '',
    
    // ✅ FIX: Check for recording in multiple ways
    hasRecording: !!(
      webhookPayload.recording_url || 
      webhookPayload.recording_id || 
      webhookPayload.recording ||        // Most common!
      webhookPayload.recordingfile
    )
  };
}

async function downloadRecording(callData) {
  let audioResponse;
  
  // Method 1: Direct URL
  if (callData.recording_url) {
    log('debug', 'Downloading via URL', { 
      method: 'Direct URL',
      url: callData.recording_url.substring(0, 100) + '...'
    });
    
    audioResponse = await fetch(callData.recording_url);
  }
  // Method 2: Via API with recording_id
  else if (callData.recording_id && CONFIG.YEASTAR_API_TOKEN) {
    log('debug', 'Downloading via API with recording_id');
    
    const apiUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?recording_id=${callData.recording_id}&access_token=${CONFIG.YEASTAR_API_TOKEN}`;
    audioResponse = await fetch(apiUrl);
  }
  // Method 3: Via API with filename
  else if (callData.recording_filename && CONFIG.YEASTAR_API_TOKEN) {
    log('debug', 'Downloading via API with filename', { 
      filename: callData.recording_filename 
    });
    
    const apiUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?filename=${encodeURIComponent(callData.recording_filename)}&access_token=${CONFIG.YEASTAR_API_TOKEN}`;
    audioResponse = await fetch(apiUrl);
  }
  else {
    throw new Error('No recording URL, ID, or filename available');
  }
  
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Failed to download recording: HTTP ${audioResponse.status} - ${errorText}`);
  }
  
  const buffer = await audioResponse.buffer();
  
  log('debug', 'Recording downloaded successfully', {
    size_bytes: buffer.length,
    size_mb: (buffer.length / 1024 / 1024).toFixed(2)
  });
  
  return buffer;
}

async function transcribeAudio(audioBuffer, callData) {
  if (!CONFIG.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  
  log('info', '🎙️ Starting transcription...', {
    audio_size: `${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`,
    language: CONFIG.TRANSCRIPTION_LANGUAGE
  });
  
  const form = new FormData();
  
  const Readable = require('stream').Readable;
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
    throw new Error(`OpenAI transcription failed: HTTP ${response.status} - ${errorText}`);
  }
  
  const result = await response.json();
  
  log('success', 'Transcription successful', {
    text_length: result.text?.length || 0,
    language: result.language,
    duration: result.duration
  });
  
  return result;
}

async function sendToN8n(transcription, callData) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is not configured');
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
    word_count: transcription.text ? transcription.text.split(' ').length : 0,
    recording_filename: callData.recording_filename
  };
  
  log('debug', 'Sending to n8n', {
    call_id: data.call_id,
    transcript_preview: data.transcript?.substring(0, 100) + '...',
    word_count: data.word_count
  });
  
  const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(data)
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`n8n webhook failed: HTTP ${response.status} - ${errorText}`);
  }
  
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return await response.json();
  } else {
    return { message: await response.text() };
  }
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    available_endpoints: [
      'GET /',
      'POST /yeastar-webhook',
      'POST /test'
    ]
  });
});

app.use((err, req, res, next) => {
  log('error', 'Unhandled error', {
    error: err.message,
    stack: err.stack
  });
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString()
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  log('success', '🚀 Yeastar-n8n Bridge Server Started (v3.0)');
  console.log('='.repeat(70));
  log('info', `📡 Port: ${CONFIG.PORT}`);
  log('info', `🔗 Webhook: http://localhost:${CONFIG.PORT}/yeastar-webhook`);
  log('info', `🔗 Health: http://localhost:${CONFIG.PORT}/`);
  console.log('='.repeat(70));
  log('info', `✅ n8n: ${CONFIG.N8N_WEBHOOK_URL || '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ Yeastar: ${CONFIG.YEASTAR_BASE_URL}`);
  log('info', `✅ API Token: ${CONFIG.YEASTAR_API_TOKEN ? '✅ CONFIGURED' : '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ OpenAI: ${CONFIG.OPENAI_API_KEY ? '✅ CONFIGURED' : '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ Language: ${CONFIG.TRANSCRIPTION_LANGUAGE}`);
  log('info', `✅ Auto-Refresh: ${CONFIG.TOKEN_REFRESH_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  console.log('='.repeat(70) + '\n');
});

process.on('SIGTERM', () => {
  log('info', 'SIGTERM received, shutting down gracefully...');
  server.close(() => {
    log('success', 'Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received, shutting down gracefully...');
  server.close(() => {
    log('success', 'Server closed');
    process.exit(0);
  });
});
