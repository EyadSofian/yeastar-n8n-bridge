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

// Token refresh function (optional - for production use)
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
    
    // Schedule next refresh (25 minutes - tokens expire in 30)
    setTimeout(refreshYeastarToken, 25 * 60 * 1000);
    
  } catch (error) {
    log('error', 'Failed to refresh Yeastar token', { error: error.message });
  }
}

// Start token refresh if enabled
if (CONFIG.TOKEN_REFRESH_ENABLED) {
  refreshYeastarToken();
}

// ============================================================================
// ROUTES
// ============================================================================

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Yeastar-n8n Bridge Server with OpenAI Transcription',
    version: '2.0.0',
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

// Main webhook endpoint - receives calls from Yeastar
app.post('/yeastar-webhook', async (req, res) => {
  const startTime = Date.now();
  
  try {
    log('info', '📞 Received webhook from Yeastar');
    log('debug', 'Webhook payload', req.body);
    
    // Extract call data from webhook
    const callData = extractCallData(req.body);
    
    if (!callData.hasRecording) {
      log('warning', 'No recording available for this call', { call_id: callData.call_id });
      return res.json({ 
        success: true, 
        message: 'Call received but no recording to process',
        call_id: callData.call_id
      });
    }
    
    // Download recording from Yeastar
    log('info', `📥 Downloading recording for call: ${callData.call_id}`);
    const audioBuffer = await downloadRecording(callData);
    log('success', `Audio downloaded: ${audioBuffer.length} bytes`);
    
    // Transcribe audio with OpenAI Whisper
    log('info', '🎤 Transcribing audio...');
    const transcription = await transcribeAudio(audioBuffer, callData);
    log('success', `Transcription completed: "${transcription.text?.substring(0, 50)}..."`);
    
    // Send transcription to n8n
    log('info', `📤 Sending transcription to n8n`);
    const n8nResult = await sendToN8n(transcription, callData);
    log('success', 'Successfully sent to n8n', n8nResult);
    
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

// Test endpoint
app.post('/test', (req, res) => {
  log('info', '🧪 Test endpoint called');
  res.json({
    status: 'OK',
    message: 'Test successful',
    received_data: req.body,
    timestamp: new Date().toISOString()
  });
});

// Manual trigger endpoint (for testing with file upload)
app.post('/manual-trigger', async (req, res) => {
  try {
    log('info', '🔧 Manual trigger called');
    
    // You can use this endpoint to manually upload audio files for testing
    const { recording_url, call_id } = req.body;
    
    if (!recording_url) {
      return res.status(400).json({ error: 'recording_url is required' });
    }
    
    const callData = {
      call_id: call_id || 'manual_test',
      recording_url: recording_url,
      hasRecording: true
    };
    
    const audioBuffer = await downloadRecording(callData);
    const result = await sendToN8n(audioBuffer, callData);
    
    res.json({
      success: true,
      result: result
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
  // Yeastar webhook payload structure varies by event type
  // Adjust these fields based on your actual webhook data
  
  return {
    call_id: webhookPayload.call_id || 
             webhookPayload.callid || 
             webhookPayload.uniqueid || 
             'unknown',
    
    recording_url: webhookPayload.recording_url || 
                   webhookPayload.recordingfile || 
                   null,
    
    recording_id: webhookPayload.recording_id || 
                  webhookPayload.recordingid || 
                  null,
    
    duration: webhookPayload.duration || 
              webhookPayload.billsec || 
              '0',
    
    caller_number: webhookPayload.caller_number || 
                   webhookPayload.src || 
                   webhookPayload.from || 
                   '',
    
    callee_number: webhookPayload.callee_number || 
                   webhookPayload.dst || 
                   webhookPayload.to || 
                   '',
    
    start_time: webhookPayload.start_time || 
                webhookPayload.calldate || 
                new Date().toISOString(),
    
    end_time: webhookPayload.end_time || 
              new Date().toISOString(),
    
    status: webhookPayload.status || 
            webhookPayload.disposition || 
            'ANSWERED',
    
    hasRecording: !!(webhookPayload.recording_url || webhookPayload.recording_id)
  };
}

async function downloadRecording(callData) {
  let audioResponse;
  
  // Method 1: Direct URL (if provided by Yeastar)
  if (callData.recording_url) {
    log('debug', 'Using direct recording URL');
    audioResponse = await fetch(callData.recording_url);
  }
  // Method 2: Via Yeastar API
  else if (callData.recording_id && CONFIG.YEASTAR_API_TOKEN) {
    log('debug', 'Using Yeastar API to download recording');
    
    const apiUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?recording_id=${callData.recording_id}&access_token=${CONFIG.YEASTAR_API_TOKEN}`;
    audioResponse = await fetch(apiUrl);
  }
  else {
    throw new Error('No recording URL or recording ID available');
  }
  
  if (!audioResponse.ok) {
    throw new Error(`Failed to download recording: HTTP ${audioResponse.status} - ${audioResponse.statusText}`);
  }
  
  return await audioResponse.buffer();
}

async function transcribeAudio(audioBuffer, callData) {
  if (!CONFIG.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  
  log('info', '🎤 Transcribing audio with OpenAI Whisper...');
  
  // Create form data
  const form = new FormData();
  
  // Add audio file as stream
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
  
  // Send to OpenAI
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
  
  log('success', `Transcription completed: ${result.text?.length || 0} characters`);
  
  return result;
}

async function sendToN8n(transcription, callData) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is not configured');
  }
  
  // Prepare data to send to n8n
  const data = {
    call_id: callData.call_id,
    transcript: transcription.text,
    language: transcription.language,
    duration: transcription.duration || callData.duration,
    caller_number: callData.caller_number,
    callee_number: callData.callee_number,
    start_time: callData.start_time,
    end_time: callData.end_time,
    status: callData.status,
    transcription_date: new Date().toISOString(),
    word_count: transcription.text ? transcription.text.split(' ').length : 0
  };
  
  log('debug', 'Sending transcription to n8n', data);
  
  // Send JSON data to n8n
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
  
  // Try to parse JSON response, fallback to text
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

// Handle 404
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
    available_endpoints: [
      'GET /',
      'POST /yeastar-webhook',
      'POST /test',
      'POST /manual-trigger'
    ]
  });
});

// Global error handler
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
  console.log('\n' + '='.repeat(60));
  log('success', `🚀 Yeastar-n8n Bridge Server Started`);
  console.log('='.repeat(60));
  log('info', `📡 Port: ${CONFIG.PORT}`);
  log('info', `🔗 Webhook URL: http://localhost:${CONFIG.PORT}/yeastar-webhook`);
  log('info', `🔗 Test URL: http://localhost:${CONFIG.PORT}/test`);
  log('info', `🔗 Health Check: http://localhost:${CONFIG.PORT}/`);
  console.log('='.repeat(60));
  log('info', `✅ n8n Webhook: ${CONFIG.N8N_WEBHOOK_URL || 'NOT CONFIGURED'}`);
  log('info', `✅ Yeastar Base URL: ${CONFIG.YEASTAR_BASE_URL}`);
  log('info', `✅ Yeastar API Token: ${CONFIG.YEASTAR_API_TOKEN ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  log('info', `✅ OpenAI API Key: ${CONFIG.OPENAI_API_KEY ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
  log('info', `✅ Transcription Language: ${CONFIG.TRANSCRIPTION_LANGUAGE}`);
  log('info', `✅ Token Auto-Refresh: ${CONFIG.TOKEN_REFRESH_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  console.log('='.repeat(60) + '\n');
});

// Graceful shutdown
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
