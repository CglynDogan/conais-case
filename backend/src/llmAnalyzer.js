/**
 * llmAnalyzer.js
 *
 * Wraps the Gemini API call.
 * - Uses structured JSON output via responseSchema
 * - 5 s timeout via Promise.race
 * - Returns SAFE_FALLBACK on any error (timeout, parse fail, API error)
 *
 * Usage:
 *   const analyzer = createLlmAnalyzer(process.env.GEMINI_API_KEY);
 *   if (analyzer) {
 *     const result = await analyzer.analyze(session, lastSignalTags);
 *   }
 *
 * Returns null from factory if API key is absent — caller checks before using.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./promptBuilder.js";

const MODEL_NAME = "gemini-2.5-flash";
const TIMEOUT_MS = 5_000;

// ── Response schema ───────────────────────────────────────────────
// Enforces structured JSON output from the model.
// info_card is nullable — handle absent/null in normalization.

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    coach_message: {
      type: "string",
      description:
        "Short coaching message, under 10 words. Empty string if nothing notable.",
    },
    suggested_questions: {
      type: "array",
      items: { type: "string" },
      description:
        "At most 2 practical follow-up questions for the sales rep to ask.",
    },
    info_card: {
      type: "object",
      nullable: true,
      description:
        "Only when a specific term genuinely needs clarification. Null otherwise.",
      properties: {
        term: { type: "string" },
        note: { type: "string", description: "One sentence max." },
      },
    },
    priority: {
      type: "string",
      enum: ["low", "medium", "high"],
      description:
        "high = price objection or off-topic, medium = suggestions available, low = nothing notable",
    },
    reason_tags: {
      type: "array",
      items: { type: "string" },
      description:
        'Short machine-friendly tags, e.g. ["price_objection"], ["off_topic"].',
    },
  },
  required: ["coach_message", "suggested_questions", "priority", "reason_tags"],
};

// ── Safe fallback ─────────────────────────────────────────────────
// Returned on any error. Does not crash the app or change rule-based state.

export const SAFE_FALLBACK = Object.freeze({
  source: "llm",
  priority: "low",
  coach_message: "",
  suggested_questions: [],
  info_card: null,
  reason_tags: [],
});

// ── Helpers ───────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
}

function normalize(raw) {
  // Guarantee the shape regardless of what the model returned
  const infoCard =
    raw.info_card?.term && raw.info_card?.note
      ? {
          term: String(raw.info_card.term).trim(),
          note: String(raw.info_card.note).trim(),
        }
      : null;

  return {
    source: "llm",
    priority: ["low", "medium", "high"].includes(raw.priority)
      ? raw.priority
      : "low",
    coach_message:
      typeof raw.coach_message === "string" ? raw.coach_message.trim() : "",
    suggested_questions: Array.isArray(raw.suggested_questions)
      ? raw.suggested_questions.slice(0, 2).map(String).filter(Boolean)
      : [],
    info_card: infoCard,
    reason_tags: Array.isArray(raw.reason_tags)
      ? raw.reason_tags.map(String).filter(Boolean)
      : [],
  };
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Try to extract a JSON object if the model leaked surrounding text
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    return null;
  }
}

// ── Factory ───────────────────────────────────────────────────────

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
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  /**
   * @param {import('./transcriptSession.js').TranscriptSession} session
   * @param {string[]} lastSignalTags
   * @returns {Promise<typeof SAFE_FALLBACK>}
   */
  async function analyze(session, lastSignalTags = []) {
    if (!session.getLatest()) return SAFE_FALLBACK;

    const userPrompt = buildUserPrompt({ session, lastSignalTags });

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
