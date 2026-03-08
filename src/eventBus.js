const SSE_LOG_TYPES = new Set([
  'twilio_stream_start',
  'stt_chunk_forwarded',
  'openai_realtime_connected',
  'openai_realtime_error',
  'transcript',
]);

const sessions = new Map();

function ensureSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      clients: new Set(),
      history: [],
    });
  }
  return sessions.get(sessionId);
}

function logSseEmit(sessionId, eventType, clientCount) {
  if (!SSE_LOG_TYPES.has(eventType)) return;
  console.log(`[bridge][sse] emitted event=${eventType} session=${sessionId} clients=${clientCount}`);
}

export function publishEvent(sessionId, event) {
  if (!sessionId) return;

  const session = ensureSession(sessionId);
  const payload = {
    sessionId,
    ts: new Date().toISOString(),
    ...event,
  };

  session.history.push(payload);
  if (session.history.length > 200) session.history.shift();

  const serialized = `data: ${JSON.stringify(payload)}\n\n`;
  logSseEmit(sessionId, payload.type, session.clients.size);

  for (const res of session.clients) {
    try {
      res.write(serialized);
    } catch {
      session.clients.delete(res);
    }
  }
}

export function subscribeToSession(sessionId, res) {
  const session = ensureSession(sessionId);
  session.clients.add(res);

  // Send warm start context.
  for (const event of session.history) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  return () => {
    session.clients.delete(res);
  };
}

export function dropSession(sessionId) {
  sessions.delete(sessionId);
}
