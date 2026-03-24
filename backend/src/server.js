import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { PORT, WS_EVENTS } from "./constants.js";
import { createTranscriptSession } from "./transcriptSession.js";
import { createHeuristicsEngine } from "./heuristics.js";
import { createAnalysisTrigger } from "./analysisTrigger.js";
import { createLlmAnalyzer, SAFE_FALLBACK } from "./llmAnalyzer.js";
import { createAudioStreamHandler } from "./audioStream.js";

// ── Meaningful agent turn filter ─────────────────────────────────────
// Used by the Browser Call participation gate.
// Returns true only when the local mic turn is substantive enough to indicate
// the coached user is actively participating — not just backchannelling.
//
// Rules (both must pass):
//   1. Word count >= MIN_AGENT_WORDS
//   2. Normalised text is NOT in the backchannel set
//
// This is intentionally simple and fast — no NLP, no extra LLM call.

const MIN_AGENT_WORDS = 3;

const BACKCHANNEL_PHRASES = new Set([
  // ── Turkish single-word ──────────────────────────────
  'anlıyorum', 'anladım', 'evet', 'hayır', 'tamam', 'tabii', 'tabiki',
  'tabi', 'hıhı', 'hmm', 'hm', 'ee', 'aa', 'oh', 'okey', 'ok',
  'peki', 'haklısınız', 'doğru', 'kesinlikle', 'biliyorum', 'biliyoruz',
  // ── Turkish multi-word acknowledgement combos ────────
  'hı hı', 'evet evet', 'evet tamam', 'evet anlıyorum', 'evet anladım',
  'tamam tamam', 'tamam anladım', 'tamam anlıyorum', 'tamam peki',
  'anladım evet', 'anladım tamam', 'anlıyorum evet', 'anlıyorum tamam',
  'tabii tabii', 'tabii ki', 'tabii evet', 'evet tabii', 'evet kesinlikle',
  'doğru doğru', 'doğru tabii', 'haklısınız evet', 'evet haklısınız',
  // ── English single-word ──────────────────────────────
  'okay', 'yes', 'no', 'sure', 'right', 'understood', 'indeed',
  'mm', 'yep', 'yup', 'cool', 'absolutely', 'exactly',
  'uh huh', 'uh-huh',
  // ── English multi-word acknowledgement combos ────────
  'got it', 'i see', 'of course', 'alright then', 'okay sure',
  'yes sure', 'yes of course', 'yes absolutely', 'yes exactly',
  'right okay', 'right sure', 'sure okay', 'sure yes',
  'okay i see', 'okay got it', 'i see okay', 'i understand',
  'i understand yes', 'yes i see', 'yes i understand',
  'that makes sense', 'makes sense', 'noted', 'noted okay',
]);

function isMeaningfulAgentTurn(text) {
  const normalized = text.trim().toLowerCase().replace(/[.,!?!…]+$/, '').trim();
  if (BACKCHANNEL_PHRASES.has(normalized)) return false;
  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  return wordCount >= MIN_AGENT_WORDS;
}

// ── Demo scripts ─────────────────────────────────────────────────────
// Scripted utterances replayed through the real pipeline on demo:trigger.
// Goes through the same heuristics + LLM path as live speech — not mocked.
// Selected by the lang field in the demo:trigger payload.

const DEMO_SCRIPT_TR = [
  {
    text: "Teklifi inceledim ancak fiyat beklentilerimizin oldukça üzerinde, bu konuda esnek olabilir misiniz?",
    lang: "tr-TR",
    delayMs: 800,
  },
  {
    text: "Rakipleriniz çok daha uygun fiyatlarla benzer özellikler sunuyor, farkı nasıl açıklarsınız?",
    lang: "tr-TR",
    delayMs: 3200,
  },
  {
    text: "Özellikle ROI konusunda net bir şey göremiyorum, yatırımın geri dönüşünü nasıl ölçeceğiz?",
    lang: "tr-TR",
    delayMs: 6000,
  },
  {
    text: "Karar vermek için biraz erken, ekibimizle görüşmemiz gerekiyor.",
    lang: "tr-TR",
    delayMs: 9000,
  },
  {
    text: "Peki SLA garantileriniz ve destek kapsamı neler?",
    lang: "tr-TR",
    delayMs: 11500,
  },
];

const DEMO_SCRIPT_EN = [
  {
    text: "I reviewed the proposal but honestly the price point is well above what we were expecting.",
    lang: "en-US",
    delayMs: 800,
  },
  {
    text: "Your competitors are offering similar features at a much lower cost — how do you justify the difference?",
    lang: "en-US",
    delayMs: 3200,
  },
  {
    text: "I'm also not seeing a clear ROI case here — how exactly would we measure the return on this?",
    lang: "en-US",
    delayMs: 6000,
  },
  {
    text: "I think it's a bit early to commit — we need to run this by the team first.",
    lang: "en-US",
    delayMs: 9000,
  },
  {
    text: "What are your SLA guarantees and what does the support package actually cover?",
    lang: "en-US",
    delayMs: 11500,
  },
];

const DEMO_SCRIPTS = { "tr-TR": DEMO_SCRIPT_TR, "en-US": DEMO_SCRIPT_EN };

const app = express();
app.use(express.json());

const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ── LLM analyzer (shared — stateless, safe to share across connections) ──
const llmAnalyzer = createLlmAnalyzer({
  geminiKey:   process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL,
});
if (!llmAnalyzer) {
  console.log("[LLM] No provider configured — running in rule-only mode");
}

// ── HTTP routes ───────────────────────────────────────────────────
const statusPayload = () => ({
  service: "sales-call-coach-backend",
  status: "ok",
  websocket: "ready",
  llm: llmAnalyzer ? "enabled" : "rule-only",
  clients: wss.clients.size,
  timestamp: Date.now(),
});

app.get("/", (_req, res) => res.json(statusPayload()));
app.get("/health", (_req, res) => res.json(statusPayload()));

// ── Helper: safe WS send ─────────────────────────────────────────
function wsSend(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// ── Browser WebSocket connections ────────────────────────────────
wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  // Per-connection state
  const session = createTranscriptSession();
  const heuristics = createHeuristicsEngine();

  // Browser-call audio stream handler (browser-call mode)
  const audioStream = createAudioStreamHandler({
    apiKey: process.env.DEEPGRAM_API_KEY ?? "",
    onError(reason) {
      wsSend(ws, WS_EVENTS.AUDIO_ERROR, { reason });
    },
    onTranscript({ text, lang, speaker }) {
      const utterance = session.addUtterance({
        text,
        lang,
        ts: Date.now(),
        speaker: speaker ?? "unknown",
      });
      console.log(
        `[AUDIO] #${session.getCount()} (${utterance.lang}) [${utterance.speaker}] "${utterance.text}"`,
      );
      // Echo transcript to the frontend — include speaker and ts so UI can render and order correctly
      wsSend(ws, WS_EVENTS.TRANSCRIPT_FINAL, {
        text,
        lang,
        speaker: utterance.speaker,
        ts: utterance.ts,
      });
      trigger.onFinal(session);
    },
  });

  // isLlmBusy: prevents overlapping batch LLM calls on the same connection.
  // If a new batch trigger fires while a call is in-flight, it is skipped.
  // The silence-timer path in analysisTrigger will catch the trailing content.
  let isLlmBusy = false;
  // recentFeedbacks: last 3 coaching notes passed to the prompt for synthesis.
  // The model synthesizes them into one coherent directive instead of repeating.
  let recentFeedbacks = [];
  // lastAgentTurnTs: timestamp of the most recent local-mic turn (speaker='agent').
  // Active Coaching Mode is allowed only within ACTIVE_WINDOW_MS of the last agent turn.
  // Beyond that window the session reverts to Observer Mode automatically.
  const ACTIVE_WINDOW_MS = 12_000; // 12s — gives room for longer customer responses after agent speaks
  let lastAgentTurnTs = 0;

  // Demo playback timers — cleared on reset so a second demo:trigger is clean
  const demoTimers = [];

  const trigger = createAnalysisTrigger({
    silenceMs:         1_500, // agent-side fallback (agent turns fire immediately now)
    customerSilenceMs: 1_200, // customer-side: fire 1.2s after customer stops — targets 2–3s total coaching latency
    // ── Immediate path: heuristics ────────────────────────
    onImmediate(sess) {
      const signal = heuristics.run({
        latest: sess.getLatest(),
        previous: sess.getPrevious(),
        contextWindow: sess.getContextWindow(),
        utteranceCount: sess.getCount(),
      });

      if (signal) {
        console.log(
          `[HEURISTIC] ${signal.tone_alert.type}`,
          signal._debug ?? "",
        );
        wsSend(ws, WS_EVENTS.ANALYSIS_UPDATE, signal);
      }
    },

    // ── Batched path: LLM ────────────────────────────────
    async onBatch(sess) {
      if (!llmAnalyzer) {
        // No API key — stay silent, rule-based path is sufficient
        return;
      }

      // Coaching mode: when Browser Call is active, switch between Customer Insight
      // and Full Coaching based on whether the agent has spoken recently.
      // Customer Insight = agent not yet in window → LLM still runs but won't evaluate agent response quality.
      // Full Coaching    = agent spoke within ACTIVE_WINDOW_MS → full turn-aware analysis.
      // In mic/demo mode audioStream.isActive() is false → always Full Coaching.
      const coachingMode =
        audioStream.isActive() && Date.now() - lastAgentTurnTs > ACTIVE_WINDOW_MS
          ? "customer_insight"
          : "full";

      if (isLlmBusy) {
        console.log("[LLM] Skipping batch — previous call in flight");
        return;
      }

      isLlmBusy = true;
      const startMs = Date.now();

      try {
        const result = await llmAnalyzer.analyze(sess, { recentFeedbacks, coachingMode });
        const elapsed = Date.now() - startMs;
        console.log(
          `[LLM] mode:${coachingMode} response in ${elapsed}ms — feedback:"${result.feedback}" questions:${result.suggested_questions.length}`,
        );

        // Keep last 3 feedbacks for synthesis — enough context for the model to
        // detect repetition without carrying stale themes from early in the call.
        if (result.feedback) recentFeedbacks = [...recentFeedbacks, result.feedback].slice(-3);

        // Only send if there is something meaningful to show
        if (
          result.feedback ||
          result.suggested_questions.length > 0 ||
          result.info_card
        ) {
          wsSend(ws, WS_EVENTS.ANALYSIS_UPDATE, result);
        }
      } catch (err) {
        // Do not broadcast SAFE_FALLBACK — it would clear currently displayed coaching.
        // llmAnalyzer catches internally and returns SAFE_FALLBACK; this path is a last resort.
        console.error("[LLM] Unexpected error:", err.message);
      } finally {
        isLlmBusy = false;
      }
    },
  });

  // ── Demo playback helper ──────────────────────────────────────────
  function runDemo(lang) {
    for (const t of demoTimers) clearTimeout(t);
    demoTimers.length = 0;

    const script = DEMO_SCRIPTS[lang] ?? DEMO_SCRIPT_TR;
    for (const line of script) {
      const t = setTimeout(() => {
        if (ws.readyState !== ws.OPEN) return;
        const utterance = session.addUtterance({
          text: line.text,
          lang: line.lang,
          ts: Date.now(),
          speaker: "customer", // demo script = customer voice
        });
        console.log(`[DEMO] #${session.getCount()} "${utterance.text}"`);
        // Mirror to frontend transcript so the UI shows the scripted text
        wsSend(ws, WS_EVENTS.TRANSCRIPT_FINAL, {
          text: line.text,
          lang: line.lang,
          speaker: utterance.speaker,
          ts: utterance.ts,
        });
        trigger.onFinal(session);
      }, line.delayMs);
      demoTimers.push(t);
    }
  }

  // ── Message router ───────────────────────────────────────
  ws.on("message", (raw, isBinary) => {
    // Binary frames are audio chunks from browser-call mode
    if (isBinary) {
      audioStream.handleChunk(raw);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn("[WS] Non-JSON message, ignoring");
      return;
    }

    const { type, payload } = msg;

    switch (type) {
      case WS_EVENTS.CLIENT_PING:
        wsSend(ws, WS_EVENTS.SERVER_PONG, { ts: Date.now() });
        break;

      case WS_EVENTS.TRANSCRIPT_INTERIM:
        // Not stored — transient, not analyzed
        break;

      case WS_EVENTS.TRANSCRIPT_FINAL: {
        if (!payload?.text?.trim()) break;

        // Local mic turns refresh the participation window only when substantive.
        // Backchannels and very short phrases are ignored to prevent false activation.
        if (payload.speaker === "agent" && isMeaningfulAgentTurn(payload.text ?? "")) {
          lastAgentTurnTs = Date.now();
        }

        const utterance = session.addUtterance(payload);
        console.log(
          `[TRANSCRIPT:FINAL] #${session.getCount()} (${utterance.lang}) "${utterance.text}"`,
        );

        trigger.onFinal(session);
        break;
      }

      case WS_EVENTS.AUDIO_START: {
        // Reset session for new browser-call, then start STT stream
        session.reset();
        trigger.reset();
        heuristics.reset();
        isLlmBusy = false;
        recentFeedbacks = [];
        lastAgentTurnTs = 0; // new session — participation window reset
        audioStream.handleStart(payload?.lang ?? "tr-TR", payload?.source ?? "browser");
        break;
      }

      case WS_EVENTS.AUDIO_STOP:
        audioStream.handleStop();
        break;

      case WS_EVENTS.DEMO_TRIGGER:
        // Stop any active audio stream before starting demo
        audioStream.handleStop();
        // Clear any in-flight demo timers, reset all state
        for (const t of demoTimers) clearTimeout(t);
        demoTimers.length = 0;
        session.reset();
        trigger.reset();
        heuristics.reset();
        isLlmBusy = false;
        recentFeedbacks = [];
        console.log(
          `[DEMO] Starting demo playback (${payload?.lang ?? "tr-TR"})`,
        );
        runDemo(payload?.lang ?? "tr-TR");
        break;

      default:
        console.warn("[WS] Unknown event type:", type);
    }
  });

  ws.on("close", () => {
    for (const t of demoTimers) clearTimeout(t);
    audioStream.handleStop();
    trigger.reset();
    heuristics.reset();
    console.log("[WS] Client disconnected");
  });

  ws.on("error", (err) => {
    console.error("[WS] Error:", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] Running on http://localhost:${PORT}`);
  console.log(`[SERVER] WebSocket ready on ws://localhost:${PORT}`);
});
