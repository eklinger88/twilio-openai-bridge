import WebSocket from 'ws';
import { publishEvent } from './eventBus.js';

const streamStats = new Map();
const realtimeBridges = new Map();

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();
  if (!value || /^<.*>$/.test(value)) return fallback;

  return value;
}

function logBridge(stage, details = {}) {
  const parts = Object.entries(details)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${value}`);

  const suffix = parts.length ? ` ${parts.join(' ')}` : '';
  console.log(`[bridge][${stage}]${suffix}`);
}

const OPENAI_API_KEY = readEnv('OPENAI_API_KEY');
const OPENAI_REALTIME_URL = readEnv('OPENAI_REALTIME_URL', 'wss://api.openai.com/v1/realtime');
const OPENAI_REALTIME_MODEL = readEnv('OPENAI_REALTIME_MODEL', 'gpt-realtime');
const OPENAI_REALTIME_TRANSCRIBE_MODEL = readEnv('OPENAI_REALTIME_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe');
const OPENAI_REALTIME_USE_BETA_HEADER = process.env.OPENAI_REALTIME_USE_BETA_HEADER === 'true';
const OPENAI_REALTIME_SESSION_STYLE = readEnv('OPENAI_REALTIME_SESSION_STYLE', 'legacy').toLowerCase();

function ensureStats(sessionId) {
  if (!streamStats.has(sessionId)) {
    streamStats.set(sessionId, {
      chunkCount: 0,
      bytes: 0,
      lastTranscriptAt: 0,
      warnedMissingBridge: false,
    });
  }
  return streamStats.get(sessionId);
}

function hasRealtimeBridgeConfig() {
  return Boolean(OPENAI_API_KEY);
}

function buildRealtimeUrl() {
  const separator = OPENAI_REALTIME_URL.includes('?') ? '&' : '?';
  return `${OPENAI_REALTIME_URL}${separator}model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`;
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function buildLegacySessionUpdate() {
  return {
    type: 'session.update',
    session: {
      modalities: ['text'],
      input_audio_format: 'g711_ulaw',
      output_audio_format: 'g711_ulaw',
      input_audio_transcription: {
        model: OPENAI_REALTIME_TRANSCRIBE_MODEL,
      },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
        create_response: false,
      },
    },
  };
}

function buildModernSessionUpdate() {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      modalities: ['text'],
      audio: {
        input: {
          format: { type: 'audio/pcmu' },
          transcription: {
            model: OPENAI_REALTIME_TRANSCRIBE_MODEL,
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: false,
          },
        },
      },
    },
  };
}

function buildSessionUpdate() {
  if (OPENAI_REALTIME_SESSION_STYLE === 'modern') {
    return buildModernSessionUpdate();
  }
  return buildLegacySessionUpdate();
}

function sendSessionConfiguration(sessionId, bridgeState) {
  const ok = safeSend(bridgeState.ws, buildSessionUpdate());
  if (!ok) return;

  bridgeState.sessionConfigured = true;

  publishEvent(sessionId, {
    type: 'openai_realtime_session_configured',
    model: OPENAI_REALTIME_MODEL,
    transcriptionModel: OPENAI_REALTIME_TRANSCRIBE_MODEL,
    sessionStyle: OPENAI_REALTIME_SESSION_STYLE,
  });

  logBridge('openai_session_configured', {
    sessionId,
    model: OPENAI_REALTIME_MODEL,
    transcriptionModel: OPENAI_REALTIME_TRANSCRIBE_MODEL,
  });
}

function emitTranscriptEvent(sessionId, text, isFinal, sourceType) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    publishEvent(sessionId, {
      type: 'openai_realtime_transcript_discarded',
      reason: 'empty_text',
      sourceType,
    });

    logBridge('transcript_discarded', { sessionId, reason: 'empty_text', sourceType });
    return;
  }

  publishEvent(sessionId, {
    type: 'transcript',
    source: 'openai-realtime',
    sourceType,
    isFinal,
    text: normalized,
  });

  logBridge('transcript_received', {
    sessionId,
    isFinal: isFinal ? 'true' : 'false',
    sourceType,
    chars: normalized.length,
  });
}

function handleRealtimeMessage(sessionId, bridgeState, rawMessage) {
  const event = safeJsonParse(rawMessage);
  if (!event?.type) return;

  switch (event.type) {
    case 'session.created':
    case 'session.updated': {
      publishEvent(sessionId, {
        type: 'openai_realtime_session_event',
        eventType: event.type,
      });
      return;
    }

    case 'input_audio_buffer.speech_started':
    case 'input_audio_buffer.speech_stopped': {
      publishEvent(sessionId, {
        type: 'openai_realtime_vad',
        phase: event.type.endsWith('started') ? 'started' : 'stopped',
        itemId: event.item_id || null,
      });
      return;
    }

    case 'conversation.item.input_audio_transcription.delta': {
      emitTranscriptEvent(sessionId, event.delta, false, event.type);
      return;
    }

    case 'conversation.item.input_audio_transcription.completed': {
      emitTranscriptEvent(sessionId, event.transcript, true, event.type);
      return;
    }

    // Compatibility with response-style transcript events.
    case 'response.output_audio_transcript.delta':
    case 'response.audio_transcript.delta':
    case 'response.output_text.delta': {
      emitTranscriptEvent(sessionId, event.delta || event.text, false, event.type);
      return;
    }

    case 'response.output_audio_transcript.done':
    case 'response.audio_transcript.done':
    case 'response.output_text.done': {
      emitTranscriptEvent(sessionId, event.transcript || event.text || event.delta, true, event.type);
      return;
    }

    case 'error': {
      publishEvent(sessionId, {
        type: 'openai_realtime_error',
        errorType: event?.error?.type || 'unknown_error',
        code: event?.error?.code || null,
        message: event?.error?.message || 'Unknown Realtime error',
      });

      logBridge('openai_error', {
        sessionId,
        errorType: event?.error?.type || 'unknown_error',
        code: event?.error?.code || 'none',
      });
      return;
    }

    default:
      return;
  }
}

function flushQueuedAudio(sessionId, bridgeState) {
  if (!bridgeState || bridgeState.ws.readyState !== WebSocket.OPEN) return;

  const queuedBeforeFlush = bridgeState.audioQueue.length;

  while (bridgeState.audioQueue.length > 0) {
    const payload = bridgeState.audioQueue.shift();
    safeSend(bridgeState.ws, {
      type: 'input_audio_buffer.append',
      audio: payload,
    });
  }

  publishEvent(sessionId, {
    type: 'openai_realtime_audio_queue_flushed',
    queuedChunks: queuedBeforeFlush,
  });

  if (queuedBeforeFlush > 0) {
    logBridge('openai_audio_flushed', { sessionId, queuedChunks: queuedBeforeFlush });
  }
}

function ensureRealtimeBridge(sessionId) {
  if (!hasRealtimeBridgeConfig()) return null;

  const existing = realtimeBridges.get(sessionId);
  if (existing) {
    if (
      existing.ws.readyState === WebSocket.OPEN ||
      existing.ws.readyState === WebSocket.CONNECTING
    ) {
      return existing;
    }
    realtimeBridges.delete(sessionId);
  }

  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
  };

  if (OPENAI_REALTIME_USE_BETA_HEADER) {
    headers['OpenAI-Beta'] = 'realtime=v1';
  }

  const ws = new WebSocket(buildRealtimeUrl(), { headers });

  const bridgeState = {
    ws,
    audioQueue: [],
    sessionConfigured: false,
  };

  realtimeBridges.set(sessionId, bridgeState);

  publishEvent(sessionId, {
    type: 'openai_realtime_connecting',
    model: OPENAI_REALTIME_MODEL,
    endpoint: OPENAI_REALTIME_URL,
  });

  logBridge('openai_connecting', {
    sessionId,
    model: OPENAI_REALTIME_MODEL,
    endpoint: OPENAI_REALTIME_URL,
  });

  ws.on('open', () => {
    publishEvent(sessionId, {
      type: 'openai_realtime_connected',
      model: OPENAI_REALTIME_MODEL,
    });

    logBridge('openai_connected', {
      sessionId,
      model: OPENAI_REALTIME_MODEL,
    });

    sendSessionConfiguration(sessionId, bridgeState);
    flushQueuedAudio(sessionId, bridgeState);
  });

  ws.on('message', (raw) => {
    handleRealtimeMessage(sessionId, bridgeState, raw);
  });

  ws.on('error', (error) => {
    publishEvent(sessionId, {
      type: 'openai_realtime_socket_error',
      message: error?.message || 'Unknown WebSocket error',
    });

    logBridge('openai_socket_error', {
      sessionId,
      message: error?.message || 'unknown',
    });
  });

  ws.on('close', (code, reasonBuffer) => {
    publishEvent(sessionId, {
      type: 'openai_realtime_closed',
      code,
      reason: reasonBuffer ? reasonBuffer.toString() : '',
    });

    logBridge('openai_closed', {
      sessionId,
      code,
      reason: reasonBuffer ? reasonBuffer.toString() : 'none',
    });

    const current = realtimeBridges.get(sessionId);
    if (current === bridgeState) {
      realtimeBridges.delete(sessionId);
    }
  });

  return bridgeState;
}

function queueAudioForRealtime(sessionId, bridgeState, audioBase64) {
  if (!bridgeState || !audioBase64) return;

  if (bridgeState.ws.readyState === WebSocket.OPEN && bridgeState.sessionConfigured) {
    safeSend(bridgeState.ws, {
      type: 'input_audio_buffer.append',
      audio: audioBase64,
    });
    return;
  }

  bridgeState.audioQueue.push(audioBase64);

  // Prevent unbounded memory growth during long reconnect windows.
  if (bridgeState.audioQueue.length > 4000) {
    bridgeState.audioQueue.splice(0, bridgeState.audioQueue.length - 4000);
  }
}

function muLawToPcmSample(byteValue) {
  // ITU-T G.711 mu-law decode.
  const MU_LAW_BIAS = 0x84;
  const mu = (~byteValue) & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 4) + 0x08) << exponent;
  sample = sample - MU_LAW_BIAS;
  return sign ? -sample : sample;
}

function estimateRmsFromMulaw(payloadBuffer) {
  if (!payloadBuffer || payloadBuffer.length === 0) return 0;

  let sum = 0;
  for (let i = 0; i < payloadBuffer.length; i++) {
    const sample = muLawToPcmSample(payloadBuffer[i]);
    const normalized = sample / 32768;
    sum += normalized * normalized;
  }

  return Math.sqrt(sum / payloadBuffer.length);
}

export function handleTwilioMediaFrame({ sessionId, media }) {
  if (!sessionId || !media?.payload) return;

  const stats = ensureStats(sessionId);
  const payloadBuffer = Buffer.from(media.payload, 'base64');
  const rms = estimateRmsFromMulaw(payloadBuffer);

  stats.chunkCount += 1;
  stats.bytes += payloadBuffer.length;

  publishEvent(sessionId, {
    type: 'audio_level',
    track: media.track || 'unknown',
    rms: Number(rms.toFixed(4)),
    sizeBytes: payloadBuffer.length,
  });

  const bridgeState = ensureRealtimeBridge(sessionId);

  if (bridgeState) {
    queueAudioForRealtime(sessionId, bridgeState, media.payload);
  } else if (!stats.warnedMissingBridge) {
    stats.warnedMissingBridge = true;
    publishEvent(sessionId, {
      type: 'transcription_bridge_unavailable',
      reason: 'OPENAI_API_KEY is not configured on twilio-media-server.',
      fallback: process.env.MOCK_TWILIO_TRANSCRIPTS === 'true' ? 'mock_transcripts' : 'none',
    });

    logBridge('openai_unavailable', {
      sessionId,
      reason: 'OPENAI_API_KEY_missing',
    });
  }

  // Debug signal to show what is forwarded to STT.
  if (stats.chunkCount % 20 === 0) {
    publishEvent(sessionId, {
      type: 'stt_chunk_forwarded',
      chunkCount: stats.chunkCount,
      totalBytes: stats.bytes,
      track: media.track || 'unknown',
      destination: bridgeState ? 'openai_realtime' : 'mock_or_none',
    });
  }

  // Optional mock transcript for environments without Realtime configured.
  if (process.env.MOCK_TWILIO_TRANSCRIPTS === 'true' && !bridgeState) {
    const now = Date.now();
    if (rms > 0.015 && now - stats.lastTranscriptAt > 2500) {
      stats.lastTranscriptAt = now;
      const mockText = `[${media.track || 'unknown'}] audio detected`;
      publishEvent(sessionId, {
        type: 'transcript',
        source: 'mock',
        isFinal: true,
        text: mockText,
      });

      logBridge('transcript_received', {
        sessionId,
        isFinal: 'true',
        sourceType: 'mock',
        chars: mockText.length,
      });
    }
  }
}

export function clearTwilioSessionState(sessionId) {
  streamStats.delete(sessionId);

  const bridgeState = realtimeBridges.get(sessionId);
  if (!bridgeState) return;

  if (bridgeState.ws.readyState === WebSocket.OPEN) {
    safeSend(bridgeState.ws, { type: 'input_audio_buffer.commit' });
    bridgeState.ws.close();
  } else if (bridgeState.ws.readyState === WebSocket.CONNECTING) {
    bridgeState.ws.close();
  }

  realtimeBridges.delete(sessionId);
}


