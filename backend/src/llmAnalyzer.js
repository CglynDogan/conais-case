/**
 * llmAnalyzer.js
 *
 * Provider-agnostic coaching analysis layer.
 * Supports Gemini and OpenAI via LLM_PROVIDER env var.
 *
 * Output contract (unchanged):
 *   { source: 'llm', feedback, suggested_questions, info_card }
 *
 * Provider selection:
 *   LLM_PROVIDER=gemini  (default) — requires GEMINI_API_KEY
 *   LLM_PROVIDER=openai            — requires OPENAI_API_KEY
 *
 * Usage:
 *   const analyzer = createLlmAnalyzer({ provider, geminiKey, openaiKey, ... });
 *   if (analyzer) {
 *     const result = await analyzer.analyze(session, { lastFeedback });
 *   }
 *
 * Returns null from factory if the selected provider has no API key.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import OpenAI from "openai";
import { SYSTEM_PROMPT, buildUserPrompt } from "./promptBuilder.js";

const TIMEOUT_MS = 10_000;

const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite-preview";
const DEFAULT_OPENAI_MODEL = "gpt-5-nano";

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

// ── OpenAI provider ────────────────────────────────────────────────

function createOpenAiAnalyzer(apiKey, modelName) {
  const client = new OpenAI({ apiKey });

  async function analyze(session, { recentFeedbacks = [], coachingMode = "full" } = {}) {
    if (!session.getLatest()) return SAFE_FALLBACK;

    const userPrompt = buildUserPrompt({ session, recentFeedbacks, coachingMode });

    let raw;
    let finishReason = "";
    try {
      const completion = await withTimeout(
        client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          max_completion_tokens: 300, // cap output — schema fits in ~180 tokens; prevents padding
          // temperature omitted — gpt-5-nano only supports the default value (1)
        }),
        TIMEOUT_MS,
      );
      const choice = completion.choices[0];
      finishReason = choice?.finish_reason ?? "";
      const msg = choice?.message;

      // Extract text content from all known response shapes:
      //   1. string  — standard json_object mode (most models)
      //   2. array   — content-block format used by some newer OpenAI models
      //   3. null    — model refused or was filtered (refusal field has reason)
      const rawContent = msg?.content;
      let contentStr = "";
      if (typeof rawContent === "string") {
        contentStr = rawContent;
      } else if (Array.isArray(rawContent)) {
        // Find the first text block in a content-part array
        const textPart = rawContent.find((b) => b?.type === "text");
        contentStr =
          textPart?.text ??
          rawContent
            .map((b) => b?.text ?? "")
            .filter(Boolean)
            .join("");
      }

      console.log(
        `[LLM] OpenAI message — finish_reason:${finishReason} content-shape:${Array.isArray(rawContent) ? "array(" + rawContent.length + ")" : typeof rawContent} extracted-len:${contentStr.length}`,
      );
      if (!contentStr && msg?.refusal) {
        console.warn("[LLM] OpenAI refusal:", msg.refusal);
      }

      raw = safeParseJson(contentStr);
    } catch (err) {
      console.warn("[LLM] OpenAI call failed:", err.message);
      return SAFE_FALLBACK;
    }

    if (!raw) {
      console.warn(
        `[LLM] Could not parse OpenAI response — finish_reason:${finishReason}`,
      );
      return SAFE_FALLBACK;
    }

    return normalize(raw);
  }

  return { analyze };
}

// ── Public factory ─────────────────────────────────────────────────

/**
 * @param {{
 *   provider?:    string,   // 'gemini' (default) | 'openai'
 *   geminiKey?:   string,
 *   openaiKey?:   string,
 *   geminiModel?: string,
 *   openaiModel?: string,
 * }} opts
 * @returns {{ analyze: Function } | null}
 */
export function createLlmAnalyzer({
  provider = "gemini",
  geminiKey,
  openaiKey,
  geminiModel,
  openaiModel,
} = {}) {
  if (provider === "openai") {
    if (!openaiKey) {
      console.warn(
        "[LLM] LLM_PROVIDER=openai but OPENAI_API_KEY not set — LLM disabled",
      );
      return null;
    }
    const model = openaiModel ?? DEFAULT_OPENAI_MODEL;
    console.log(`[LLM] OpenAI provider ready — model:${model}`);
    return createOpenAiAnalyzer(openaiKey, model);
  }

  // Default: gemini
  if (!geminiKey) {
    console.warn("[LLM] GEMINI_API_KEY not set — LLM analysis disabled");
    return null;
  }
  const model = geminiModel ?? DEFAULT_GEMINI_MODEL;
  console.log(`[LLM] Gemini provider ready — model:${model}`);
  return createGeminiAnalyzer(geminiKey, model);
}
