# Intake Whisper Assistant — Real-Time Intake Intelligence

A real-time AI assistant for intake agents. It listens through the browser microphone, analyzes the live conversation, and surfaces structured intake guidance silently in the background while the call is in progress.

Built as a hiring case study prototype. Demonstrates a full real-time pipeline: speech capture → WebSocket transport → rule-based intake hints + LLM intake intelligence → structured guidance UI.

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

To show the product without a microphone or live API behavior, use the built-in scripted demo:

1. Start both servers
2. Open `http://localhost:5173` in Chrome
3. Use the **`tr-TR` / `en-US`** language toggle (in the transcript panel) to select the demo language
4. Click **Demo** in the header (requires backend to be connected)
5. Watch the scripted conversation replay automatically

The demo runs a 5-utterance intake scenario through the **real pipeline** — same heuristics, same Gemini LLM call, same UI updates. It is not mocked. You will see:
- A rule-based intake hint fire immediately (e.g. `budget_signal`, `hesitation`, `decision_maker_unknown`)
- An LLM batch response arrive after utterance 3 with `field_status`, `next_questions`, and a `whisper_note`
- Additional utterances trigger further rule hints and a second LLM batch

**Turkish demo** (`tr-TR`): customer with a vague goal, budget constraints, a failed prior attempt, decision-maker uncertainty, and a cost structure question.

**English demo** (`en-US`): same intake scenario in English — unclear need, tight budget, hesitation from prior failure, partner/director approval required, monthly vs. annual cost.

Click **Demo** again to restart. Click **Exit Demo** to return to live microphone mode.

---

## Stack

| Layer    | Technology                                    |
|----------|-----------------------------------------------|
| Frontend | React 18 + Vite (port 5173)                   |
| Backend  | Node.js + Express + `ws` WebSocket (port 3001)|
| STT      | Browser Web Speech API (Chrome only)          |
| LLM      | Google Gemini (`gemini-2.5-flash`)            |

---

## Architecture

```
Browser (React + Vite :5173)
│
├── useWebSocket.js           WS connection, auto-reconnect (10 attempts)
├── useSpeechRecognition.js   Web Speech API, continuous mode, auto-restart
├── TranscriptBar.jsx         Final + interim transcript display
│
│   WebSocket  ws://localhost:3001
│
Backend (Node.js + Express + ws :3001)
│
├── server.js                 WS router, per-connection wiring, demo playback
├── transcriptSession.js      Per-connection utterance store + context window
├── heuristics.js             Rule-based signals with per-type cooldowns
├── analysisTrigger.js        Two-path trigger: immediate (every final) + batched (3 finals / 3s silence)
├── llmAnalyzer.js            Gemini call, responseSchema, 5s timeout, SAFE_FALLBACK
└── promptBuilder.js          System prompt + dynamic user prompt from context window

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
```

If `GEMINI_API_KEY` is absent, the backend starts in **rule-only mode** — heuristics fire normally, the LLM batched path is a silent no-op. The app still works.

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

### `analysis:update` — rule-based (`source: "rule"`)

Fires immediately after each utterance when a keyword is detected:

```json
{
  "source": "rule",
  "signal_type": "budget_signal"
}
```

### `analysis:update` — LLM (`source: "llm"`)

Fires after 3 utterances or 3s of silence:

```json
{
  "source": "llm",
  "customer_signals": ["price_sensitive", "hesitant"],
  "field_status": {
    "customer_goal": "partial",
    "urgency": "unknown",
    "budget": "partial",
    "current_status": "unknown",
    "prior_attempts": "answered",
    "main_constraint": "unknown",
    "decision_maker": "missing",
    "timeline": "unknown",
    "eligibility_risk": "unknown",
    "next_step_readiness": "unknown"
  },
  "next_questions": [
    "Bütçenizle ilgili belirli bir aralık düşündünüz mü?",
    "Bu karar için kimler dahil olacak?"
  ],
  "whisper_note": "Karar vericileri ve bütçe aralığını netleştirin."
}
```

Only sent when `whisper_note`, `next_questions`, or `customer_signals` is non-empty.

---

## Rule-Based Intake Hints

Heuristics run synchronously on every utterance — no LLM required. These are lightweight helpers that complement the LLM, not a replacement for it.

| Signal | Trigger | Maps to | Cooldown |
|--------|---------|---------|----------|
| `budget_signal` | Budget/cost/price keywords | `price_sensitive` | 30 s |
| `urgency_signal` | Urgency/deadline keywords | `urgent` | 25 s |
| `decision_maker_unknown` | Partner/approval/team keywords | `decision_maker_unknown` | 40 s |
| `hesitation` | Uncertainty/hedging keywords | `hesitant` | 20 s |

Only the first matching signal not on cooldown is sent per utterance. Cooldowns reset on session reset or demo restart.

---

## LLM Analysis

- **Model**: `gemini-2.5-flash` via `@google/generative-ai`
- **Output**: enforced structured JSON via `responseSchema` + `responseMimeType: "application/json"`
- **Timeout**: 5 s (`Promise.race`). On timeout, `SAFE_FALLBACK` is returned and the app continues.
- **Concurrency**: `isLlmBusy` per connection. If a batch trigger fires while a call is in-flight, the batch is skipped. The silence timer will fire again when speech resumes.
- **Fallback**: `SAFE_FALLBACK = { source: 'llm', customer_signals: [], field_status: { …all 'unknown' }, next_questions: [], whisper_note: '' }`. Empty results are not sent to the client.
- **Dedup**: accumulated `customer_signals` and `field_status` are carried across LLM batches via `conversationState` and injected into each prompt — the model knows what has already been detected and what fields are already answered.

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
| A     | ✅ Done | Product pivot: intake intelligence layer (schema, session state, LLM analyzer, prompt) |
| B     | ✅ Done | Intake demo scripts (TR + EN), heuristics repurposed as intake signal helpers |

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

- **Chrome only** — Web Speech API (`webkitSpeechRecognition`) is Chrome-specific
- **Internet required** — Web Speech API sends audio to Google's servers even in local dev
- **No speaker diarization** — all speech is treated as a single speaker stream
- **LLM latency** — Gemini responses typically take 1–3 s; the 5 s timeout is generous but visible under load
- **No persistence** — session state is in-memory; restarting the backend clears all sessions
- **Single language per session** — switching language mid-session causes a brief stop/restart of the recognizer

## Future Work

- Speaker diarization (two-channel audio or speaker turn detection)
- Streaming LLM response for lower time-to-first-token
- Persistent session log for post-call review
- Confidence-threshold filtering on STT (currently all finals are forwarded)
- Frontend rebuild for intake-specific UI (whisper note, field coverage, next questions)
- Deployment configuration (HTTPS required for mic in non-localhost environments)
