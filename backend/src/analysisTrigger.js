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
 *                     → triggers when BATCH_SIZE finals OR SILENCE_MS of quiet
 *
 * The trigger does not own LLM-busy state — server.js uses `isLlmBusy` to
 * guard against overlapping calls. If a batch fires while a call is in-flight,
 * the caller skips it; the silence-timer path will catch any trailing content.
 */

/**
 * @param {{
 *   onImmediate: (session: object) => void,
 *   onBatch:     (session: object) => void,
 *   batchSize?:  number,   // finals before LLM trigger (default 3)
 *   silenceMs?:  number,   // quiet window before forced trigger (default 3000)
 * }} callbacks
 */
export function createAnalysisTrigger({ onImmediate, onBatch, batchSize = 3, silenceMs = 3_000 }) {
  let pendingCount = 0;
  let silenceTimer = null;

  function fireBatch(session) {
    pendingCount = 0;
    onBatch(session);
  }

  function resetSilenceTimer(session) {
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (pendingCount > 0) fireBatch(session);
    }, silenceMs);
  }

  /**
   * Call on every TRANSCRIPT_FINAL event.
   * @param {object} session  transcriptSession instance
   */
  function onFinal(session) {
    // Immediate path always runs first — synchronous, no side effects on batching
    onImmediate(session);

    // Batched path — count toward next LLM trigger
    pendingCount += 1;

    if (pendingCount >= batchSize) {
      clearTimeout(silenceTimer);
      fireBatch(session);
    } else {
      // Not enough yet — reset the silence timer so trailing utterances trigger too
      resetSilenceTimer(session);
    }
  }

  /** Reset when a new listening session starts. */
  function reset() {
    clearTimeout(silenceTimer);
    pendingCount = 0;
  }

  return { onFinal, reset };
}
