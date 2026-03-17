import "dotenv/config";
import express from "express";
import http from "http";
import { WebSocketServer } from "ws";
import { PORT, WS_EVENTS } from "./constants.js";
import { createTranscriptSession } from "./transcriptSession.js";
import { createHeuristicsEngine } from "./heuristics.js";
import { createAnalysisTrigger } from "./analysisTrigger.js";
import { createLlmAnalyzer, SAFE_FALLBACK } from "./llmAnalyzer.js";

// ── Demo scripts ─────────────────────────────────────────────────────
// Scripted utterances replayed through the real pipeline on demo:trigger.
// Goes through the same heuristics + LLM path as live speech — not mocked.
// Selected by the lang field in the demo:trigger payload.

const DEMO_SCRIPT_TR = [
  {
    text: "Merhaba, geçen hafta gönderdiğiniz teklifi inceledim.",
    lang: "tr-TR",
    delayMs: 800,
  },
  {
    text: "Ürününüz ilgimi çekiyor ama fiyatı beklediğimizden oldukça yüksek.",
    lang: "tr-TR",
    delayMs: 2600,
  },
  {
    text: "Rakiplerinize kıyasla bu fiyat farkını nasıl açıklıyorsunuz?",
    lang: "tr-TR",
    delayMs: 4800,
  },
  {
    text: "Kurulum ve entegrasyon süreci için ek bir maliyet var mı?",
    lang: "tr-TR",
    delayMs: 7200,
  },
  {
    text: "Yıllık lisans yerine aylık ödeme seçeneği sunuyor musunuz?",
    lang: "tr-TR",
    delayMs: 9800,
  },
];

const DEMO_SCRIPT_EN = [
  {
    text: "Hi, I had a chance to review the proposal you sent over last week.",
    lang: "en-US",
    delayMs: 800,
  },
  {
    text: "The product looks interesting but honestly the price is higher than what we budgeted for.",
    lang: "en-US",
    delayMs: 2600,
  },
  {
    text: "How do you justify the cost compared to your competitors in this space?",
    lang: "en-US",
    delayMs: 4800,
  },
  {
    text: "Are there any additional fees for implementation and onboarding?",
    lang: "en-US",
    delayMs: 7200,
  },
  {
    text: "Do you offer a monthly payment option instead of an annual contract?",
    lang: "en-US",
    delayMs: 9800,
  },
];

const DEMO_SCRIPTS = { "tr-TR": DEMO_SCRIPT_TR, "en-US": DEMO_SCRIPT_EN };

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── LLM analyzer (shared — stateless, safe to share across connections) ──
const llmAnalyzer = createLlmAnalyzer(process.env.GEMINI_API_KEY);
if (llmAnalyzer) {
  console.log("[LLM] Gemini analyzer ready");
} else {
  console.log("[LLM] No API key — running in rule-only mode");
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

wss.on("connection", (ws) => {
  console.log("[WS] Client connected");

  // Per-connection state
  const session = createTranscriptSession();
  const heuristics = createHeuristicsEngine();

  // isLlmBusy: prevents overlapping batch LLM calls on the same connection.
  // If a new batch trigger fires while a call is in-flight, it is skipped.
  // The silence-timer path in analysisTrigger will catch the trailing content.
  let isLlmBusy = false;

  // Track recent signal tags to give the LLM dedup context
  let lastSignalTags = [];

  // Demo playback timers — cleared on reset so a second demo:trigger is clean
  const demoTimers = [];

  const trigger = createAnalysisTrigger({
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
        lastSignalTags = [signal.tone_alert.type];
        wsSend(ws, WS_EVENTS.ANALYSIS_UPDATE, signal);
      }
    },

    // ── Batched path: LLM ────────────────────────────────
    async onBatch(sess) {
      if (!llmAnalyzer) {
        // No API key — stay silent, rule-based path is sufficient
        return;
      }

      if (isLlmBusy) {
        console.log("[LLM] Skipping batch — previous call in flight");
        return;
      }

      isLlmBusy = true;
      const startMs = Date.now();

      try {
        const result = await llmAnalyzer.analyze(sess, lastSignalTags);
        const elapsed = Date.now() - startMs;
        console.log(
          `[LLM] Response in ${elapsed}ms — priority:${result.priority} tags:[${result.reason_tags.join(",")}]`,
        );

        // Update dedup context for next LLM call
        if (result.reason_tags.length > 0) {
          lastSignalTags = result.reason_tags;
        }

        // Only send if there is something meaningful to show
        if (
          result.coach_message ||
          result.suggested_questions.length > 0 ||
          result.info_card
        ) {
          wsSend(ws, WS_EVENTS.ANALYSIS_UPDATE, result);
        }
      } catch (err) {
        // Should not reach here (llmAnalyzer catches internally), but just in case
        console.error("[LLM] Unexpected error:", err.message);
        wsSend(ws, WS_EVENTS.ANALYSIS_UPDATE, SAFE_FALLBACK);
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
        });
        console.log(`[DEMO] #${session.getCount()} "${utterance.text}"`);
        // Mirror to frontend transcript so the UI shows the scripted text
        wsSend(ws, WS_EVENTS.TRANSCRIPT_FINAL, {
          text: line.text,
          lang: line.lang,
        });
        trigger.onFinal(session);
      }, line.delayMs);
      demoTimers.push(t);
    }
  }

  // ── Message router ───────────────────────────────────────
  ws.on("message", (raw) => {
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

        const utterance = session.addUtterance(payload);
        console.log(
          `[TRANSCRIPT:FINAL] #${session.getCount()} (${utterance.lang}) "${utterance.text}"`,
        );

        trigger.onFinal(session);
        break;
      }

      case WS_EVENTS.DEMO_TRIGGER:
        // Clear any in-flight demo timers, reset all state
        for (const t of demoTimers) clearTimeout(t);
        demoTimers.length = 0;
        session.reset();
        trigger.reset();
        heuristics.reset();
        lastSignalTags = [];
        isLlmBusy = false;
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
