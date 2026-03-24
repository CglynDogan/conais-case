# Sales Call Coach — Real-Time Conversation Coaching

A real-time AI coaching assistant for live sales conversations. It listens to audio from a browser-based call or local microphone, analyzes the transcript as speech happens, and surfaces coaching feedback, guardrail warnings, suggested follow-up questions, and quick-reference info cards — while the conversation is in progress.

Built as a prototype MVP. Demonstrates a full real-time pipeline: speech capture → WebSocket transport → rule-based guardrails + LLM coaching → live guidance UI.

---

## Input Modes

| Mode | How to activate | Audio source |
|------|----------------|--------------|
| **Browser Call** | Click Browser Call → share the call tab | Tab/system audio via `getDisplayMedia` + Deepgram STT (diarized) |
| **Browser Call (Dual Input)** | Same as above — mic activates automatically once tab capture is live | Tab audio (Deepgram, diarized) + local mic (Web Speech API) simultaneously |
| **Mic** | Click Start | Local microphone via Deepgram STT (`useMicStream`) |
| **Demo** | Click Demo in the header | Scripted scenario — no audio hardware needed |

---

## Quick Start

```bash
# 1. Install dependencies
npm run install:all

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env — add at minimum GEMINI_API_KEY
# For Browser Call and Mic modes also add DEEPGRAM_API_KEY

# 3. Start backend (terminal 1)
npm run backend

# 4. Start frontend (terminal 2)
npm run frontend

# 5. Open in Chrome
open http://localhost:5173
```

> Chrome is recommended. Browser Call requires a browser that supports `getDisplayMedia` with audio. Mic mode uses `getUserMedia` which works in all modern browsers, but Deepgram STT requires `DEEPGRAM_API_KEY` to be set.

---

## UI Areas

The coaching interface has four areas in the right column, ordered top to bottom:

**Warning chips** — rule-based signals that fire immediately after each utterance with no LLM delay. Auto-clear after 8 seconds. Color-coded by urgency (red / orange / violet / amber). Displayed at the top so urgent signals are seen immediately.

**AI Coaching card** — the LLM coaching note. Shows the two most recent notes: the latest is displayed fully, the previous one appears below it with reduced opacity for context. Both are synthesized from recent session history. Updates on every agent turn (immediately) or after customer silence.

**Suggested Next Questions** — 1–3 follow-up questions from the LLM. The first is marked "Recommended" and is the highest-leverage question for advancing the sale at the current conversation stage. Additional options appear as alternatives with intent labels (e.g. Değer / ROI, Karar, Engel). Questions are only generated after customer turns — agent turns return an empty list and leave prior questions visible.

**Quick Reference (Info Card)** — appears only when the LLM identifies a specific term worth a brief definition (e.g. ROI, SLA, POC). Null otherwise.

**Transcript** — chat bubble layout. Side is determined by audio source, not diarized identity:

| Speaker tag | Side | Notes |
|-------------|------|-------|
| `agent` (Deepgram mic or Web Speech API mic) | Right | Known — user's own microphone |
| `me` (legacy mic label) | Right | |
| `customer` (demo mode) | Left | Known — scripted customer lines |
| `speaker_0` (diarized — role unknown) | Left | Remote participant, role not confirmed |
| `speaker_1` (diarized — role unknown) | Left | Remote participant, role not confirmed |
| `unknown` | Left | No speaker info |

All diarized speakers from tab audio appear on the left regardless of their index. Only mic-sourced speech appears on the right. Entries are sorted chronologically by timestamp, not arrival order.

After a session ends, the transcript remains visible. **Export** buttons appear to download the session as `.md` or `.json`.

---

## Demo Mode

Shows the full coaching pipeline without a microphone or call.

1. Use the `tr-TR` / `en-US` language toggle to select demo language
2. Click **Demo** in the header
3. Watch a 5-utterance scripted sales scenario replay automatically

The demo runs through the real pipeline — same heuristics, same LLM call, same UI. It is not mocked.

Expected signals in the demo:
- `price_objection` fires on utterance 1 (customer raises price concern)
- LLM coaching arrives after customer silence
- `long_monologue` may fire if the agent has spoken without asking a question
- A second LLM batch arrives after subsequent utterances

**Turkish demo** (`tr-TR`): price objection → competitor comparison → ROI question → team approval stall → SLA inquiry.
**English demo** (`en-US`): same scenario in English.

Click **Demo** again to restart. Click **Exit Demo** to return to live mode.

---

## Browser Call Mode

Captures audio from a browser tab (Jitsi, Google Meet, Zoom web, or any browser-based call) and streams it to Deepgram for real-time transcription.

### How it works

1. Open your call in a **separate browser tab**
2. Open the coaching app at `http://localhost:5173` in the same browser window
3. Click **Browser Call** in the transcript panel
4. In the browser picker, **select your call tab** and check **"Share audio"**
5. Once capture is live, your **local microphone also activates automatically** (dual-input mode)
6. Tab audio transcripts (remote participants) appear as diarized `speaker_0` / `speaker_1` bubbles on the left
7. Your mic speech (Web Speech API) appears as `agent` bubbles on the right
8. Coaching signals fire for both sides of the conversation
9. Click **Stop Capture** or use the browser's "Stop sharing" button to end

### Dual-input behavior

When Browser Call is active:
- Tab audio → Deepgram → `speaker_0` / `speaker_1` (role-honest diarization, both rendered left)
- Local mic → Web Speech API → `speaker: 'agent'` (known identity, rendered right)
- Both streams write into the same backend session so the LLM receives a true two-sided conversation
- **Echo dedup**: if your mic captures a phrase that Deepgram also transcribes from the tab audio (exact normalized match within 6 seconds), the Deepgram copy is suppressed. Near-duplicate transcriptions (minor wording differences) may still appear.

### Coaching modes in Browser Call

The system tracks whether the agent has spoken recently using a 12-second participation window:

- **Customer Insight Mode**: agent has not spoken within the last 12 seconds. The LLM still runs on customer turns, but evaluates customer posture and intent only — it does not evaluate agent response quality since there is no recent agent turn to evaluate.
- **Full Coaching Mode**: agent spoke within the last 12 seconds. The LLM evaluates the full conversation including the agent's response quality.

Only substantive agent turns advance the participation window. Short backchannels ("evet", "tamam", "okay", "got it", etc.) are filtered and do not count.

### Requirements

- `DEEPGRAM_API_KEY` set in `backend/.env`
- In the browser picker, check the **"Share audio"** checkbox — without it no audio is captured
- Chrome is recommended for `getDisplayMedia` tab audio support

### Language

Set the language toggle (`tr-TR` / `en-US`) before clicking Browser Call. The selected language is sent to Deepgram and used in the coaching prompt.

---

## Mic Mode

Mic mode routes local microphone audio through Deepgram (nova-3) for transcription — the same STT engine used for Browser Call tab audio.

1. Click **Start** in the transcript panel
2. Grant microphone permission when prompted
3. Speak — committed transcript segments appear as speech is recognized
4. Click **Stop** to end the session

Mic input is tagged `speaker: 'agent'`. Diarization is disabled for mic-only sessions (single speaker). The LLM receives `[agent]` labels and coaches on agent response quality as well as accumulated customer context.

Note: mic mode does not show interim (in-progress) text while speaking — only finalized segments appear.

---

## Transcript Export

When a session ends, **MD** and **JSON** export buttons appear next to the transcript header.

**Markdown export** (`.md`) contains:
- Session date and mode
- Full conversation as a chronological timeline with speaker labels
- Coaching notes interleaved at the timestamps they were delivered
- Last set of suggested questions

**JSON export** (`.json`) contains the same timeline as structured data:
```json
{
  "session": { "date": "...", "mode": "Browser Call" },
  "timeline": [
    { "type": "utterance", "speaker": "Speaker 0", "text": "...", "ts": "..." },
    { "type": "coaching",  "text": "...", "ts": "..." }
  ],
  "suggested_questions": ["...", "..."]
}
```

Coaching entries in the export reflect the synthesis notes as delivered during the session — not raw intermediate LLM outputs.

---

## Architecture

```
Browser (React 18 + Vite :5173)
│
├── App.jsx                   Main UI — warning chips, coaching card, questions, transcript
├── useWebSocket.js           WS connection, auto-reconnect, binary send
├── useMicStream.js           getUserMedia + MediaRecorder → binary WS frames (mic mode)
├── useSpeechRecognition.js   Web Speech API, continuous mode, auto-restart (Browser Call dual-input)
├── useTabAudio.js            getDisplayMedia + MediaRecorder → binary WS frames (browser-call)
└── TranscriptBar.jsx         Chat bubble transcript — source-aware sides, timestamp-sorted
│
│   WebSocket  ws://localhost:3001
│   (binary frames for audio chunks; JSON for all other events)
│
Backend (Node.js + Express + ws :3001)
│
├── server.js                 WS router — per-connection wiring, coaching mode logic, demo path
├── transcriptSession.js      Per-connection utterance store, context window
├── heuristics.js             7 rule-based signals with priority ordering and per-type cooldowns
├── analysisTrigger.js        Two-path trigger: immediate (every final) + silence/agent-based batch
├── llmAnalyzer.js            Gemini/OpenAI call, responseSchema, 10s timeout, SAFE_FALLBACK
├── promptBuilder.js          System prompt + dynamic user prompt with speaker annotation
├── audioStream.js            Audio handler — binary WS chunks → Deepgram → pipeline (browser-call + mic)
└── sttProvider.js            Deepgram streaming STT (WebM/Opus, smart_format, filler_words)

Shared (no build step)
└── shared/events.js          WS event name constants — imported by both sides
```

### Two-path coaching pipeline

Every finalized utterance triggers two independent paths:

| Path | Trigger | What happens |
|------|---------|-------------|
| **Immediate** | Every `transcript:final` | Heuristics run synchronously → `analysis:update { source: "rule" }` |
| **Batched** | Agent turn: fires immediately. Customer turn: fires after silence. | LLM called → `analysis:update { source: "llm" }` |

**Batched trigger details:**
- **Agent turn**: LLM fires immediately when the agent speaks. This is the primary trigger — the full preceding customer block is now in session context.
- **Customer turn**: LLM does not fire on each fragment. Instead a silence timer fires:
  - If the latest customer fragment ends with terminal punctuation (`.`, `?`, `!`) → 1.2s silence window (sentence complete)
  - If the fragment ends mid-sentence (no terminal punctuation) → 2.5s silence window (waiting for the thought to complete)
  - Hard cap at 8 fragments triggers the LLM unconditionally to prevent indefinite delay
- The immediate heuristics path and the batched LLM path are fully independent. An in-flight LLM call does not block guardrail signals.

### LLM coaching synthesis

Rather than sending only the most recent coaching note as context, the backend accumulates the last 3 feedback notes (`recentFeedbacks`) and passes them to the prompt on every LLM call. The model is instructed to synthesize these into a single coherent directive — not to repeat any prior note verbatim, and to treat a repeated theme as resolved and advance to the next critical action.

If the agent's latest turn already executed what the prior coaching suggested, the model is instructed to acknowledge the execution and coach the next step instead.

### Speaker attribution

| Source | Speaker tag | LLM label |
|--------|------------|-----------|
| Mic (Deepgram via `useMicStream`) | `agent` | `[agent]` |
| Mic (Web Speech API, Browser Call dual-input) | `agent` | `[agent]` |
| Demo script | `customer` | `[customer]` |
| Browser tab audio (Deepgram diarized) | `speaker_0`, `speaker_1` | `[speaker_0]`, `[speaker_1]` |
| Browser tab audio (undiarized) | `unknown` | unlabeled |

The LLM prompt handles all cases. For diarized-but-unknown speakers, the model infers posture from observable cues (who raises objections, who responds, emotional charge, turn patterns) rather than assuming roles.

---

## Rule-Based Signals (Guardrails)

Heuristics run synchronously on every utterance — zero LLM latency, zero API cost. Only the highest-priority signal not on cooldown fires per utterance.

### Priority order (highest first)

| Signal | Fires when | Cooldown | Speaker scope |
|--------|-----------|---------|--------------|
| `emotionally_escalated` | Anger/frustration keywords | 20 s | Non-agent only |
| `overwhelmed` | Confusion/overload keywords | 25 s | Non-agent only |
| `customer_closing` | Dismissal/exit phrases | 30 s | Non-agent only |
| `price_objection` | Price/cost/budget keywords | 30 s | Non-agent only |
| `over_persuading` | 3+ consecutive `agent` turns in context window | 20 s | Requires `agent` label |
| `too_fast` | Estimated WPM > 160, min 5 words | 15 s | Any speaker |
| `long_monologue` | 5+ utterances in session AND agent just spoke without a question | 25 s | Agent only |

### Signal messages (bilingual TR/EN)

- `emotionally_escalated` → "Gerilim yükseliyor; savunmaya geçme, önce gerilimi düşür."
- `overwhelmed` → "Karşı taraf bunalmış olabilir; basitleştir ve kısa soru sor."
- `customer_closing` → "Müşteri kapanıyor olabilir; zorlamak yerine netleştirici soru sor."
- `over_persuading` → "Üst üste konuşuyorsun; müşterinin tepkisini bekle."
- `price_objection` → "Fiyat itirazı tespit edildi" / "Price objection detected"
- `too_fast` → "Tempo çok hızlı" / "Pace is too fast"
- `long_monologue` → "Uzun konuşma — soru sormayı deneyin" / "Long monologue — try asking a question"

**Notes:**
- `over_persuading` only fires when speaker identity is `agent` (confirmed mic input). Does not fire in tab-only Browser Call where speakers are diarized as `speaker_0`/`speaker_1`.
- `long_monologue` has two guards: the agent must have been the last to speak, and their last turn must not already contain a question mark. This prevents false positives when the agent is actively asking discovery questions.

---

## LLM Coaching

- **Provider**: Gemini (default) or OpenAI — selected via `LLM_PROVIDER` env var
- **Default model**: `gemini-3.1-flash-lite-preview` (overridable via `GEMINI_MODEL`)
- **Structured output**: Gemini uses `responseSchema` + `responseMimeType: "application/json"` — no parsing fragility
- **Timeout**: 10 seconds (`Promise.race`). On timeout, `SAFE_FALLBACK` is returned and displayed coaching is preserved
- **Concurrency guard**: `isLlmBusy` per connection. If a batch triggers while a call is in-flight, the batch is skipped — the silence timer catches remaining content
- **Coaching context**: The last 3 coaching notes (`recentFeedbacks`) are included in the prompt. The model synthesizes them into one directive. The last 8 transcript utterances are included as conversation context.
- **Fallback**: `SAFE_FALLBACK = { source: 'llm', feedback: '', suggested_questions: [], info_card: null }`. Empty results preserve prior coaching on screen rather than clearing it.

### Coaching intelligence (prompt behavior)

The system prompt frames the model as a live sales conversation coach. Key behaviors:

**Customer posture detection**: The model first reads the customer's current posture — closed/not persuadable, uncertain/movable, or angry/escalated — and adapts its coaching strategy accordingly.

**Objection type routing**: Price/budget → reframe toward cost of inaction and ROI. Implementation/risk concerns → surface past failures, define success criteria. Competitor comparison → uncover the real decision criterion. Trust gap → invite them to define what proof would satisfy them. Timing/urgency → distinguish genuine constraint from avoidance. Confusion/overload → stop adding information, simplify.

**Agent response quality coaching**: When the latest turn is from the agent, the model evaluates response quality against specific sales failure modes: feature-dumping without linking to customer pain, being too defensive, over-explaining, missing the real blocker, pushing when the customer is clearly closed, skipping value and going straight to price, or answering without advancing.

**Conversation stage awareness for suggested questions**: The model first determines the stage of the conversation. If the customer has not yet acknowledged the pain or cost, questions are diagnostic and discovery-focused. Once the pain is established (customer quantified cost, named figures, confirmed team impact, or showed a buying signal), questions shift to advancing commitment — proposing a pilot, asking for the decision timeline, surfacing who else needs to approve, or asking what it would take to move forward.

**Question ordering**: The first (Recommended) question is always the highest-leverage question for advancing the sale at the current stage. Questions 2–3 are alternative angles. Agent turns always return an empty question list — questions are generated after customer turns only.

**Info card**: Fires when a sales or business term appears that benefits from a quick one-line definition (ROI, TCO, SLA, ARR, MRR, POC, pilot, SOW, RFP, etc.).

### Output shape

```json
{
  "source": "llm",
  "feedback": "Acknowledge the price concern before moving to value.",
  "suggested_questions": [
    "What would make the ROI case clear for your team?",
    "What does the cost of not solving this look like over the next year?",
    "What would need to be true for you to want to start this quarter?"
  ],
  "info_card": {
    "term": "ROI",
    "note": "Return on investment — quantify value gain vs. total cost over time."
  }
}
```

`info_card` is `null` when not applicable. The full payload is only broadcast when at least one field is non-empty.

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
| `DEEPGRAM_API_KEY` | For Browser Call and Mic modes | — | Deepgram streaming STT. Absent → no transcription in either mode |
| `DEEPGRAM_MODEL` | No | `nova-3` | Deepgram STT model |

If neither `GEMINI_API_KEY` nor `OPENAI_API_KEY` is present, the backend starts in **rule-only mode** — heuristics fire normally, the LLM path is a silent no-op.

### OpenAI note

The OpenAI path is available as an experiment but is not recommended. Under real-time latency constraints it has produced unreliable structured JSON output. Gemini is the validated default.

---

## WebSocket Event Contract

All messages use the shape `{ type: string, payload: object }`. Event names live in `shared/events.js`.

| Event | Direction | Description |
|-------|-----------|-------------|
| `client:ping` | client → server | Connectivity check |
| `server:pong` | server → client | Ping reply |
| `transcript:interim` | client → server | Non-final STT chunk (not stored, not analyzed) |
| `transcript:final` | client → server | Committed utterance → triggers pipeline |
| `transcript:final` | server → client | Browser-call / demo / mic: server echoes transcribed or scripted lines |
| `audio:start` | client → server | Audio stream starting. `payload: { lang, source? }` — `source` is `'browser'` (tab) or `'mic'` |
| `audio:stop` | client → server | Audio stream ending |
| `audio:error` | server → client | Server-side audio error (e.g. Deepgram key missing). `payload: { reason }` |
| `demo:trigger` | client → server | Start scripted demo playback. `payload: { lang }` |
| `analysis:update` | server → client | Coaching payload — rule-based or LLM |

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
| Tab audio STT | Deepgram streaming (`nova-3`, `diarize=true`, `smart_format=true`, WebM/Opus) |
| Mic STT | Deepgram streaming (`nova-3`, `diarize=false`, `smart_format=true`, WebM/Opus via `useMicStream`) |
| Browser Call dual-input mic | Web Speech API (Chrome, continuous mode) |
| LLM | Google Gemini via `@google/generative-ai` |
| Audio capture | `getDisplayMedia` + `MediaRecorder` (browser-call tab audio); `getUserMedia` + `MediaRecorder` (mic mode) |

---

## Known Limitations

**Speaker diarization does not confirm role identity.** Deepgram assigns `speaker_0`/`speaker_1` labels based on voice patterns, not semantic role. There is no guarantee that `speaker_0` is consistently the customer or that speaker turns are correctly attributed in all cases. The LLM is instructed to infer role from conversation context rather than assuming identity from the label.

**Near-duplicate echo in dual-input Browser Call.** When Browser Call and mic are both active, the user's voice enters via both streams. Exact-match dedup (normalized text, 6s window) suppresses identical transcriptions. If Web Speech API and Deepgram transcribe the same audio with slightly different wording, both versions may appear.

**Transcript ordering is approximate.** Entries are sorted by the timestamp when the STT engine produced the result — not when speech started. For long utterances, Deepgram's segment timestamp may be slightly offset from speech onset.

**`over_persuading` only works in mic mode and dual-input mode.** It requires `agent`-labeled turns in the context window. In tab-only Browser Call, all speakers are diarized as `speaker_0`/`speaker_1` — the signal never fires.

**`long_monologue` requires agent to have just spoken without a question.** It does not fire during active two-sided conversation where both parties are speaking. It also does not fire if the agent's last turn contained a question mark.

**Customer Insight Mode reduces coaching depth before agent engagement.** If the agent has not spoken within the 12-second participation window, the LLM analyzes the customer turn for posture and intent but does not evaluate agent response quality. This is intentional — there is no recent agent response to evaluate.

**One signal per utterance.** Only the highest-priority signal not on cooldown fires. If a customer utterance is both emotionally escalated and contains a price objection, only `emotionally_escalated` appears.

**No session persistence.** All session state is in-memory. Restarting the backend clears all active sessions. There is no post-call analytics or history beyond the in-session export.

**No authentication or access control.** The WebSocket and HTTP endpoints are open. Any client that can reach the server can trigger the pipeline and consume API quota.

**LLM latency is visible.** Gemini responses typically take 1–3 seconds. The total coaching latency from end of customer speech to displayed coaching is approximately 2–4 seconds (silence window + LLM round trip).

**Mic mode has no interim text.** Unlike Web Speech API which shows in-progress text while speaking, Deepgram mic mode only surfaces finalized segments. Text appears in committed chunks rather than streaming character by character.

---

## Design Decisions

**Rule-based + LLM hybrid.** Heuristics give zero-latency feedback at zero API cost. The LLM handles nuance, context, and suggested questions. The two paths are fully independent — LLM latency never delays a guardrail signal.

**Agent-immediate / customer-silence trigger split.** When the agent speaks, the LLM fires immediately — the complete preceding customer block is now in context and fast feedback matters. When the customer speaks, the system accumulates fragments and waits for a natural thought boundary (terminal punctuation detection) before firing, reducing reactive coaching on partial sentences.

**Sentence-completion detection for customer silence.** With `smart_format` enabled, Deepgram adds terminal punctuation to complete sentences. A fragment ending in `.`, `?`, or `!` triggers a short silence window (1.2s). A fragment without terminal punctuation signals an ongoing thought and extends the window to 2.5s. This reduces false triggers during natural mid-sentence pauses.

**Skip-on-busy over queue.** When the LLM is in-flight and a new batch fires, the batch is skipped rather than queued. A result produced 3+ seconds after the trigger is stale for a live conversation. The silence timer fires again on subsequent activity.

**Coaching synthesis over dedup.** The backend accumulates the last 3 coaching notes and passes them to the model, which synthesizes them into a single current directive. This is more useful than simple dedup — repeated themes are recognized as resolved and the model advances to the next coaching angle.

**Honest speaker labels.** Diarized speakers are labeled `speaker_0`/`speaker_1` — not assumed to be agent or customer. The LLM prompt explicitly handles this uncertainty and instructs the model to infer posture from observable cues (who raises objections, who responds, emotional charge, turn patterns).

**Source-based transcript sides.** Transcript bubble placement (left/right) is determined by audio source, not diarized speaker index. All tab audio appears on the left; mic audio appears on the right. This is predictable and does not depend on diarization accuracy.

**Pre-warming Deepgram.** `AUDIO_START` is sent to the backend before `getDisplayMedia` opens the tab picker. The Deepgram WebSocket handshake completes during the seconds the user spends selecting a tab — the first audio chunk hits an already-open connection.

**Per-connection state.** Each WebSocket client gets its own transcript session, heuristics engine, and `isLlmBusy` flag. The LLM analyzer is shared and stateless. Multi-client support is correct by construction.
