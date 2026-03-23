/**
 * analysisTrigger.js
 *
 * Controls WHEN analysis runs. Two separate paths:
 *
 *   Immediate path  — fires on every finalized utterance
 *                     → runs heuristics synchronously, no delay
 *
 *   Batched path    — fires when enough new content has accumulated
 *                     → runs the LLM coaching analysis (Gemini/OpenAI)
 *
 * Trigger strategy — two policies by speaker:
 *
 *   AGENT turn → fire immediately.
 *     The agent just spoke. Analyze the full customer block that preceded this
 *     response plus the agent's response itself. Fast feedback is critical here.
 *
 *   CUSTOMER / REMOTE turn → accumulate, fire only on silence or hard cap.
 *     STT fragments long customer thoughts into many short segments. Any
 *     count-based trigger fires on partial meaning. Instead, we wait for either:
 *       (a) customerSilenceMs of quiet — customer has clearly stopped talking, or
 *       (b) maxBatchSize fragments     — hard cap to prevent indefinite delay.
 *     The primary trigger for customer coaching is therefore the AGENT speaking
 *     next, which transitions the conversation and fires the analysis of what
 *     the customer just said as a whole.
 *
 * The trigger does not own LLM-busy state — server.js uses `isLlmBusy` to
 * guard against overlapping calls. If a batch fires while a call is in-flight,
 * the caller skips it; the silence-timer path will catch any trailing content.
 */

/**
 * @param {{
 *   onImmediate:        (session: object) => void,
 *   onBatch:            (session: object) => void,
 *   maxBatchSize?:      number,  // hard cap for customer turns (default 8)
 *   silenceMs?:         number,  // fallback silence window for agent turns (default 1500)
 *   customerSilenceMs?: number,  // customer silence window — wait for thought boundary (default 2500)
 * }} callbacks
 */
export function createAnalysisTrigger({
  onImmediate,
  onBatch,
  maxBatchSize      = 8,
  silenceMs         = 1_500,
  customerSilenceMs = 2_500,
}) {
  let pendingCount = 0;
  let silenceTimer = null;

  function fireBatch(session) {
    pendingCount = 0;
    onBatch(session);
  }

  function resetSilenceTimer(session) {
    clearTimeout(silenceTimer);
    const latest = session.getLatest();
    const latestSpeaker = latest?.speaker;

    let delay;
    if (latestSpeaker === 'agent') {
      delay = silenceMs;
    } else {
      // With smart_format:true, Deepgram adds terminal punctuation (. ? !) to
      // complete sentences. A fragment lacking terminal punctuation is almost
      // certainly mid-sentence — use a longer window so the timer doesn't fire
      // during natural pauses between clauses of one continuous customer thought.
      // A fragment that ends with . ? ! is sentence-final — use the short window
      // so coaching still arrives quickly after a concise customer turn.
      const text = (latest?.text ?? '').trimEnd();
      const isSentenceEnd = /[.?!…]$/.test(text);
      delay = isSentenceEnd ? customerSilenceMs : Math.max(customerSilenceMs * 2, 2_500);
    }

    silenceTimer = setTimeout(() => {
      if (pendingCount > 0) fireBatch(session);
    }, delay);
  }

  /**
   * Call on every TRANSCRIPT_FINAL event.
   * @param {object} session  transcriptSession instance
   */
  function onFinal(session) {
    // Immediate path always runs first — synchronous, no side effects on batching
    onImmediate(session);

    const latestSpeaker = session.getLatest()?.speaker;

    if (latestSpeaker === 'agent') {
      // Agent just spoke: fire immediately.
      // This is the primary LLM trigger — the full preceding customer block plus
      // the agent's response is now in session context, ready for complete analysis.
      clearTimeout(silenceTimer);
      pendingCount = 0;
      onBatch(session);
      return;
    }

    // Customer / remote speaker: accumulate all fragments.
    // No count-based trigger — fragments of one customer thought must not each
    // produce their own coaching reaction. Only silence or the hard cap fires LLM.
    pendingCount += 1;

    if (pendingCount >= maxBatchSize) {
      // Hard cap: fire unconditionally to prevent indefinite delay on long turns
      clearTimeout(silenceTimer);
      fireBatch(session);
      return;
    }

    resetSilenceTimer(session); // waits customerSilenceMs before firing
  }

  /** Reset when a new listening session starts. */
  function reset() {
    clearTimeout(silenceTimer);
    pendingCount = 0;
  }

  return { onFinal, reset };
}
