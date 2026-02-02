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
    service: 'Yeastar-n8n Bridge Server',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    config: {
      n8n_configured: !!CONFIG.N8N_WEBHOOK_URL,
      yeastar_configured: !!CONFIG.YEASTAR_API_TOKEN,
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
    log('debug', `Recording filename: ${callData.recording_filename}`);
    
    const audioBuffer = await downloadRecording(callData);
    log('success', `✅ Audio downloaded: ${audioBuffer.length} bytes`);
    
    // Send to n8n
    log('info', `📤 Sending to n8n: ${CONFIG.N8N_WEBHOOK_URL}`);
    const n8nResult = await sendToN8n(audioBuffer, callData);
    log('success', '✅ Successfully sent to n8n', n8nResult);
    
    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Recording processed and sent to n8n',
      call_id: callData.call_id,
      processing_time_ms: processingTime,
      audio_size_bytes: audioBuffer.length
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
    
    const { recording_filename, call_id } = req.body;
    
    if (!recording_filename) {
      return res.status(400).json({ error: 'recording_filename is required' });
    }
    
    const callData = {
      call_id: call_id || 'manual_test',
      recording_filename: recording_filename,
      hasRecording: true,
      caller_number: 'manual_test',
      callee_number: 'manual_test',
      duration: '0',
      start_time: new Date().toISOString(),
      end_time: new Date().toISOString(),
      status: 'ANSWERED'
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
  // Yeastar sends the recording filename in the "recording" field
  const recordingFilename = webhookPayload.recording || 
                           webhookPayload.recordingfile || 
                           webhookPayload.recording_file || 
                           null;
  
  return {
    call_id: webhookPayload.call_id || 
             webhookPayload.callid || 
             webhookPayload.uniqueid || 
             'unknown',
    
    recording_filename: recordingFilename,
    
    duration: webhookPayload.talk_duration || 
              webhookPayload.call_duration ||
              webhookPayload.duration || 
              webhookPayload.billsec || 
              '0',
    
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
    
    type: webhookPayload.type || 'Unknown',
    
    hasRecording: !!recordingFilename && recordingFilename !== ''
  };
}

async function downloadRecording(callData) {
  if (!callData.recording_filename) {
    throw new Error('No recording filename available');
  }
  
  if (!CONFIG.YEASTAR_API_TOKEN) {
    throw new Error('Yeastar API token not configured');
  }
  
  // Yeastar API endpoint for downloading recordings
  // Format: /openapi/v1.0/recording/download?filename=xxx.wav&access_token=xxx
  const apiUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?filename=${encodeURIComponent(callData.recording_filename)}&access_token=${CONFIG.YEASTAR_API_TOKEN}`;
  
  log('debug', `Downloading from: ${apiUrl.replace(CONFIG.YEASTAR_API_TOKEN, '***TOKEN***')}`);
  
  const audioResponse = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      'User-Agent': 'OpenAPI'
    }
  });
  
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    throw new Error(`Failed to download recording: HTTP ${audioResponse.status} - ${errorText}`);
  }
  
  return await audioResponse.buffer();
}

async function sendToN8n(audioBuffer, callData) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    throw new Error('N8N_WEBHOOK_URL is not configured');
  }
  
  // Create form data
  const form = new FormData();
  
  // Add audio file
  form.append('file', audioBuffer, {
    filename: `call_${callData.call_id}.wav`,
    contentType: 'audio/wav'
  });
  
  // Add metadata as separate fields
  form.append('call_id', callData.call_id);
  form.append('duration', callData.duration.toString());
  form.append('caller_number', callData.caller_number);
  form.append('callee_number', callData.callee_number);
  form.append('start_time', callData.start_time);
  form.append('end_time', callData.end_time);
  form.append('status', callData.status);
  form.append('type', callData.type || 'Unknown');
  
  // Send to n8n
  const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
    method: 'POST',
    body: form,
    headers: form.getHeaders()
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
  log('info', `✅ API Token: ${CONFIG.YEASTAR_API_TOKEN ? 'CONFIGURED' : 'NOT CONFIGURED'}`);
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
