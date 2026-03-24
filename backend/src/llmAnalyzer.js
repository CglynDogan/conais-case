/**
 * llmAnalyzer.js
 *
 * Gemini-powered coaching analysis layer.
 *
 * Output contract:
 *   { source: 'llm', feedback, suggested_questions, info_card }
 *
 * Usage:
 *   const analyzer = createLlmAnalyzer({ geminiKey, geminiModel });
 *   if (analyzer) {
 *     const result = await analyzer.analyze(session, { recentFeedbacks, coachingMode });
 *   }
 *
 * Returns null from factory if GEMINI_API_KEY is not set.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./promptBuilder.js";

const TIMEOUT_MS = 10_000;

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite-preview";

// ── Response schema (Gemini structured output) ─────────────────────

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

export const SAFE_FALLBACK = Object.freeze({
  source: "llm",
  feedback: "",
  suggested_questions: [],
  info_card: null,
});

// ── Shared utilities ───────────────────────────────────────────────

function withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
}

function normalize(raw) {
  const feedback = typeof raw.feedback === "string" ? raw.feedback.trim() : "";

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
    source: "llm",
    feedback,
    suggested_questions: suggestedQuestions,
    info_card: infoCard,
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

// ── Gemini provider ────────────────────────────────────────────────

function createGeminiAnalyzer(apiKey, modelName) {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  async function analyze(session, { recentFeedbacks = [], coachingMode = "full" } = {}) {
    if (!session.getLatest()) return SAFE_FALLBACK;

    const userPrompt = buildUserPrompt({ session, recentFeedbacks, coachingMode });

    let raw;
    try {
      const result = await withTimeout(
        model.generateContent(userPrompt),
        TIMEOUT_MS,
      );
      raw = safeParseJson(result.response.text());
    } catch (err) {
      console.warn("[LLM] Gemini call failed:", err.message);
      return SAFE_FALLBACK;
    }

    if (!raw) {
      console.warn("[LLM] Could not parse Gemini response");
      return SAFE_FALLBACK;
    }

    return normalize(raw);
  }

  return { analyze };
}

// ── Public factory ─────────────────────────────────────────────────

/**
 * @param {{
 *   geminiKey?:   string,
 *   geminiModel?: string,
 * }} opts
 * @returns {{ analyze: Function } | null}
 */
export function createLlmAnalyzer({ geminiKey, geminiModel } = {}) {
  if (!geminiKey) {
    console.warn("[LLM] GEMINI_API_KEY not set — LLM analysis disabled");
    return null;
  }
  const model = geminiModel ?? DEFAULT_GEMINI_MODEL;
  console.log(`[LLM] Gemini provider ready — model:${model}`);
  return createGeminiAnalyzer(geminiKey, model);
}
