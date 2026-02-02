require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const FormData = require('form-data');
const { Readable } = require('stream');

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuration from environment variables with validation
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
  
  // ✅ إضافات جديدة
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || '3'),
  REQUEST_TIMEOUT: parseInt(process.env.REQUEST_TIMEOUT || '60000'), // 60 seconds
  MIN_AUDIO_SIZE: parseInt(process.env.MIN_AUDIO_SIZE || '1000'), // 1KB minimum
  MAX_AUDIO_SIZE: parseInt(process.env.MAX_AUDIO_SIZE || '26214400'), // 25MB (OpenAI limit)
  ENABLE_AUDIO_VALIDATION: process.env.ENABLE_AUDIO_VALIDATION !== 'false'
};

// ✅ Token state management
let tokenState = {
  token: CONFIG.YEASTAR_API_TOKEN,
  lastRefresh: null,
  refreshAttempts: 0,
  isRefreshing: false
};

// Logging helper with levels
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

// ✅ Improved token refresh with retry logic
async function refreshYeastarToken(isRetry = false) {
  if (!CONFIG.TOKEN_REFRESH_ENABLED) return;
  
  // Prevent concurrent refresh attempts
  if (tokenState.isRefreshing && !isRetry) {
    log('debug', 'Token refresh already in progress, skipping');
    return;
  }
  
  tokenState.isRefreshing = true;
  
  try {
    log('info', `🔄 Refreshing Yeastar token (attempt ${tokenState.refreshAttempts + 1})`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout
    
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
    
    if (!data.access_token) {
      throw new Error('No access_token in response');
    }
    
    // ✅ Update token state
    tokenState.token = data.access_token;
    tokenState.lastRefresh = new Date();
    tokenState.refreshAttempts = 0;
    CONFIG.YEASTAR_API_TOKEN = data.access_token;
    
    log('success', '🔑 Yeastar API token refreshed successfully', {
      expires_in: data.expires_in,
      last_refresh: tokenState.lastRefresh.toISOString()
    });
    
    // Schedule next refresh (25 minutes)
    setTimeout(() => refreshYeastarToken(), 25 * 60 * 1000);
    
  } catch (error) {
    tokenState.refreshAttempts++;
    
    log('error', '❌ Failed to refresh Yeastar token', {
      error: error.message,
      attempt: tokenState.refreshAttempts,
      will_retry: tokenState.refreshAttempts < 3
    });
    
    // ✅ Retry with exponential backoff
    if (tokenState.refreshAttempts < 3) {
      const retryDelay = Math.min(1000 * Math.pow(2, tokenState.refreshAttempts), 30000);
      log('info', `⏳ Retrying token refresh in ${retryDelay}ms`);
      setTimeout(() => refreshYeastarToken(true), retryDelay);
    } else {
      log('error', '🚨 Token refresh failed after 3 attempts. Manual intervention required.');
      tokenState.refreshAttempts = 0; // Reset for next scheduled refresh
    }
  } finally {
    tokenState.isRefreshing = false;
  }
}

// Start token refresh if enabled
if (CONFIG.TOKEN_REFRESH_ENABLED) {
  refreshYeastarToken();
}

// ✅ Validate configuration on startup
function validateConfig() {
  const warnings = [];
  const errors = [];
  
  if (!CONFIG.N8N_WEBHOOK_URL) {
    warnings.push('N8N_WEBHOOK_URL not configured - transcriptions will not be sent');
  }
  
  if (!CONFIG.YEASTAR_API_TOKEN && !CONFIG.TOKEN_REFRESH_ENABLED) {
    errors.push('YEASTAR_API_TOKEN not configured and TOKEN_REFRESH_ENABLED is false');
  }
  
  if (!CONFIG.OPENAI_API_KEY) {
    errors.push('OPENAI_API_KEY not configured - transcription will fail');
  }
  
  if (CONFIG.TOKEN_REFRESH_ENABLED && (!CONFIG.YEASTAR_CLIENT_ID || !CONFIG.YEASTAR_CLIENT_SECRET)) {
    errors.push('TOKEN_REFRESH_ENABLED but CLIENT_ID or CLIENT_SECRET missing');
  }
  
  if (errors.length > 0) {
    log('error', '🚨 Configuration errors detected:', errors);
    throw new Error('Invalid configuration. Please check your .env file');
  }
  
  if (warnings.length > 0) {
    log('warning', '⚠️ Configuration warnings:', warnings);
  }
}

// ============================================================================
// ROUTES
// ============================================================================

app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Yeastar-n8n Bridge Server with OpenAI Transcription',
    version: '3.1.0-improved',
    timestamp: new Date().toISOString(),
    config: {
      n8n_configured: !!CONFIG.N8N_WEBHOOK_URL,
      yeastar_configured: !!tokenState.token,
      openai_configured: !!CONFIG.OPENAI_API_KEY,
      transcription_language: CONFIG.TRANSCRIPTION_LANGUAGE,
      token_refresh: CONFIG.TOKEN_REFRESH_ENABLED,
      last_token_refresh: tokenState.lastRefresh?.toISOString() || 'never',
      audio_validation: CONFIG.ENABLE_AUDIO_VALIDATION
    },
    stats: {
      uptime_seconds: process.uptime(),
      memory_usage_mb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    }
  });
});

// ✅ Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: 'healthy',
    checks: {
      api_token: !!tokenState.token,
      openai_key: !!CONFIG.OPENAI_API_KEY,
      n8n_webhook: !!CONFIG.N8N_WEBHOOK_URL
    },
    timestamp: new Date().toISOString()
  };
  
  const allHealthy = Object.values(health.checks).every(v => v);
  res.status(allHealthy ? 200 : 503).json(health);
});

app.post('/yeastar-webhook', async (req, res) => {
  const startTime = Date.now();
  const requestId = `REQ-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  try {
    log('info', `📞 [${requestId}] Received webhook from Yeastar`);
    log('debug', `[${requestId}] Webhook payload`, req.body);
    
    const callData = extractCallData(req.body);
    
    log('debug', `[${requestId}] Extracted call data`, {
      call_id: callData.call_id,
      hasRecording: callData.hasRecording,
      recording_filename: callData.recording_filename,
      duration: callData.duration
    });
    
    if (!callData.hasRecording) {
      log('warning', `[${requestId}] No recording available for this call`, { 
        call_id: callData.call_id,
        status: callData.status,
        call_type: callData.call_type
      });
      return res.json({ 
        success: true, 
        message: 'Call received but no recording to process',
        call_id: callData.call_id,
        request_id: requestId
      });
    }
    
    log('info', `📥 [${requestId}] Downloading recording for call: ${callData.call_id}`, {
      filename: callData.recording_filename
    });
    
    // ✅ Download with retry logic
    const audioBuffer = await retryOperation(
      () => downloadRecording(callData, requestId),
      CONFIG.MAX_RETRIES,
      `Download recording ${callData.call_id}`
    );
    
    log('success', `[${requestId}] Audio downloaded: ${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    // ✅ Validate audio before transcription
    if (CONFIG.ENABLE_AUDIO_VALIDATION) {
      validateAudioBuffer(audioBuffer, requestId);
    }
    
    log('info', `🎤 [${requestId}] Transcribing audio with OpenAI Whisper...`);
    
    // ✅ Transcribe with retry logic
    const transcription = await retryOperation(
      () => transcribeAudio(audioBuffer, callData, requestId),
      CONFIG.MAX_RETRIES,
      `Transcribe audio ${callData.call_id}`
    );
    
    log('success', `[${requestId}] Transcription completed: ${transcription.text?.length || 0} characters`);
    
    // Send to n8n if configured
    if (CONFIG.N8N_WEBHOOK_URL) {
      log('info', `📤 [${requestId}] Sending transcription to n8n`);
      const n8nResult = await sendToN8n(transcription, callData, requestId);
      log('success', `[${requestId}] Successfully sent to n8n`);
    } else {
      log('warning', `[${requestId}] Skipping n8n - webhook URL not configured`);
    }
    
    const processingTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Recording transcribed successfully',
      request_id: requestId,
      call_id: callData.call_id,
      processing_time_ms: processingTime,
      audio_size_bytes: audioBuffer.length,
      transcript_length: transcription.text?.length || 0,
      language_detected: transcription.language
    });
    
  } catch (error) {
    log('error', `[${requestId}] Error processing webhook`, {
      error: error.message,
      stack: CONFIG.ENABLE_LOGGING ? error.stack : undefined
    });
    
    res.status(500).json({
      success: false,
      error: error.message,
      request_id: requestId,
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

// ✅ New endpoint to manually refresh token
app.post('/admin/refresh-token', async (req, res) => {
  try {
    await refreshYeastarToken(true);
    res.json({
      success: true,
      message: 'Token refresh initiated',
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
  // Extract recording filename
  const recordingFileName = webhookPayload.recording || 
                           webhookPayload.recordingfile || 
                           null;
  
  // Build full recording URL if filename exists
  let recordingUrl = webhookPayload.recording_url || null;
  
  // If no direct URL but we have a filename, construct the API URL
  if (!recordingUrl && recordingFileName && tokenState.token) {
    recordingUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?filename=${encodeURIComponent(recordingFileName)}&access_token=${tokenState.token}`;
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
    
    hasRecording: !!(
      webhookPayload.recording_url || 
      webhookPayload.recording_id || 
      webhookPayload.recording ||
      webhookPayload.recordingfile
    )
  };
}

// ✅ Improved download with better error handling
async function downloadRecording(callData, requestId) {
  let audioResponse;
  let downloadUrl;
  
  // Method 1: Direct URL
  if (callData.recording_url) {
    downloadUrl = callData.recording_url;
    log('debug', `[${requestId}] Downloading via direct URL`);
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
    
    try {
      audioResponse = await fetch(downloadUrl, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Yeastar-n8n-Bridge/3.1'
        }
      });
      clearTimeout(timeout);
    } catch (error) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') {
        throw new Error(`Download timeout after ${CONFIG.REQUEST_TIMEOUT}ms`);
      }
      throw error;
    }
  }
  // Method 2: Via API with recording_id
  else if (callData.recording_id && tokenState.token) {
    downloadUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?recording_id=${callData.recording_id}&access_token=${tokenState.token}`;
    log('debug', `[${requestId}] Downloading via API with recording_id`);
    
    audioResponse = await fetch(downloadUrl);
  }
  // Method 3: Via API with filename
  else if (callData.recording_filename && tokenState.token) {
    downloadUrl = `${CONFIG.YEASTAR_BASE_URL}/openapi/v1.0/recording/download?filename=${encodeURIComponent(callData.recording_filename)}&access_token=${tokenState.token}`;
    log('debug', `[${requestId}] Downloading via API with filename`, { 
      filename: callData.recording_filename 
    });
    
    audioResponse = await fetch(downloadUrl);
  }
  else {
    throw new Error('No recording URL, ID, or filename available. Cannot download recording.');
  }
  
  // ✅ Check response status
  if (!audioResponse.ok) {
    const errorText = await audioResponse.text();
    
    // ✅ Check if token expired
    if (audioResponse.status === 401 || audioResponse.status === 403) {
      log('warning', `[${requestId}] Authentication failed - token may be expired`);
      
      if (CONFIG.TOKEN_REFRESH_ENABLED) {
        log('info', `[${requestId}] Attempting to refresh token...`);
        await refreshYeastarToken(true);
        throw new Error('Token expired - retry after refresh');
      }
    }
    
    throw new Error(`Failed to download recording: HTTP ${audioResponse.status} - ${errorText}`);
  }
  
  const buffer = await audioResponse.buffer();
  
  // ✅ Enhanced validation
  if (buffer.length < CONFIG.MIN_AUDIO_SIZE) {
    // Try to parse as error message
    const bodyText = buffer.toString('utf-8');
    log('error', `[${requestId}] Downloaded file suspiciously small`, {
      size_bytes: buffer.length,
      content_preview: bodyText.substring(0, 500)
    });
    
    throw new Error(`Invalid audio file (${buffer.length} bytes). Response: ${bodyText}`);
  }
  
  // ✅ Check content type
  const contentType = audioResponse.headers.get('content-type');
  if (contentType) {
    log('debug', `[${requestId}] Content-Type: ${contentType}`);
    
    if (!contentType.includes('audio') && 
        !contentType.includes('octet-stream') && 
        !contentType.includes('application/x-wav')) {
      log('warning', `[${requestId}] Unexpected content type: ${contentType}`);
      
      // If it's JSON or text, it's probably an error
      if (contentType.includes('json') || contentType.includes('text')) {
        const errorBody = buffer.toString('utf-8');
        throw new Error(`Server returned error instead of audio: ${errorBody}`);
      }
    }
  }
  
  log('debug', `[${requestId}] Recording downloaded successfully`, {
    size_bytes: buffer.length,
    size_mb: (buffer.length / 1024 / 1024).toFixed(2),
    content_type: contentType || 'unknown'
  });
  
  return buffer;
}

// ✅ New function to validate audio buffer
function validateAudioBuffer(audioBuffer, requestId) {
  log('debug', `[${requestId}] Validating audio buffer...`);
  
  // Check size limits
  if (audioBuffer.length < CONFIG.MIN_AUDIO_SIZE) {
    throw new Error(`Audio file too small: ${audioBuffer.length} bytes (minimum: ${CONFIG.MIN_AUDIO_SIZE})`);
  }
  
  if (audioBuffer.length > CONFIG.MAX_AUDIO_SIZE) {
    throw new Error(`Audio file too large: ${audioBuffer.length} bytes (maximum: ${CONFIG.MAX_AUDIO_SIZE})`);
  }
  
  // ✅ Detect audio format from magic bytes
  const format = detectAudioFormat(audioBuffer);
  log('debug', `[${requestId}] Detected audio format: ${format}`);
  
  if (!format) {
    log('warning', `[${requestId}] Could not detect audio format - first 16 bytes:`, {
      hex: audioBuffer.slice(0, 16).toString('hex'),
      ascii: audioBuffer.slice(0, 16).toString('ascii').replace(/[^\x20-\x7E]/g, '.')
    });
    
    // Don't fail, just warn - some formats might not be detected
  }
  
  log('success', `[${requestId}] Audio validation passed`);
  return true;
}

// ✅ Detect audio format from buffer magic bytes
function detectAudioFormat(buffer) {
  if (buffer.length < 12) return null;
  
  // WAV: "RIFF....WAVE"
  if (buffer.slice(0, 4).toString() === 'RIFF' && 
      buffer.slice(8, 12).toString() === 'WAVE') {
    return 'wav';
  }
  
  // MP3: ID3 tag or sync bytes (0xFF 0xFB/0xFA/0xF3/0xF2)
  if (buffer.slice(0, 3).toString() === 'ID3') {
    return 'mp3';
  }
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
    return 'mp3';
  }
  
  // OGG: "OggS"
  if (buffer.slice(0, 4).toString() === 'OggS') {
    return 'ogg';
  }
  
  // FLAC: "fLaC"
  if (buffer.slice(0, 4).toString() === 'fLaC') {
    return 'flac';
  }
  
  // M4A/MP4: "ftyp"
  if (buffer.slice(4, 8).toString() === 'ftyp') {
    return 'm4a';
  }
  
  // WebM: starts with 0x1A 0x45 0xDF 0xA3
  if (buffer[0] === 0x1A && buffer[1] === 0x45 && 
      buffer[2] === 0xDF && buffer[3] === 0xA3) {
    return 'webm';
  }
  
  return null;
}

// ✅ Improved transcription with format detection
async function transcribeAudio(audioBuffer, callData, requestId) {
  if (!CONFIG.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }
  
  log('info', `🎙️ [${requestId}] Starting transcription...`, {
    audio_size: `${(audioBuffer.length / 1024 / 1024).toFixed(2)} MB`,
    language: CONFIG.TRANSCRIPTION_LANGUAGE
  });
  
  // ✅ Detect actual format
  const detectedFormat = detectAudioFormat(audioBuffer) || 'wav';
  log('debug', `[${requestId}] Using format: ${detectedFormat}`);
  
  const form = new FormData();
  
  const stream = new Readable();
  stream.push(audioBuffer);
  stream.push(null);
  
  form.append('file', stream, {
    filename: `call_${callData.call_id}.${detectedFormat}`,
    contentType: `audio/${detectedFormat}`,
    knownLength: audioBuffer.length
  });
  
  form.append('model', 'whisper-1');
  form.append('language', CONFIG.TRANSCRIPTION_LANGUAGE);
  form.append('response_format', 'verbose_json'); // ✅ Get more details
  
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
      
      // ✅ Better error messages
      let errorMessage = `OpenAI transcription failed: HTTP ${response.status}`;
      
      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error && errorJson.error.message) {
          errorMessage += ` - ${errorJson.error.message}`;
        }
      } catch (e) {
        errorMessage += ` - ${errorText}`;
      }
      
      throw new Error(errorMessage);
    }
    
    const result = await response.json();
    
    log('success', `[${requestId}] Transcription successful`, {
      text_length: result.text?.length || 0,
      language: result.language,
      duration: result.duration,
      segments: result.segments?.length || 0
    });
    
    return result;
    
  } catch (error) {
    clearTimeout(timeout);
    
    if (error.name === 'AbortError') {
      throw new Error(`Transcription timeout after ${CONFIG.REQUEST_TIMEOUT}ms`);
    }
    
    throw error;
  }
}

async function sendToN8n(transcription, callData, requestId) {
  if (!CONFIG.N8N_WEBHOOK_URL) {
    log('warning', `[${requestId}] N8N_WEBHOOK_URL not configured, skipping send`);
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
    recording_filename: callData.recording_filename,
    // ✅ Additional metadata
    segments_count: transcription.segments?.length || 0,
    request_id: requestId
  };
  
  log('debug', `[${requestId}] Sending to n8n`, {
    call_id: data.call_id,
    transcript_preview: data.transcript?.substring(0, 100) + '...',
    word_count: data.word_count
  });
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT);
  
  try {
    const response = await fetch(CONFIG.N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Yeastar-n8n-Bridge/3.1'
      },
      body: JSON.stringify(data),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
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
    
  } catch (error) {
    clearTimeout(timeout);
    
    if (error.name === 'AbortError') {
      throw new Error(`n8n webhook timeout after ${CONFIG.REQUEST_TIMEOUT}ms`);
    }
    
    throw error;
  }
}

// ✅ Generic retry function with exponential backoff
async function retryOperation(operation, maxRetries, operationName) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        // Don't retry certain errors
        if (error.message.includes('not configured') || 
            error.message.includes('Invalid configuration')) {
          throw error;
        }
        
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
        log('warning', `⏳ ${operationName} failed (attempt ${attempt}/${maxRetries}), retrying in ${delay}ms`, {
          error: error.message
        });
        
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`${operationName} failed after ${maxRetries} attempts: ${lastError.message}`);
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
      'GET /health',
      'POST /yeastar-webhook',
      'POST /test',
      'POST /admin/refresh-token'
    ]
  });
});

app.use((err, req, res, next) => {
  log('error', 'Unhandled error', {
    error: err.message,
    stack: CONFIG.ENABLE_LOGGING ? err.stack : undefined
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

// Validate config before starting
try {
  validateConfig();
} catch (error) {
  log('error', '🚨 Configuration validation failed', { error: error.message });
  process.exit(1);
}

const server = app.listen(CONFIG.PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  log('success', '🚀 Yeastar-n8n Bridge Server Started (v3.1-improved)');
  console.log('='.repeat(70));
  log('info', `📡 Port: ${CONFIG.PORT}`);
  log('info', `🔗 Webhook: http://localhost:${CONFIG.PORT}/yeastar-webhook`);
  log('info', `🔗 Health: http://localhost:${CONFIG.PORT}/health`);
  console.log('='.repeat(70));
  log('info', `✅ n8n: ${CONFIG.N8N_WEBHOOK_URL || '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ Yeastar: ${CONFIG.YEASTAR_BASE_URL}`);
  log('info', `✅ API Token: ${tokenState.token ? '✅ CONFIGURED' : '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ OpenAI: ${CONFIG.OPENAI_API_KEY ? '✅ CONFIGURED' : '⚠️ NOT CONFIGURED'}`);
  log('info', `✅ Language: ${CONFIG.TRANSCRIPTION_LANGUAGE}`);
  log('info', `✅ Auto-Refresh: ${CONFIG.TOKEN_REFRESH_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  log('info', `✅ Max Retries: ${CONFIG.MAX_RETRIES}`);
  log('info', `✅ Request Timeout: ${CONFIG.REQUEST_TIMEOUT}ms`);
  log('info', `✅ Audio Validation: ${CONFIG.ENABLE_AUDIO_VALIDATION ? 'ENABLED' : 'DISABLED'}`);
  console.log('='.repeat(70) + '\n');
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

// ✅ Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  log('error', '🚨 Unhandled Promise Rejection', {
    reason: reason,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  log('error', '🚨 Uncaught Exception', {
    error: error.message,
    stack: error.stack
  });
  
  // Give some time for logging then exit
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});
