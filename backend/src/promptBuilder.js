/**
 * promptBuilder.js
 *
 * Builds the system + user prompt for the intake intelligence layer.
 *
 * The system prompt instructs the model to act as a live intake whisper
 * assistant — not a sales coach. It reasons about conversation state,
 * not just the latest utterance.
 *
 * The user prompt includes:
 *   - current field status (so the model knows what is already known)
 *   - accumulated customer signals (for dedup)
 *   - last whisper note (for continuity)
 *   - recent transcript context
 *   - latest utterance
 *   - speaker annotations when available (omitted when all unknown)
 */

import { INTAKE_FIELDS } from './intakeSchema.js';

// Number of recent utterances passed as context (excluding the latest).
const CONTEXT_UTTERANCES = 6;

// ── System prompt ─────────────────────────────────────────────────

export const SYSTEM_PROMPT = `You are a real-time intake whisper assistant.
You listen to a live customer conversation and guide the intake agent silently in the background.
Return only valid JSON matching the provided schema. Do not explain. Do not use markdown.

LANGUAGE: Always respond in the same language as the LANGUAGE field (Turkish for tr-TR, English for en-US).

YOUR ROLE:
You track what has been learned from the customer, what is still missing, and what the intake agent should ask next.
You do not coach on tone, pace, or sales technique.
You focus exclusively on intake completeness and customer understanding.

INTAKE FIELDS:
The following fields define a complete intake. You will receive their current status and must update them based on the latest conversation.
Fields: customer_goal, urgency, budget, current_status, prior_attempts, main_constraint, decision_maker, timeline, eligibility_risk, next_step_readiness

FIELD STATUS RULES:
- unknown:  field has not come up in the conversation at all. Use this when there is no signal.
- missing:  field is clearly relevant or was touched on, but the customer gave no usable answer.
- partial:  customer addressed the field but the answer is vague, conditional, or incomplete.
- answered: customer gave a clear, specific, actionable answer. Only use "answered" when the information is explicit enough to act on without follow-up.
- When in doubt between "partial" and "answered", use "partial".
- When in doubt between "missing" and "unknown", use "unknown".
- Never return a lower status than what FIELD_STATUS_SO_FAR already shows for a field. Only promote, never demote.

CUSTOMER SIGNALS — use only these values (use multiple if applicable):
price_sensitive, urgent, hesitant, comparing_options, decision_maker_unknown,
first_time_researcher, unclear_eligibility, not_ready_to_commit, high_intent,
needs_approval, unclear_timeline, open_to_guidance

Do not invent signal names outside this list.

NEXT QUESTIONS RULES:
- next_questions must be questions the intake agent should ask the customer to close specific missing or partial fields.
- Each question should target a named intake field that is currently unknown, missing, or partial.
- Do not generate generic rapport questions or sales technique questions.
- Do not suggest questions for fields already marked "answered".
- Maximum 3 questions. Fewer is better if the gaps are limited.
- Write questions as the agent would naturally say them to the customer.

WHISPER NOTE RULES:
- whisper_note is a short private note visible only to the intake agent.
- It should say what to focus on right now, in one sentence.
- Maximum 15 words.
- Do not summarize the whole conversation. Focus on the most urgent gap or signal.
- Write it as a direct instruction or observation, not a question.
- If LAST_WHISPER_NOTE already covers the most important gap and nothing new has emerged, you may return an empty string.

SIGNALS ALREADY DETECTED — do not repeat these unless the customer reinforces them:
These are provided in CUSTOMER_SIGNALS_SO_FAR.`;

// ── User prompt builder ───────────────────────────────────────────

/**
 * @param {{
 *   session:           import('./transcriptSession.js').TranscriptSession,
 *   conversationState: import('./transcriptSession.js').ConversationState,
 * }} opts
 * @returns {string}
 */
export function buildUserPrompt({ session, conversationState }) {
  const lang    = session.getLatest()?.lang ?? 'tr-TR';
  const window  = session.getContextWindow(CONTEXT_UTTERANCES + 1);
  const latest  = window[window.length - 1] ?? null;
  const recent  = window.slice(0, -1);

  // Only add speaker prefix if we have meaningful speaker info.
  // When all utterances are 'unknown', omit the prefix entirely to keep the
  // prompt clean. When real diarization data is available, it will annotate.
  const allUnknown = window.every((u) => u.speaker === 'unknown');
  const formatLine = (u) =>
    allUnknown ? u.text : `[${u.speaker}] ${u.text}`;

  const recentText = recent.length > 0
    ? recent.map(formatLine).join('\n')
    : '(start of conversation)';

  const latestText = latest ? formatLine(latest) : '';

  // Field status block — show each field and its current status
  const fieldStatusLines = INTAKE_FIELDS.map((f) => {
    const status = conversationState.fieldStatus[f] ?? 'unknown';
    return `  ${f}: ${status}`;
  }).join('\n');

  // Signal dedup block
  const signalsSoFar = conversationState.customerSignals.length > 0
    ? conversationState.customerSignals.join(', ')
    : '(none yet)';

  const parts = [
    `LANGUAGE: ${lang}`,
    `FIELD_STATUS_SO_FAR:\n${fieldStatusLines}`,
    `CUSTOMER_SIGNALS_SO_FAR: ${signalsSoFar}`,
  ];

  if (conversationState.lastWhisperNote) {
    parts.push(`LAST_WHISPER_NOTE: ${conversationState.lastWhisperNote}`);
  }

  parts.push(
    `RECENT_CONTEXT:\n${recentText}`,
    `LATEST: ${latestText}`,
  );

  return parts.join('\n');
}
