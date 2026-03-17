/**
 * promptBuilder.js
 *
 * Builds the system + user prompt sent to the LLM.
 * Kept compact: coach + suggestions + info_card in one call.
 *
 * The system prompt instructs the model to return JSON only,
 * short overlay-friendly messages, and at most 2 follow-up questions.
 */

// Number of recent utterances included as context (excludes the latest).
// Balances cost, latency, and relevance.
const CONTEXT_UTTERANCES = 6;

// ── System prompt ─────────────────────────────────────────────────
// Kept short so the model spends tokens on output, not instructions.

export const SYSTEM_PROMPT = `You are a real-time sales call coach helping a sales rep during a live call.
Return only valid JSON matching the provided schema.
Keep all text short and overlay-friendly. Do not explain. Do not use markdown.

LANGUAGE: Always respond in the same language as the LANGUAGE field (Turkish for tr-TR, English for en-US).

RULES:
- Focus on the LATEST utterance; use RECENT_CONTEXT only for background.
- coach_message: one practical, specific action for the rep. Under 10 words. Empty string if nothing notable.
- suggested_questions: at most 2 questions the rep should ask the prospect next. Make them natural and specific to the conversation — not generic. Empty array if nothing useful.
- info_card: include when a pricing model, contract term, technical concept, or product category appears that the rep would benefit from a quick definition of (e.g. SLA, ROI, API, proof of concept, perpetual license, NPS). Null if no such term is present.
- reason_tags: add "price_objection" if pricing, budget, or cost concern appears. Add "off_topic" if conversation drifts. Other short tags are fine.
- priority: "high" for price objection or off-topic, "medium" if useful questions or suggestions exist, "low" if nothing notable.
- If RECENT_SIGNALS lists a tag, avoid repeating the same coaching message — offer a different angle or return low-priority empty response.
- If nothing notable is happening, return empty coach_message, empty arrays, null info_card, priority "low".`;

// ── User prompt builder ───────────────────────────────────────────

/**
 * @param {{
 *   session: import('./transcriptSession.js').TranscriptSession,
 *   lastSignalTags: string[],  // reason_tags from last LLM or heuristic signal
 * }} opts
 * @returns {string}
 */
export function buildUserPrompt({ session, lastSignalTags = [] }) {
  const allTexts = session.getContextText(CONTEXT_UTTERANCES + 1);
  const latest = allTexts[allTexts.length - 1] ?? '';
  const recent = allTexts.slice(0, -1);

  const lang = session.getLatest()?.lang ?? 'tr-TR';

  const parts = [
    `LANGUAGE: ${lang}`,
    `RECENT_CONTEXT:\n${recent.length > 0 ? recent.join('\n') : '(start of conversation)'}`,
    `LATEST: ${latest}`,
  ];

  if (lastSignalTags.length > 0) {
    // Help the model avoid repeating recent signals
    parts.push(`RECENT_SIGNALS: ${lastSignalTags.join(', ')}`);
  }

  return parts.join('\n');
}
