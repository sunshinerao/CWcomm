# CWcomm Server (Prisma + PostgreSQL)

Backend-only runtime:
- HTTP API + SSE + WS/WebRTC signaling
- Frontend should run as a separate static app (`../web`)

## Requirements

- Node.js 20+
- PostgreSQL 16+ (or `docker compose up -d postgres` from repo root)

## Setup

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:deploy
npm run dev
```

Default bind:
- `CWCOMM_HOST=127.0.0.1`
- `CWCOMM_PORT=8080`

## Translation Provider

- Current language scope: `zh-CN` <-> `en-US` only
- Default: `CWCOMM_TRANSLATION_PROVIDER=mock`
- Real translation (OpenAI):
  1. Set `CWCOMM_TRANSLATION_PROVIDER=openai`
  2. Set `OPENAI_API_KEY`
  3. Optional: set `CWCOMM_OPENAI_MODEL` (default `gpt-4.1-mini`)
  4. Server sends one batch translation request per subtitle ingest and maps results by language code
- You can also point endpoints to OpenAI-compatible providers by setting:
  - `CWCOMM_OPENAI_ENDPOINT`
  - `CWCOMM_OPENAI_ASR_ENDPOINT`
  - `CWCOMM_OPENAI_TTS_ENDPOINT`
  - and corresponding model env vars

## ASR / TTS Provider

- ASR default: `CWCOMM_ASR_PROVIDER=mock` (no transcription)
- TTS default: `CWCOMM_TTS_PROVIDER=mock` (short tone for streaming validation)
- Real ASR/TTS (OpenAI):
  1. Set `CWCOMM_ASR_PROVIDER=openai`
  2. Set `CWCOMM_TTS_PROVIDER=openai`
  3. Ensure `OPENAI_API_KEY` is configured

## Secret Management (macOS Keychain)

```bash
# Store keys (choose service names as needed)
./scripts/dev/keychain-set.sh cwcomm_openai_api_key
./scripts/dev/keychain-set.sh cwcomm_translation_api_key
./scripts/dev/keychain-set.sh cwcomm_asr_api_key
./scripts/dev/keychain-set.sh cwcomm_tts_api_key
```

At runtime:

```bash
source ./scripts/dev/keychain-load.sh
```

## LAN Start

```bash
./scripts/dev/start-lan-dev.sh
```

- Binds server to `0.0.0.0`
- Loads secrets from macOS Keychain
- If `mkcert` exists, enables local HTTPS automatically

## Integration Test

```bash
npm run prisma:deploy
npm run test:integration
```

Tests live in `test/integration.test.ts` and cover event lifecycle, subtitle persistence, and SSE handshake.

## API

- `GET /health`
- `GET /api/events` (supports optional `?status=LIVE`)
- `POST /api/events`
- `POST /api/events/:eventId/transition`
- `GET /api/events/:eventId/subtitles?lang=en-US&after=0`
- `POST /api/events/:eventId/subtitles`
- `POST /api/events/:eventId/speech/ingest` (MIC 识别文本上报 -> 最小翻译占位)
- `GET /api/events/:eventId/subtitles/stream` (SSE)
- `WS /ws/live` (producer/listener/monitor roles; includes metrics stream for admin monitor panel)

### WS Message Quick Spec

- Producer init:
  - `{"type":"produce","eventId":"...","sourceLanguage":"zh-CN","targetLanguages":["en-US"]}`
- Producer audio chunk:
  - `{"type":"asr.chunk","mimeType":"audio/webm","audioBase64":"..."}`
- Listener init:
  - `{"type":"listen","eventId":"...","language":"en-US"}`
- Signaling route:
  - `{"type":"webrtc.offer","to":"<clientId>","sdp":{...}}`
  - `{"type":"webrtc.answer","to":"<clientId>","sdp":{...}}`
  - `{"type":"webrtc.ice","to":"<clientId>","candidate":{...}}`
- Downstream subtitle:
  - `{"type":"subtitle.delta","segment":{"source_text":"...","translated_text":"..."}}`
- Downstream audio:
  - `{"type":"tts.audio","mime_type":"audio/mpeg|audio/wav","audio_base64":"..."}`

## Data Models

- `events`
- `subtitle_segments`

Schema source: `prisma/schema.prisma`.
