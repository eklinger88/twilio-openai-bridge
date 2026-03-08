import cors from 'cors';
import crypto from 'node:crypto';
import express from 'express';
import http from 'node:http';
import { URL } from 'node:url';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { publishEvent, subscribeToSession, dropSession } from './eventBus.js';
import { handleTwilioMediaFrame, clearTwilioSessionState } from './transcriptionPipeline.js';

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env.PORT || 8787);

function readEnv(name, fallback = '') {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;

  const value = raw.trim();
  // Treat template placeholders like <PASTE_VALUE> as unset.
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

const PUBLIC_HTTP_BASE_URL = readEnv('PUBLIC_HTTP_BASE_URL', `http://localhost:${PORT}`);
const PUBLIC_WSS_BASE_URL = readEnv('PUBLIC_WSS_BASE_URL', `ws://localhost:${PORT}`);

const TWILIO_ACCOUNT_SID = readEnv('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = readEnv('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_NUMBER = readEnv('TWILIO_FROM_NUMBER');
const INTERNAL_API_KEY = readEnv('INTERNAL_API_KEY');

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

function requireInternalKey(req, res, next) {
  if (!INTERNAL_API_KEY) return next();
  const provided = req.get('x-internal-key');
  if (provided !== INTERNAL_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/live/sessions/:sessionId/events', (req, res) => {
  const { sessionId } = req.params;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  logBridge('sse_client_connected', { sessionId });

  const unsubscribe = subscribeToSession(sessionId, res);

  req.on('close', () => {
    unsubscribe();
    logBridge('sse_client_disconnected', { sessionId });
  });
});

app.post('/api/live/sessions/:sessionId/coaching', requireInternalKey, (req, res) => {
  const { sessionId } = req.params;
  publishEvent(sessionId, {
    type: 'coaching',
    source: 'backend',
    payload: req.body,
  });
  res.json({ ok: true });
});

app.post('/api/calls/outbound', requireInternalKey, async (req, res) => {
  try {
    if (!twilioClient || !TWILIO_FROM_NUMBER) {
      return res.status(500).json({
        error: 'Twilio outbound is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER.',
      });
    }

    const { to, repNumber, sessionId } = req.body || {};
    if (!to || !repNumber || !sessionId) {
      return res.status(400).json({ error: 'to, repNumber, and sessionId are required' });
    }

    logBridge('outbound_call_requested', { sessionId, repNumber, to });

    // Step 1 (MVP): Twilio calls repNumber.
    // Step 2 (TwiML): once rep answers, Twilio dials the prospect and starts media stream.
    const voiceUrl = `${PUBLIC_HTTP_BASE_URL}/twilio/voice?sessionId=${encodeURIComponent(sessionId)}&customer=${encodeURIComponent(to)}`;

    const call = await twilioClient.calls.create({
      to: repNumber,
      from: TWILIO_FROM_NUMBER,
      url: voiceUrl,
      method: 'POST',
      statusCallback: `${PUBLIC_HTTP_BASE_URL}/twilio/status?sessionId=${encodeURIComponent(sessionId)}`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    publishEvent(sessionId, {
      type: 'call_started',
      callSid: call.sid,
      status: call.status,
      repNumber,
      customerNumber: to,
    });

    logBridge('outbound_call_created', { sessionId, callSid: call.sid, status: call.status });

    res.json({ callSid: call.sid, sessionId, status: call.status });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to start call' });
  }
});

app.post('/api/calls/:callSid/end', requireInternalKey, async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({ error: 'Twilio outbound is not configured.' });
    }

    const { callSid } = req.params;
    await twilioClient.calls(callSid).update({ status: 'completed' });
    logBridge('outbound_call_end_requested', { callSid });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Failed to end call' });
  }
});

app.post('/twilio/status', (req, res) => {
  const sessionId = req.query.sessionId || req.body?.sessionId;
  if (sessionId) {
    publishEvent(sessionId, {
      type: 'call_status',
      callSid: req.body?.CallSid,
      callStatus: req.body?.CallStatus,
      direction: req.body?.Direction,
    });

    logBridge('twilio_status', {
      sessionId,
      callSid: req.body?.CallSid,
      callStatus: req.body?.CallStatus,
    });
  }
  res.status(204).end();
});

app.all('/twilio/voice', (req, res) => {
  const sessionId = req.query.sessionId || req.body?.sessionId || crypto.randomUUID();
  const customerNumber = req.query.customer || req.body?.customer || req.body?.To;

  const twiml = new twilio.twiml.VoiceResponse();
  const start = twiml.start();
  start.stream({
    url: `${PUBLIC_WSS_BASE_URL}/twilio/media-stream?sessionId=${encodeURIComponent(sessionId)}`,
    track: 'both_tracks',
  });

  if (customerNumber) {
    const dial = twiml.dial({ callerId: TWILIO_FROM_NUMBER, answerOnBridge: true });
    dial.number(String(customerNumber));
  } else {
    twiml.say('Missing customer number for this call.');
  }

  publishEvent(sessionId, {
    type: 'twiml_served',
    customerNumber: customerNumber || null,
  });

  logBridge('twiml_served', { sessionId, customerNumber: customerNumber || 'missing' });

  res.type('text/xml').send(twiml.toString());
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  if (reqUrl.pathname !== '/twilio/media-stream') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  let sessionId = reqUrl.searchParams.get('sessionId') || '';
  let mediaFrameCount = 0;

  logBridge('twilio_connected', { sessionId: sessionId || 'pending' });

  if (sessionId) {
    publishEvent(sessionId, { type: 'media_stream_connected' });
  }

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const eventType = msg?.event;

      if (eventType === 'start') {
        const customSessionId = msg?.start?.customParameters?.sessionId;
        sessionId = customSessionId || sessionId || msg?.start?.callSid || 'unknown-session';

        publishEvent(sessionId, {
          type: 'twilio_stream_start',
          streamSid: msg?.streamSid || msg?.start?.streamSid,
          callSid: msg?.start?.callSid || null,
          tracks: msg?.start?.tracks || null,
        });

        logBridge('stream_started', {
          sessionId,
          callSid: msg?.start?.callSid || null,
          streamSid: msg?.streamSid || msg?.start?.streamSid || null,
        });
        return;
      }

      if (eventType === 'media') {
        if (!sessionId) return;
        mediaFrameCount += 1;

        if (mediaFrameCount === 1 || mediaFrameCount % 100 === 0) {
          logBridge('media_received', {
            sessionId,
            track: msg?.media?.track || 'unknown',
            frames: mediaFrameCount,
          });
        }

        handleTwilioMediaFrame({ sessionId, media: msg.media });
        return;
      }

      if (eventType === 'mark') {
        if (!sessionId) return;
        publishEvent(sessionId, {
          type: 'twilio_mark',
          name: msg?.mark?.name || null,
        });
        return;
      }

      if (eventType === 'stop') {
        if (!sessionId) return;
        publishEvent(sessionId, {
          type: 'twilio_stream_stop',
          streamSid: msg?.streamSid || null,
        });

        logBridge('stream_stopped', { sessionId, streamSid: msg?.streamSid || null });

        clearTwilioSessionState(sessionId);
        return;
      }

      if (sessionId) {
        publishEvent(sessionId, {
          type: 'twilio_unknown_event',
          eventType,
        });
      }
    } catch (error) {
      if (sessionId) {
        publishEvent(sessionId, {
          type: 'media_stream_error',
          message: error?.message || 'invalid_media_message',
        });
      }
    }
  });

  ws.on('close', () => {
    if (!sessionId) return;
    publishEvent(sessionId, { type: 'media_stream_closed' });
    clearTwilioSessionState(sessionId);
    logBridge('twilio_disconnected', { sessionId });
    // Keep recent history for reconnect debugging.
    setTimeout(() => dropSession(sessionId), 10 * 60 * 1000);
  });
});

server.listen(PORT, () => {
  console.log(`[twilio-media-server] listening on ${PORT}`);
});
