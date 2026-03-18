/**
 * llmAnalyzer.js
 *
 * Wraps the Gemini API call for the real-time conversation coaching layer.
 * - Uses structured JSON output via responseSchema
 * - 5 s timeout via Promise.race
 * - Returns SAFE_FALLBACK on any error (timeout, parse fail, API error)
 *
 * Usage:
 *   const analyzer = createLlmAnalyzer(process.env.GEMINI_API_KEY);
 *   if (analyzer) {
 *     const result = await analyzer.analyze(session, { lastFeedback });
 *   }
 *
 * Returns null from factory if API key is absent — caller checks before using.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./promptBuilder.js";

const MODEL_NAME = "gemini-2.5-flash";
const TIMEOUT_MS = 5_000;

// ── Response schema ────────────────────────────────────────────────

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    feedback: {
      type: "string",
      description:
        "Short actionable coaching note for the speaker. Max 20 words. Empty string if nothing new to say.",
    },
    suggested_questions: {
      type: "array",
      items: { type: "string" },
      description:
        "1–3 follow-up questions the speaker should ask next, based on what the other side said.",
    },
    info_card: {
      type: "object",
      nullable: true,
      properties: {
        term: {
          type: "string",
          description: "Term or concept the other side mentioned. 1–3 words.",
        },
        note: {
          type: "string",
          description: "Brief definition or context. Max 20 words.",
        },
      },
      description:
        "Optional. Include only when the other side raises a specific term worth a quick definition. Null otherwise.",
    },
  },
  required: ["feedback", "suggested_questions", "info_card"],
};

// ── Safe fallback ──────────────────────────────────────────────────
// Returned on any error. Does not crash the app or alter UI state.

export const SAFE_FALLBACK = Object.freeze({
  source:              "llm",
  feedback:            "",
  suggested_questions: [],
  info_card:           null,
});

// ── Helpers ────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
}

/**
 * Normalize and validate the raw model response.
 */
function normalize(raw) {
  const feedback =
    typeof raw.feedback === "string" ? raw.feedback.trim() : "";

  const suggestedQuestions = Array.isArray(raw.suggested_questions)
    ? raw.suggested_questions.slice(0, 3).map(String).filter(Boolean)
    : [];

  let infoCard = null;
  if (raw.info_card && typeof raw.info_card === "object") {
    const term =
      typeof raw.info_card.term === "string" ? raw.info_card.term.trim() : "";
    const note =
      typeof raw.info_card.note === "string" ? raw.info_card.note.trim() : "";
    if (term && note) infoCard = { term, note };
  }

  return {
    source:              "llm",
    feedback,
    suggested_questions: suggestedQuestions,
    info_card:           infoCard,
  };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

// ── Factory ────────────────────────────────────────────────────────

/**
 * Returns an analyzer instance, or null if no API key.
 * @param {string | undefined} apiKey
 */
export function createLlmAnalyzer(apiKey) {
  if (!apiKey) {
    console.warn("[LLM] GEMINI_API_KEY not set — LLM analysis disabled");
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema:   RESPONSE_SCHEMA,
    },
  });

  /**
   * @param {import('./transcriptSession.js').TranscriptSession} session
   * @param {{ lastFeedback?: string }} [opts]
   * @returns {Promise<typeof SAFE_FALLBACK>}
   */
  async function analyze(session, { lastFeedback = "" } = {}) {
    if (!session.getLatest()) return SAFE_FALLBACK;

    const userPrompt = buildUserPrompt({ session, lastFeedback });

    let raw;
    try {
      const result = await withTimeout(
        model.generateContent(userPrompt),
        TIMEOUT_MS,
      );
      const text = result.response.text();
      raw = safeParseJson(text);
    } catch (err) {
      console.warn("[LLM] Call failed:", err.message);
      return SAFE_FALLBACK;
    }

    if (!raw) {
      console.warn("[LLM] Could not parse response");
      return SAFE_FALLBACK;
    }

    return normalize(raw);
  }

  return { analyze };
}
