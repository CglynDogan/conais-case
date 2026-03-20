# Sales Call Coach — Real-Time Conversation Coaching

A real-time AI coaching assistant for live sales conversations. It listens to audio from a browser-based call or microphone, analyzes the transcript as speech happens, and surfaces coaching feedback, guardrail warnings, suggested follow-up questions, and quick-reference info cards — while the conversation is in progress.

Built as a prototype MVP. Demonstrates a full real-time pipeline: speech capture → WebSocket transport → rule-based guardrails + LLM coaching → live guidance UI.

---

## Input Modes

| Mode | How to activate | Audio source |
|------|----------------|--------------|
| **Browser Call** | Click 🖥 Browser Call → share the call tab | Tab/system audio via `getDisplayMedia` + Deepgram STT |
| **Browser Call (Dual Input)** | Same as above — mic activates automatically once tab capture is live | Tab audio (Deepgram) + local mic (Web Speech API) simultaneously |
| **Mic** | Click 🎙 Start | Local microphone via Web Speech API |
| **Demo** | Click Demo in the header | Scripted scenario — no audio hardware needed |

---

## Quick Start

```bash
# 1. Install dependencies
npm run install:all

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env — add at minimum GEMINI_API_KEY
# For Browser Call mode also add DEEPGRAM_API_KEY

# 3. Start backend (terminal 1)
npm run backend

# 4. Start frontend (terminal 2)
npm run frontend

# 5. Open in Chrome
open http://localhost:5173
```

> Chrome is required for microphone input (Web Speech API). Browser Call additionally requires Chrome on Windows — see limitations.

---

## UI Areas

The coaching interface has four distinct areas:

**AI Coaching card** — the primary LLM coaching note, updated every ~3 utterances. Full-width, prominent. Shows actionable guidance based on the last few turns of conversation.

**Warning chips** — rule-based signals that fire immediately after each utterance with no LLM delay. Auto-clear after 8 seconds. Color-coded by urgency (red / orange / violet / amber).

**Suggested Next Questions** — 1–3 follow-up questions from the LLM. The first is marked "Recommended"; additional options appear as alternatives with intent labels (e.g. Değer / ROI, Karar, Engel).

**Quick Reference (Info Card)** — appears only when the LLM identifies a specific term worth a brief definition (e.g. ROI, SLA). Null otherwise.

**Transcript** — chat bubble layout. Speaker side and color are determined by known identity:

| Speaker | Side | Bubble |
|---------|------|--------|
| `me` / `agent` (mic input) | Right | Indigo |
| `customer` (demo mode) | Left | Gray |
| `speaker_0` (diarized — role unknown) | Left | Slate |
| `speaker_1` (diarized — role unknown) | Right | Blue-gray |
| `unknown` | Left | Gray |

Entries are sorted chronologically by timestamp, not by arrival order. This reduces ordering confusion when mic and tab audio arrive at slightly different times.

After a session ends, the transcript remains visible. A **⬇ Export** button appears to download a `.md` file containing the transcript and last coaching state.

---

## Demo Mode

Shows the full coaching pipeline without a microphone or call.

1. Use the `tr-TR` / `en-US` language toggle to select demo language (toggle is visible before capture starts)
2. Click **Demo** in the header
3. Watch a 5-utterance scripted sales scenario replay automatically

The demo runs through the **real pipeline** — same heuristics, same LLM call, same UI. It is not mocked.

Expected signals in the demo:
- `price_objection` fires on utterance 1 (customer raises price concern)
- LLM coaching arrives after utterance 3
- `long_monologue` fires around utterance 4–5
- A second LLM batch arrives after utterance 5

**Turkish demo** (`tr-TR`): price objection → competitor comparison → ROI question → team approval stall → SLA inquiry.
**English demo** (`en-US`): same scenario in English.

Click **Demo** again to restart. Click **Exit Demo** to return to live mode.

---

## Browser Call Mode

Captures audio from a browser tab (Jitsi, Google Meet, Zoom web, or any browser-based call) and streams it to Deepgram for real-time transcription.

### How it works

1. Open your call in a **separate browser tab**
2. Open the coaching app at `http://localhost:5173` in the same Chrome window
3. Click **🖥 Browser Call** in the transcript panel
4. In the Chrome picker, **select your call tab** (not the coaching tab), and check **"Share audio"**
5. Once capture is live, your **local microphone also activates automatically** (dual-input mode)
6. Tab audio transcripts (remote participants) appear as diarized `speaker_0` / `speaker_1` bubbles
7. Your mic speech appears as `agent` / "Ben" bubbles on the right
8. Coaching signals fire for both sides of the conversation
9. Click **⏹ Stop Capture** or use Chrome's "Stop sharing" button to end

### Dual-input behavior

When Browser Call is active:
- Tab audio → Deepgram → `speaker_0` / `speaker_1` (role-honest diarization)
- Local mic → Web Speech API → `speaker: 'agent'` (known identity)
- Both streams write into the same backend session, so the LLM receives true two-sided conversation turns
- **Echo dedup**: if your mic captures a phrase that Deepgram also transcribes from the tab audio (exact normalized match within 6 seconds), the Deepgram copy is suppressed

### Requirements

- **Chrome on Windows** — `getDisplayMedia` tab audio capture is not available on macOS Chrome
- `DEEPGRAM_API_KEY` set in `backend/.env`
- In the Chrome picker, check the **"Share audio"** checkbox — without it no audio tracks are captured

### Language

Set the language toggle (`tr-TR` / `en-US`) before clicking Browser Call. The selected language is sent to Deepgram and used in the coaching prompt.

---

## Mic Mode

1. Click **🎙 Start** in the transcript panel
2. Grant microphone permission when prompted
3. Speak — interim text appears as you talk, final text solidifies per sentence
4. Click **⏹ Stop** to end the session
5. Use the language toggle to switch between `tr-TR` and `en-US`

Mic input is tagged `speaker: 'agent'` — the LLM receives `[agent]` labels and coaches on the agent's response quality as well as the customer's turns.

---

## Transcript Export

When a session ends (stop capture / stop mic / demo finishes), an **⬇ Export** button appears next to the transcript header. Clicking it downloads a `.md` file containing:
- Session date and mode
- Full conversation transcript with speaker labels
- Last coaching advice
- Last set of suggested questions

---

## Architecture

```
Browser (React 18 + Vite :5173)
│
├── App.jsx                   Main UI — coaching card, warning chips, questions, transcript
├── useWebSocket.js           WS connection, auto-reconnect (10 attempts), binary send
├── useSpeechRecognition.js   Web Speech API, continuous mode, auto-restart (mic / dual-input)
├── useTabAudio.js            getDisplayMedia + MediaRecorder → binary WS frames (browser-call)
└── TranscriptBar.jsx         Chat bubble transcript — speaker-aware, timestamp-sorted
│
│   WebSocket  ws://localhost:3001
│   (binary frames for audio chunks; JSON for all other events)
│
Backend (Node.js + Express + ws :3001)
│
├── server.js                 WS router — per-connection wiring, demo + browser-call paths
├── transcriptSession.js      Per-connection utterance store, context window
├── heuristics.js             7 rule-based signals with priority ordering and per-type cooldowns
├── analysisTrigger.js        Two-path trigger: immediate (every final) + batched (size/silence)
├── llmAnalyzer.js            Gemini/OpenAI call, responseSchema, 10s timeout, SAFE_FALLBACK
├── promptBuilder.js          System prompt + dynamic user prompt with speaker annotation
├── audioStream.js            Browser audio handler — binary WS chunks → Deepgram → pipeline
└── sttProvider.js            Deepgram streaming STT (WebM/Opus from browser MediaRecorder)

Shared (no build step)
└── shared/events.js          WS event name constants — imported by both sides
```

### Two-path coaching pipeline

Every finalized utterance triggers two independent paths:

| Path | Trigger | What happens |
|------|---------|-------------|
| **Immediate** | Every `transcript:final` | Heuristics run synchronously → `analysis:update { source: "rule" }` |
| **Batched** | After 3 finals OR 3s silence | LLM called → `analysis:update { source: "llm" }` |

The paths are fully independent. An in-flight LLM call does not block or delay the heuristics path.

### Speaker attribution

| Source | Speaker tag | Rationale |
|--------|------------|-----------|
| Mic (Web Speech API) | `agent` | Known — user's own microphone |
| Demo script | `customer` | Known — scripted customer lines |
| Browser tab audio (Deepgram diarized) | `speaker_0`, `speaker_1` | Role unknown — honest label |
| Browser tab audio (undiarized) | `unknown` | No speaker info available |

The LLM prompt handles all cases: `[agent]`/`[customer]` for known roles, `[speaker_0]`/`[speaker_1]` for diarized-but-unknown, and unlabeled for all-unknown sessions.

---

## Rule-Based Signals (Guardrails)

Heuristics run synchronously on every utterance — zero LLM latency, zero API cost. Only the highest-priority signal not on cooldown fires per utterance.

### Priority order (highest first)

| Signal | Fires when | Cooldown | Speaker scope |
|--------|-----------|---------|--------------|
| `emotionally_escalated` | Anger/frustration keywords from non-agent | 20 s | Non-agent only |
| `overwhelmed` | Confusion/overload keywords from non-agent | 25 s | Non-agent only |
| `customer_closing` | Dismissal/exit phrases from non-agent | 30 s | Non-agent only |
| `price_objection` | Price/cost/budget keywords from non-agent | 30 s | Non-agent only |
| `over_persuading` | 3+ consecutive `agent` turns in context window | 20 s | Agent turns only |
| `too_fast` | Estimated WPM > 160, min 5 words | 15 s | Any speaker |
| `long_monologue` | 5+ cumulative utterances in session | 25 s | Any speaker |

### Actionable messages (bilingual TR/EN)

Each signal surfaces a coaching message, not just a label. Examples:

- `emotionally_escalated` → "Gerilim yükseliyor; savunmaya geçme, önce gerilimi düşür."
- `overwhelmed` → "Karşı taraf bunalmış olabilir; basitleştir ve kısa soru sor."
- `customer_closing` → "Müşteri kapanıyor olabilir; zorlamak yerine netleştirici soru sor."
- `over_persuading` → "Üst üste konuşuyorsun; müşterinin tepkisini bekle."
- `price_objection` → "Fiyat itirazı tespit edildi" / "Price objection detected"
- `too_fast` → "Tempo çok hızlı" / "Pace is too fast"
- `long_monologue` → "Uzun konuşma — soru sormayı deneyin" / "Long monologue — try asking a question"

**Note on `over_persuading`**: only fires when speaker identity is `agent` (confirmed mic input). Does not fire in tab-only Browser Call where speakers are diarized as `speaker_0`/`speaker_1`.

---

## LLM Coaching

- **Provider**: Gemini (default) or OpenAI — selected via `LLM_PROVIDER` env var
- **Default model**: `gemini-3.1-flash-lite-preview` (overridable via `GEMINI_MODEL`)
- **Structured output**: Gemini uses `responseSchema` + `responseMimeType: "application/json"` — no parsing fragility
- **Timeout**: 10 seconds (`Promise.race`). On timeout, `SAFE_FALLBACK` is returned and displayed coaching is preserved
- **Concurrency guard**: `isLlmBusy` per connection. If a batch triggers while a call is in-flight, that batch is skipped — the silence timer catches remaining content
- **Coaching dedup**: `lastFeedback` from the previous response is included in the prompt as `RECENT_FEEDBACK` to avoid repeating the same advice
- **Fallback**: `SAFE_FALLBACK = { source: 'llm', feedback: '', suggested_questions: [], info_card: null }`. Empty results are not broadcast to the client — prior coaching stays visible

### Output shape

```json
{
  "source": "llm",
  "feedback": "Acknowledge the price concern before moving to value.",
  "suggested_questions": [
    "What budget range were you expecting?",
    "Is cost the primary deciding factor?",
    "What would make the ROI case clear for your team?"
  ],
  "info_card": {
    "term": "ROI",
    "note": "Return on investment — quantify value gain vs. total cost over time."
  }
}
```

`info_card` is `null` when not applicable. The full payload is only sent when at least one field is non-empty.

---

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in the required keys.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3001` | HTTP and WebSocket listen port |
| `LLM_PROVIDER` | No | `gemini` | `gemini` (recommended) or `openai` |
| `GEMINI_API_KEY` | When `LLM_PROVIDER=gemini` | — | Gemini API key. Absent → rule-only mode |
| `GEMINI_MODEL` | No | `gemini-3.1-flash-lite-preview` | Override Gemini model |
| `OPENAI_API_KEY` | When `LLM_PROVIDER=openai` | — | OpenAI API key. Absent → rule-only mode |
| `OPENAI_MODEL` | No | `gpt-5-nano` | Override OpenAI model |
| `DEEPGRAM_API_KEY` | For Browser Call mode | — | Deepgram streaming STT. Absent → no tab transcripts |
| `DEEPGRAM_MODEL` | No | `nova-3` | Deepgram STT model |

If neither `GEMINI_API_KEY` nor `OPENAI_API_KEY` is present, the backend starts in **rule-only mode** — heuristics fire normally, the LLM path is a silent no-op. The app is still usable.

### OpenAI note

The OpenAI path is available as an experiment but is **not recommended** for this prototype. Under real-time latency constraints, `gpt-5-nano` has produced unreliable structured JSON output and truncation issues. Gemini is the validated default.

---

## WebSocket Event Contract

All messages use the shape `{ type: string, payload: object }`. Event names live in `shared/events.js` — imported by both frontend and backend.

| Event | Direction | Description |
|-------|-----------|-------------|
| `client:ping` | client → server | Connectivity check |
| `server:pong` | server → client | Ping reply |
| `transcript:interim` | client → server | Non-final STT chunk (not stored, not analyzed) |
| `transcript:final` | client → server | Committed utterance → triggers pipeline |
| `transcript:final` | server → client | Browser-call / demo: server echoes transcribed or scripted lines |
| `audio:start` | client → server | Browser-call starting. `payload: { lang }` — resets session on server, opens Deepgram WS |
| `audio:stop` | client → server | Browser-call ending |
| `audio:error` | server → client | Server-side audio error (e.g. Deepgram key missing). `payload: { reason }` |
| `demo:trigger` | client → server | Start scripted demo playback. `payload: { lang }` |
| `analysis:update` | server → client | Coaching payload — rule-based or LLM (see shapes above) |

### `analysis:update` — rule-based

```json
{
  "source": "rule",
  "tone_alert": {
    "type": "emotionally_escalated",
    "message": "Gerilim yükseliyor; savunmaya geçme, önce gerilimi düşür."
  }
}
```

### `analysis:update` — LLM

See LLM output shape above.

---

## HTTP Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Service status — confirms backend is up, LLM mode, connected client count |
| `GET /health` | Same response — for automated health checks |

Example status response:

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

`llm` is `"enabled"` when an API key is configured, `"rule-only"` otherwise.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18 + Vite (port 5173) |
| Backend | Node.js + Express + `ws` WebSocket (port 3001) |
| Tab STT | Deepgram streaming (`nova-3`, `diarize=true`, WebM/Opus) |
| Mic STT | Browser Web Speech API (Chrome only) |
| LLM | Google Gemini via `@google/generative-ai` |
| Audio capture | `getDisplayMedia` + `MediaRecorder` (browser-call) |

---

## Known Limitations

**Browser Call requires Chrome on Windows.** `getDisplayMedia` tab audio capture is not supported on macOS Chrome. On macOS, only Mic mode is available.

**Near-duplicate echo in dual-input mode.** When Browser Call and mic are both active, the user's own voice enters via both streams. Exact-match dedup (normalized text, 6s window) suppresses identical transcriptions. If Web Speech API and Deepgram transcribe the same audio slightly differently, both versions may appear.

**Transcript ordering is approximate.** Entries are sorted by the timestamp when the STT engine produced the result — not when speech started. For long utterances, Deepgram's timestamp can be 1–2s after speech onset, which may place the entry after a subsequent mic utterance.

**`long_monologue` counts total session utterances, not consecutive agent turns.** It fires when the session reaches 5 total utterances regardless of speaker distribution. It may trigger even when both sides are actively speaking.

**`over_persuading` only works in mic mode and dual-input mode.** It detects consecutive `agent`-labeled turns. In tab-only Browser Call, all speakers are diarized as `speaker_0`/`speaker_1` — no `agent` label exists, so the signal never fires.

**One signal per utterance.** Only the highest-priority signal not on cooldown fires. If a customer utterance is both emotionally escalated and contains a price objection, only `emotionally_escalated` appears.

**No session persistence.** All session state is in-memory. Restarting the backend clears all active sessions. There is no post-call analytics or history.

**No authentication or access control.** The WebSocket and HTTP endpoints are open. Any client that can reach the server can trigger the pipeline and consume API quota.

**LLM temperature not tuned.** Gemini runs at the API default (1.0). Lower values (0.2–0.3) would produce more consistent coaching responses but are not currently configured.

**Web Speech API requires Chrome and internet.** The browser sends audio to Google's servers for processing. It is not available in Firefox or Safari.

**LLM latency is visible.** Gemini responses typically take 1–3 seconds. The 10-second timeout is generous for a live conversation context but the delay between utterance and LLM coaching is noticeable.

---

## Design Decisions

**Rule-based + LLM hybrid.** Heuristics give zero-latency feedback at zero API cost. The LLM handles nuance, context, and suggested questions. The two paths are fully independent — LLM latency never delays a guardrail signal.

**Skip-on-busy over queue.** When the LLM is in-flight and a new batch trigger fires, the batch is skipped rather than queued. A result produced 3+ seconds after the trigger is stale for a live conversation. The silence timer fires again on the next utterance.

**`responseSchema` for structured output.** Eliminates JSON parsing fragility in the Gemini path. The model returns schema-conformant JSON directly; a `normalize()` layer adds a second safety pass for edge cases.

**Honest speaker labels.** Diarized speakers are labeled `speaker_0`/`speaker_1` — not assumed to be agent or customer. The LLM prompt explicitly handles this uncertainty and instructs the model to infer posture from context rather than role assumption.

**Per-connection state.** Each WebSocket client gets its own transcript session, heuristics engine, and `isLlmBusy` flag. The LLM analyzer is shared and stateless. Multi-client support is correct by construction.

**Pre-warming Deepgram.** `AUDIO_START` is sent to the backend before `getDisplayMedia` opens the tab picker. The Deepgram WebSocket handshake completes during the 2–5 seconds the user spends selecting a tab — the first audio chunk hits an already-open connection.
