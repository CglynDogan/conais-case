# Sales Call Coach — Real-Time Conversation Assistant

A real-time AI coaching assistant for live conversations. It listens to audio from a browser-based call (Jitsi Meet, Google Meet, any browser tab), analyzes the transcript as speech happens, and surfaces coaching feedback, suggested follow-up questions, and info cards on screen — while the conversation is in progress.

Built as a hiring case study prototype. Demonstrates a full real-time pipeline: speech capture → WebSocket transport → rule-based heuristics + LLM coaching → live guidance UI.

**Three input modes:**
| Mode | How to use | When to use |
|------|-----------|-------------|
| **Browser Call** | Click 🖥 Browser Call → share the call tab | Jitsi, Meet, Zoom web, or any browser call |
| **Mic** | Click 🎙 Start | Fallback — captures your local microphone only |
| **Demo** | Click Demo in the header | No audio needed — scripted scenario through the real pipeline |

---

## Quick Start

```bash
# 1. Install dependencies
npm run install:all

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env and add your GEMINI_API_KEY

# 3. Start backend (terminal 1)
npm run backend

# 4. Start frontend (terminal 2)
npm run frontend

# 5. Open in Chrome (required for microphone)
open http://localhost:5173
```

---

## Demo Mode

To show the product without a microphone, use the built-in scripted demo:

1. Start both servers
2. Open `http://localhost:5173` in Chrome
3. Use the **`tr-TR` / `en-US`** language toggle (in the transcript panel) to select the demo language
4. Click **Demo** in the header (requires backend to be connected)
5. Watch the scripted conversation replay automatically

The demo runs a 5-utterance sales scenario through the **real pipeline** — same heuristics, same Gemini LLM call, same UI updates. It is not mocked. You will see:
- A rule-based `Price Objection` signal fire immediately on utterance 1
- An LLM batch response arrive after utterance 3 with coaching feedback, suggested questions, and an info card for ROI
- Utterance 4 triggers a `Long Monologue` rule signal
- A second LLM batch arrives after utterance 5

**Turkish demo** (`tr-TR`): prospect raises a price objection, challenges on competitive pricing, asks about ROI, stalls on commitment, then asks about SLA.

**English demo** (`en-US`): same scenario in English — price concern, competitor comparison, ROI question, team approval stall, SLA inquiry.

Click **Demo** again to restart. Click **Exit Demo** to return to live microphone mode.

---

## Browser Call Mode

The recommended mode for real Jitsi (or any browser-based) calls.

### How it works

1. Open your Jitsi / Meet / browser call in a separate tab
2. Open the coaching app at `http://localhost:5173` (in the same Chrome window)
3. Click **🖥 Browser Call** in the transcript panel
4. Chrome shows a tab/window picker — select your call tab and enable **"Share audio"**
5. The coaching app captures the mixed audio (all participants), streams it to the backend via WebSocket, and Deepgram transcribes it in real time
6. Coaching signals, suggested questions, and info cards appear as the conversation progresses
7. Click **⏹ Stop Capture** (or use Chrome's "Stop sharing" button) to end

### Requirements

- Chrome 107+ (required for audio-only `getDisplayMedia`)
- `DEEPGRAM_API_KEY` set in `backend/.env`
- When the Chrome picker appears, check the **"Share audio"** checkbox — without it the stream has no audio tracks and capture fails with a message

### Language

Use the `tr-TR` / `en-US` toggle before starting capture. The selected language is sent to Deepgram and used in the coaching prompt.

---

## Stack

| Layer    | Technology                                     |
|----------|------------------------------------------------|
| Frontend | React 18 + Vite (port 5173)                    |
| Backend  | Node.js + Express + `ws` WebSocket (port 3001) |
| STT      | Browser Web Speech API (Chrome only)           |
| LLM      | Google Gemini (`gemini-2.5-flash`)             |

---

## Architecture

```
Browser (React + Vite :5173)
│
├── App.jsx                   Coaching UI — Feedback, Questions, Info Card, Transcript panels
├── useWebSocket.js           WS connection, auto-reconnect (10 attempts), sendBinary
├── useSpeechRecognition.js   Web Speech API, continuous mode, auto-restart (mic mode)
├── useTabAudio.js            getDisplayMedia + MediaRecorder → binary WS frames (browser-call mode)
└── TranscriptBar.jsx         Final + interim transcript display (secondary panel)
│
│   WebSocket  ws://localhost:3001
│
Backend (Node.js + Express + ws :3001)
│
├── server.js                 WS router, per-connection wiring, demo + browser-call + Twilio paths
├── transcriptSession.js      Per-connection utterance store + context window
├── heuristics.js             Rule-based tone/pace signals with per-type cooldowns
├── analysisTrigger.js        Two-path trigger: immediate (every final) + batched (configurable size/silence)
├── llmAnalyzer.js            Gemini call, responseSchema, 5s timeout, SAFE_FALLBACK
├── promptBuilder.js          System prompt + dynamic user prompt with speaker annotation
├── audioStream.js            Browser audio stream handler — binary WS chunks → STT → pipeline
├── sttProvider.js            Deepgram streaming STT (configurable format: WebM/Opus or mulaw)
└── twilioStream.js           Twilio MediaStream handler (legacy path — still functional)

Shared (no build step)
└── shared/events.js          WS event name constants — imported by both sides
```

### Two-path analysis

Every finalized utterance triggers two independent paths:

| Path | When | What |
|------|------|------|
| **Immediate** | Every `transcript:final` | Heuristics run synchronously → `analysis:update` with `source: "rule"` |
| **Batched** | After 3 finals OR 3s silence | Gemini called → `analysis:update` with `source: "llm"` |

The paths are independent. A Gemini call in-flight does not block or delay the heuristics path.

---

## Environment Variables

`backend/.env` (copy from `backend/.env.example`):

```
PORT=3001
GEMINI_API_KEY=your_gemini_api_key_here
DEEPGRAM_API_KEY=your_deepgram_api_key_here
TWILIO_STREAM_URL=wss://your-ngrok-subdomain.ngrok.io/twilio-stream
TWILIO_CALL_LANG=tr-TR
```

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No (default `3001`) | HTTP + WS listen port |
| `GEMINI_API_KEY` | No | Gemini LLM. Absent → rule-only mode; heuristics still fire |
| `DEEPGRAM_API_KEY` | For Twilio path | Deepgram streaming STT. Absent → calls connect but produce no transcripts |
| `TWILIO_STREAM_URL` | For Twilio path | Full `wss://` URL Twilio dials for audio — must include `/twilio-stream` path |
| `TWILIO_CALL_LANG` | No (default `tr-TR`) | Language sent to Deepgram and used in the coaching prompt. Override per-call via `?lang=` query param on the webhook URL |
| `DEEPGRAM_MODEL` | No (default `nova-3`) | Deepgram model for phone transcription. Use `nova-2-phonecall` or `nova-2-general` if `nova-3` is unavailable for your plan |

If `GEMINI_API_KEY` is absent, the backend starts in **rule-only mode** — heuristics fire normally, the LLM batched path is a silent no-op. The app still works.

---

## Twilio + Deepgram Setup (Phase T1)

The Twilio path streams phone call audio through the backend for real-time coaching. The browser demo and microphone paths are unaffected.

### What it does

When a Twilio call arrives:
1. Twilio dials `POST /twiml` — backend returns TwiML that opens a MediaStream to `/twilio-stream`
2. Twilio sends mulaw 8kHz audio frames over WebSocket
3. Backend forwards audio to Deepgram's streaming STT
4. Deepgram fires `speech_final` transcripts — backend adds them to the coaching pipeline
5. Connected browser clients receive `transcript:final`, `analysis:update`, `call:started`, and `call:ended` events in real time

### Setup steps

1. **Get a Deepgram API key** at [deepgram.com](https://deepgram.com) — set `DEEPGRAM_API_KEY` in `.env`

2. **Expose the backend publicly** (ngrok example):
   ```bash
   ngrok http 3001
   ```
   Copy the HTTPS URL (e.g. `https://abc123.ngrok.io`).

3. **Set Twilio env vars** in `.env`:
   ```
   TWILIO_STREAM_URL=wss://abc123.ngrok.io/twilio-stream
   TWILIO_CALL_LANG=tr-TR   # or en-US
   ```

4. **Configure Twilio** — in your Twilio console, set the voice webhook for your number to:
   ```
   POST https://abc123.ngrok.io/twiml
   ```
   To use a different language for a specific number, append `?lang=en-US` to the webhook URL.

5. **Restart the backend** — it will log:
   ```
   [SERVER] Twilio stream ready on ws://localhost:3001/twilio-stream
   ```

6. **Call your Twilio number** — the browser UI shows a purple **Live Call mm:ss** indicator in the header. Transcripts appear in the transcript panel; coaching signals fire as normal.

### Source-aware trigger timing

The Twilio path uses tighter batching than the browser/demo path — phone conversations move faster:

| Path | Batch size | Silence window |
|------|-----------|----------------|
| Browser / Demo | 3 utterances | 3 000 ms |
| Twilio call | 2 utterances | 1 500 ms |

---

## HTTP Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Service status — confirms backend is up, shows LLM mode and connected client count |
| `GET /health` | Same response — for automated health checks |

Example response:
```json
{
  "service": "sales-call-coach-backend",
  "status": "ok",
  "websocket": "ready",
  "llm": "enabled",
  "clients": 1,
  "timestamp": 1700000000000
}
```

`llm` is `"enabled"` when `GEMINI_API_KEY` is set, `"rule-only"` otherwise.

---

## WebSocket Event Contract

All messages: `{ type: string, payload: object }`

| Event                | Direction         | Description |
|----------------------|-------------------|-------------|
| `client:ping`        | client → server   | Connectivity check |
| `server:pong`        | server → client   | Ping reply |
| `transcript:interim` | client → server   | Non-final STT chunk (not stored) |
| `transcript:final`   | client → server   | Committed utterance → triggers pipeline |
| `transcript:final`   | server → client   | Demo mode: server echoes scripted lines |
| `demo:trigger`       | client → server   | Start scripted demo playback |
| `analysis:update`    | server → client   | Coaching payload (see shapes below) |
| `call:started`       | server → client   | Twilio call connected. payload: `{ callSid, lang }` |
| `call:ended`         | server → client   | Twilio call ended. payload: `{}` |

### `analysis:update` — rule-based (`source: "rule"`)

Fires immediately after each utterance when a signal is detected:

```json
{
  "source": "rule",
  "tone_alert": {
    "type": "price_objection",
    "message": "Price objection detected"
  }
}
```

### `analysis:update` — LLM (`source: "llm"`)

Fires after 3 utterances or 3s of silence:

```json
{
  "source": "llm",
  "feedback": "Acknowledge the price concern before moving to features.",
  "suggested_questions": [
    "What budget range were you expecting?",
    "Is cost the primary deciding factor for you?",
    "What would make the ROI case clear for your team?"
  ],
  "info_card": {
    "term": "ROI",
    "note": "Return on investment — quantify the value gain vs. total cost over time."
  }
}
```

`info_card` is `null` when not applicable. Only sent when `feedback`, `suggested_questions`, or `info_card` is non-empty.

---

## Rule-Based Signals

Heuristics run synchronously on every utterance — no LLM required.

| Signal | Trigger | Cooldown |
|--------|---------|----------|
| `price_objection` | Price/cost/budget keywords (TR + EN) | 30 s |
| `too_fast` | Estimated WPM > 160, min 5 words | 15 s |
| `long_monologue` | 5+ cumulative utterances | 25 s |

Only the highest-priority signal not on cooldown is sent per utterance. Cooldowns reset on session reset or demo restart.

---

## LLM Analysis

- **Model**: `gemini-2.5-flash` via `@google/generative-ai`
- **Output**: enforced structured JSON via `responseSchema` + `responseMimeType: "application/json"`
- **Timeout**: 5 s (`Promise.race`). On timeout, `SAFE_FALLBACK` is returned and the app continues.
- **Concurrency**: `isLlmBusy` per connection. If a batch trigger fires while a call is in-flight, the batch is skipped. The silence timer re-fires on the next utterance.
- **Fallback**: `SAFE_FALLBACK = { source: 'llm', feedback: '', suggested_questions: [], info_card: null }`. Empty results are not sent to the client.
- **Dedup**: `lastFeedback` from the previous LLM response is included in the prompt as `RECENT_FEEDBACK` to prevent repeating the same coaching note.

---

## How to Use the Microphone

1. Open `http://localhost:5173` in **Chrome** (required)
2. Click **🎙 Start** in the Live Transcript panel
3. Grant microphone permission when prompted
4. Speak — interim text appears as you talk, final text solidifies per sentence
5. Click **⏹ Stop** to end the session
6. Use the **`tr-TR` / `en-US`** toggle to switch language

---

## Phase Summary

| Phase | Status  | Description |
|-------|---------|-------------|
| 1     | ✅ Done | Monorepo skeleton, WebSocket echo, health check |
| 1.1   | ✅ Done | Shared event contract, consistent naming, UI scaffold |
| 2     | ✅ Done | Microphone + live transcript stream (Web Speech API) |
| 3     | ✅ Done | Session state, rule-based heuristics, two-path trigger |
| 4     | ✅ Done | Gemini LLM integration, structured output, fallback |
| 5     | ✅ Done | Demo mode, UI polish, prompt refinement, repo cleanup |
| R     | ✅ Done | Recovery: coaching domain restored, intake pivot reverted |
| T1    | ✅ Done | Twilio MediaStream + Deepgram STT plumbing (legacy path) |
| J1    | ✅ Done | Browser-call mode: getDisplayMedia → Deepgram → pipeline |

---

## Trade-offs and Design Decisions

**Web Speech API over Whisper**: eliminates infra complexity and streaming audio handling. Trade-off: Chrome-only, requires internet, no diarization.

**Rule-based + LLM hybrid**: heuristics give immediate feedback with zero latency and zero cost. LLM handles nuance, suggestions, and context. The two paths are independent so LLM latency never blocks the immediate signal.

**Skip-on-busy over queue**: when the LLM is in-flight and a new batch trigger fires, the batch is skipped rather than queued. For live conversation pace, a queued result 3 s old would be stale. The silence timer re-fires on the next utterance.

**Flat context window**: the LLM receives the last 7 utterances as plain text, not a multi-turn chat. Simpler prompt, predictable token count, sufficient for coaching use.

**`responseSchema` for structured output**: eliminates JSON parsing fragility. The model returns valid schema-conformant JSON; `normalize()` adds a second safety layer for any edge cases.

**Per-connection state**: each WebSocket client gets its own session, heuristics engine, and `isLlmBusy` flag. The LLM analyzer is shared (stateless). This makes multi-client support correct by construction.

---

## Known Limitations

- **Chrome only** — `getDisplayMedia` audio capture and Web Speech API are Chrome-specific
- **Internet required** — Web Speech API sends audio to Google's servers; Deepgram requires network access
- **No speaker diarization** — all speech is treated as a single speaker stream
- **LLM latency** — Gemini responses typically take 1–3 s; the 5 s timeout is generous but visible under load
- **No persistence** — session state is in-memory; restarting the backend clears all sessions
- **Single language per session** — switching language mid-session causes a brief stop/restart of the recognizer

## Future Work

- Speaker diarization (two-channel audio or speaker turn detection)
- Streaming LLM response for lower time-to-first-token
- Persistent session log for post-call review
- Confidence-threshold filtering on STT (currently all finals are forwarded)
- Deployment configuration (HTTPS required for mic in non-localhost environments)
