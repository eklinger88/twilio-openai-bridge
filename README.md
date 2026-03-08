# Twilio Media Server MVP

This service handles:

- outbound call creation via Twilio
- TwiML for call bridging
- Twilio Media Streams websocket intake
- OpenAI Realtime transcription bridge
- live event fanout to frontend via SSE

## Endpoints

- `POST /api/calls/outbound`
- `POST /api/calls/:callSid/end`
- `GET /api/live/sessions/:sessionId/events`
- `POST /twilio/voice`
- `POST /twilio/status`
- `WS /twilio/media-stream`

## 1) Configure `.env`

Use `twilio-media-server/.env.example` as template.

Required values:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER`
- `PUBLIC_HTTP_BASE_URL`
- `PUBLIC_WSS_BASE_URL`
- `OPENAI_API_KEY`

Recommended defaults:

- `OPENAI_REALTIME_MODEL=gpt-realtime`
- `OPENAI_REALTIME_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe`
- `OPENAI_REALTIME_URL=wss://api.openai.com/v1/realtime`
- `OPENAI_REALTIME_SESSION_STYLE=legacy`
- `OPENAI_REALTIME_USE_BETA_HEADER=false`

Optional:

- `INTERNAL_API_KEY` (protect start/end/coaching write endpoints)
- `MOCK_TWILIO_TRANSCRIPTS=false (recommended for real bridge testing)

## 2) Run locally

Use Node 20.6+ (npm scripts use `--env-file`).

```bash
cd C:\Users\Eric\Documents\Playground\GetRiftAi\twilio-media-server
npm install
npm run dev
```

## 3) Expose port for Twilio

```bash
ngrok http 8787
```

Then update:

- `PUBLIC_HTTP_BASE_URL=https://<ngrok-host>.ngrok-free.app`
- `PUBLIC_WSS_BASE_URL=wss://<ngrok-host>.ngrok-free.app`

Restart server after env updates.

## 4) Frontend usage

Frontend subscribes to live events from this service using:

- `VITE_TWILIO_MEDIA_SERVER_URL`

For call start/end, frontend tries direct media-server endpoints first and can fall back to Base44 functions when configured.

## 5) Optional Base44 function secrets (fallback path)

Set in Base44 dashboard only if you want fallback function bridge:

- `TWILIO_MEDIA_SERVER_URL`
- `TWILIO_MEDIA_SERVER_INTERNAL_KEY`

## Expected debug logs

During a healthy call, you should see these stages in server logs:

- `[bridge][twilio_connected]`
- `[bridge][stream_started]`
- `[bridge][media_received]`
- `[bridge][openai_connected]`
- `[bridge][transcript_received]`
- `[bridge][sse] emitted event=transcript`

If `OPENAI_API_KEY` is missing/invalid, you will see:

- `[bridge][openai_unavailable]` or `[bridge][openai_error]`

