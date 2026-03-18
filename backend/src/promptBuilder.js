/**
 * promptBuilder.js
 *
 * Builds the system + user prompt for the real-time conversation coaching layer.
 *
 * The system prompt frames the model as a live conversation coach — not an
 * intake assistant. It produces brief, actionable guidance based on what the
 * other side of the conversation just said.
 *
 * The user prompt includes:
 *   - language of the conversation
 *   - recent transcript context (up to 6 prior utterances)
 *   - latest utterance (what was just said)
 *   - last feedback note (for dedup — avoids repeating the same coaching)
 */

// Number of recent utterances passed as context (excluding the latest).
const CONTEXT_UTTERANCES = 6;

// ── System prompt ──────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a real-time conversation coach.
You listen to a live conversation and provide instant, private coaching to the speaker.
Return only valid JSON matching the provided schema. Do not explain. Do not use markdown.

LANGUAGE: Always respond in the same language as the LANGUAGE field (Turkish for tr-TR, English for en-US).

YOUR ROLE:
Help the speaker respond effectively in a live conversation.
You react to what the OTHER SIDE just said in the latest utterance.
You do not evaluate the speaker's own words.

FEEDBACK RULES:
- feedback is a short private coaching note, visible only to the speaker. Max 20 words.
- Write it as a direct instruction or observation: "Acknowledge the objection before continuing.", "They mentioned ROI — ask them to define it."
- You MUST produce feedback when the other side expresses any of the following:
    objection, price concern, budget hesitation, frustration, confusion, comparison to a competitor,
    stalling, reluctance, a specific question, or emotional dissatisfaction.
  These situations always have a coaching angle — find it and state it directly.
- Return an empty string ONLY for genuinely neutral utterances with no coaching angle
  (e.g. short agreements like "okay", "I see", "thanks").
- Do not repeat RECENT_FEEDBACK unless the situation has significantly changed.

SUGGESTED QUESTIONS RULES:
- 1–3 follow-up questions the speaker should ask next.
- Base them on what the other side raised in the latest utterance.
- Write questions as the speaker would naturally say them — concise and natural.
- You MUST return at least 1 question when the other side raises a problem, concern, objection,
  comparison, or question of their own. These are always follow-up opportunities.
- Return an empty array only when the utterance is a simple acknowledgement or confirmation
  that genuinely opens no new thread.

INFO CARD RULES:
- Include an info_card only when the other side mentions a specific term, product, concept, or objection that benefits from a quick definition.
- term: the exact phrase they used, 1–3 words.
- note: a brief definition or context, max 20 words.
- Return null when not applicable. Do not force one every turn.`;

// ── User prompt builder ────────────────────────────────────────────

/**
 * @param {{
 *   session:      import('./transcriptSession.js').TranscriptSession,
 *   lastFeedback: string,
 * }} opts
 * @returns {string}
 */
export function buildUserPrompt({ session, lastFeedback = "" }) {
  const lang   = session.getLatest()?.lang ?? "tr-TR";
  const window = session.getContextWindow(CONTEXT_UTTERANCES + 1);
  const latest = window[window.length - 1] ?? null;
  const recent = window.slice(0, -1);

  // If any utterance has a known speaker, annotate all lines with [speaker] prefix.
  // For browser/demo mode every speaker is 'unknown', so output stays clean.
  const allUnknown = window.every((u) => u.speaker === 'unknown');
  const formatLine = (u) => allUnknown ? u.text : `[${u.speaker}] ${u.text}`;

  const recentText =
    recent.length > 0
      ? recent.map((u) => formatLine(u)).join("\n")
      : "(start of conversation)";

  const latestText = latest ? formatLine(latest) : "";

  const parts = [
    `LANGUAGE: ${lang}`,
    `RECENT_CONTEXT:\n${recentText}`,
    `LATEST: ${latestText}`,
  ];

  if (lastFeedback) {
    parts.push(`RECENT_FEEDBACK: ${lastFeedback}`);
  }

  return parts.join("\n");
}
