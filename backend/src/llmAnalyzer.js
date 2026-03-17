/**
 * llmAnalyzer.js
 *
 * Wraps the Gemini API call for the intake intelligence layer.
 * - Uses structured JSON output via responseSchema
 * - 5 s timeout via Promise.race
 * - Returns SAFE_FALLBACK on any error (timeout, parse fail, API error)
 *
 * Usage:
 *   const analyzer = createLlmAnalyzer(process.env.GEMINI_API_KEY);
 *   if (analyzer) {
 *     const result = await analyzer.analyze(session, conversationState);
 *   }
 *
 * Returns null from factory if API key is absent — caller checks before using.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./promptBuilder.js";
import {
  INTAKE_FIELDS,
  STATUS_RANK,
  initialFieldStatus,
} from "./intakeSchema.js";

const MODEL_NAME = "gemini-2.5-flash";
const TIMEOUT_MS = 5_000;

// Valid customer signal vocabulary — constrained to prevent model drift
const VALID_SIGNALS = new Set([
  "price_sensitive",
  "urgent",
  "hesitant",
  "comparing_options",
  "decision_maker_unknown",
  "first_time_researcher",
  "unclear_eligibility",
  "not_ready_to_commit",
  "high_intent",
  "needs_approval",
  "unclear_timeline",
  "open_to_guidance",
]);

// Valid field statuses
const VALID_STATUSES = new Set(Object.keys(STATUS_RANK));

// ── Response schema ───────────────────────────────────────────────
// field_status is a flat object with one property per intake field.
// Each property is an enum of the four status values.

const fieldStatusProperties = Object.fromEntries(
  INTAKE_FIELDS.map((f) => [
    f,
    { type: "string", enum: ["answered", "partial", "missing", "unknown"] },
  ]),
);

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    customer_signals: {
      type: "array",
      items: { type: "string" },
      description: "Detected customer signals from the constrained vocabulary.",
    },
    field_status: {
      type: "object",
      properties: fieldStatusProperties,
      description:
        "Current status of each intake field based on the conversation so far.",
    },
    next_questions: {
      type: "array",
      items: { type: "string" },
      description:
        "1–3 questions the intake agent should ask next to close missing or partial fields.",
    },
    whisper_note: {
      type: "string",
      description: "Short actionable note for the intake agent. Max 15 words.",
    },
  },
  required: [
    "customer_signals",
    "field_status",
    "next_questions",
    "whisper_note",
  ],
};

// ── Safe fallback ─────────────────────────────────────────────────
// Returned on any error. All field statuses default to 'unknown' (not 'missing').
// Does not crash the app or alter accumulated conversation state.

export const SAFE_FALLBACK = Object.freeze({
  source: "llm",
  customer_signals: [],
  field_status: Object.freeze(initialFieldStatus()),
  next_questions: [],
  whisper_note: "",
});

// ── Helpers ───────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`LLM timeout after ${ms}ms`)), ms),
  );
  return Promise.race([promise, timer]);
}

/**
 * Normalize and validate the raw model response.
 * Conservative by design:
 * - unknown signals are dropped (not coerced)
 * - unknown field names are dropped
 * - invalid status values fall back to 'unknown'
 */
function normalize(raw) {
  // customer_signals: filter to known vocabulary only
  const customerSignals = Array.isArray(raw.customer_signals)
    ? raw.customer_signals.map(String).filter((s) => VALID_SIGNALS.has(s))
    : [];

  // field_status: validate each field and each status value
  const rawFieldStatus =
    raw.field_status && typeof raw.field_status === "object"
      ? raw.field_status
      : {};
  const fieldStatus = Object.fromEntries(
    INTAKE_FIELDS.map((f) => {
      const v = rawFieldStatus[f];
      return [f, VALID_STATUSES.has(v) ? v : "unknown"];
    }),
  );

  // next_questions: cap at 3, coerce to string, drop blanks
  const nextQuestions = Array.isArray(raw.next_questions)
    ? raw.next_questions.slice(0, 3).map(String).filter(Boolean)
    : [];

  // whisper_note: trim, empty string if missing
  const whisperNote =
    typeof raw.whisper_note === "string" ? raw.whisper_note.trim() : "";

  return {
    source: "llm",
    customer_signals: customerSignals,
    field_status: fieldStatus,
    next_questions: nextQuestions,
    whisper_note: whisperNote,
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
   * @param {import('./transcriptSession.js').ConversationState} conversationState
   * @returns {Promise<typeof SAFE_FALLBACK>}
   */
  async function analyze(session, conversationState) {
    if (!session.getLatest()) return SAFE_FALLBACK;

    const userPrompt = buildUserPrompt({ session, conversationState });

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
