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
import { createTwilioStreamHandler } from "./twilioStream.js";

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

// ── Twilio stream URL (required for /twiml endpoint) ────────────────
const TWILIO_STREAM_URL = process.env.TWILIO_STREAM_URL ?? "";

const app = express();
app.use(express.json());

const server = http.createServer(app);

// ── WebSocket servers (noServer — path-based routing via server upgrade) ──
// wss    → browser clients (default path)
// wssTwilio → Twilio MediaStream (/twilio-stream)
const wss = new WebSocketServer({ noServer: true });
const wssTwilio = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === "/twilio-stream") {
    wssTwilio.handleUpgrade(req, socket, head, (ws) => {
      wssTwilio.emit("connection", ws, req);
    });
  } else {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

// ── LLM analyzer (shared — stateless, safe to share across connections) ──
const llmAnalyzer = createLlmAnalyzer({
  provider:    process.env.LLM_PROVIDER,
  geminiKey:   process.env.GEMINI_API_KEY,
  openaiKey:   process.env.OPENAI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL,
  openaiModel: process.env.OPENAI_MODEL,
});
if (!llmAnalyzer) {
  console.log("[LLM] No provider configured — running in rule-only mode");
}

// ── Active call state ────────────────────────────────────────────────
// One active call per server instance. Bridges the Twilio stream to all
// connected browser clients. null when no call is in progress.
let activeCall = null;

// ── HTTP routes ───────────────────────────────────────────────────
const statusPayload = () => ({
  service: "sales-call-coach-backend",
  status: "ok",
  websocket: "ready",
  llm: llmAnalyzer ? "enabled" : "rule-only",
  clients: wss.clients.size,
  activeCall: !!activeCall,
  timestamp: Date.now(),
});

app.get("/", (_req, res) => res.json(statusPayload()));
app.get("/health", (_req, res) => res.json(statusPayload()));

// POST /twiml — returns TwiML that instructs Twilio to stream audio here.
// Twilio dials this endpoint when a call is placed to the configured number.
//
// Language selection priority:
//   1. ?lang= query param on the webhook URL  (e.g. configure Twilio as /twiml?lang=en-US)
//   2. TWILIO_CALL_LANG env var
//   3. hard default 'tr-TR'
app.post("/twiml", (req, res) => {
  if (!TWILIO_STREAM_URL) {
    console.warn("[TWIML] TWILIO_STREAM_URL not set — returning empty TwiML");
    res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Configuration error: stream URL not set.</Say>
</Response>`);
    return;
  }

  const lang = req.query.lang ?? process.env.TWILIO_CALL_LANG ?? "tr-TR";
  console.log(`[TWIML] Responding with lang:${lang}`);

  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${TWILIO_STREAM_URL}" track="inbound_track">
      <Parameter name="lang" value="${lang}" />
    </Stream>
  </Connect>
  <Pause length="60" />
</Response>`);
});

// ── Helper: safe WS send ─────────────────────────────────────────
function wsSend(ws, type, payload) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

// ── Helper: broadcast to all connected browser clients ───────────
function broadcastToBrowserClients(type, payload) {
  for (const client of wss.clients) {
    wsSend(client, type, payload);
  }
}

// ── Twilio stream handler ────────────────────────────────────────
const twilioHandler = createTwilioStreamHandler({
  apiKey: process.env.DEEPGRAM_API_KEY ?? "",

  onCallStarted({ callSid, lang }) {
    if (activeCall) {
      console.warn(
        `[CALL] Rejecting call ${callSid} — call ${activeCall.callSid} is already active`,
      );
      return false;
    }

    console.log(`[CALL] Started — sid:${callSid} lang:${lang}`);

    // Build per-call session + analysis pipeline
    const session = createTranscriptSession();
    const heuristics = createHeuristicsEngine();
    let isLlmBusy = false;
    let lastFeedback = "";

    const trigger = createAnalysisTrigger({
      batchSize: 2,
      silenceMs: 1500,

      onImmediate(sess) {
        const signal = heuristics.run({
          latest: sess.getLatest(),
          previous: sess.getPrevious(),
          contextWindow: sess.getContextWindow(),
          utteranceCount: sess.getCount(),
        });
        if (signal) {
          console.log(
            `[CALL:HEURISTIC] ${signal.tone_alert.type}`,
            signal._debug ?? "",
          );
          broadcastToBrowserClients(WS_EVENTS.ANALYSIS_UPDATE, signal);
        }
      },

      async onBatch(sess) {
        if (!llmAnalyzer) return;
        if (isLlmBusy) {
          console.log("[CALL:LLM] Skipping batch — previous call in flight");
          return;
        }
        isLlmBusy = true;
        const startMs = Date.now();
        try {
          const result = await llmAnalyzer.analyze(sess, { lastFeedback });
          const elapsed = Date.now() - startMs;
          console.log(
            `[CALL:LLM] Response in ${elapsed}ms — feedback:"${result.feedback}" questions:${result.suggested_questions.length}`,
          );
          if (result.feedback) lastFeedback = result.feedback;
          if (
            result.feedback ||
            result.suggested_questions.length > 0 ||
            result.info_card
          ) {
            broadcastToBrowserClients(WS_EVENTS.ANALYSIS_UPDATE, result);
          }
        } catch (err) {
          // Do not broadcast SAFE_FALLBACK — it would clear currently displayed coaching.
          // llmAnalyzer catches internally and returns SAFE_FALLBACK; this path is a last resort.
          console.error("[CALL:LLM] Unexpected error:", err.message);
        } finally {
          isLlmBusy = false;
        }
      },
    });

    activeCall = { callSid, lang, session, heuristics, trigger };

    broadcastToBrowserClients(WS_EVENTS.CALL_STARTED, { callSid, lang });
  },

  onTranscript({ text, lang, ts, speaker }) {
    if (!activeCall) return;

    const utterance = activeCall.session.addUtterance({
      text,
      lang,
      ts,
      speaker,
    });
    console.log(
      `[CALL:TRANSCRIPT] #${activeCall.session.getCount()} (${utterance.lang}) [${speaker}] "${utterance.text}"`,
    );

    // Mirror transcript to browser clients so the UI shows the call text
    broadcastToBrowserClients(WS_EVENTS.TRANSCRIPT_FINAL, { text, lang });

    activeCall.trigger.onFinal(activeCall.session);
  },

  onCallEnded() {
    if (!activeCall) return;
    console.log(`[CALL] Ended — sid:${activeCall.callSid}`);
    activeCall.trigger.reset();
    activeCall.heuristics.reset();
    activeCall = null;
    broadcastToBrowserClients(WS_EVENTS.CALL_ENDED, {});
  },
});

wssTwilio.on("connection", (ws) => {
  console.log("[WS:TWILIO] MediaStream connection");
  twilioHandler(ws);
});

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
    onTranscript({ text, lang }) {
      const utterance = session.addUtterance({
        text,
        lang,
        ts: Date.now(),
        speaker: "unknown",
      });
      console.log(
        `[AUDIO] #${session.getCount()} (${utterance.lang}) "${utterance.text}"`,
      );
      // Echo transcript to the frontend so the transcript panel populates
      wsSend(ws, WS_EVENTS.TRANSCRIPT_FINAL, { text, lang });
      trigger.onFinal(session);
    },
  });

  // isLlmBusy: prevents overlapping batch LLM calls on the same connection.
  // If a new batch trigger fires while a call is in-flight, it is skipped.
  // The silence-timer path in analysisTrigger will catch the trailing content.
  let isLlmBusy = false;
  // lastFeedback: passed to prompt builder to avoid repeating the same coaching note.
  let lastFeedback = "";

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
        const result = await llmAnalyzer.analyze(sess, { lastFeedback });
        const elapsed = Date.now() - startMs;
        console.log(
          `[LLM] Response in ${elapsed}ms — feedback:"${result.feedback}" questions:${result.suggested_questions.length}`,
        );

        // Track last feedback for dedup in the next prompt
        if (result.feedback) lastFeedback = result.feedback;

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
        lastFeedback = "";
        audioStream.handleStart(payload?.lang ?? "tr-TR");
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
        lastFeedback = "";
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
  console.log(
    `[SERVER] Twilio stream ready on ws://localhost:${PORT}/twilio-stream`,
  );
});
