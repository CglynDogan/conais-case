/**
 * analysisTrigger.js
 *
 * Controls WHEN analysis runs. Two separate paths:
 *
 *   Immediate path  — fires on every finalized utterance
 *                     → runs heuristics synchronously, no delay
 *
 *   Batched path    — fires when enough new content has accumulated
 *                     → Phase 3: stub (logs + status message)
 *                     → Phase 4: replace onBatch with Gemini call
 *                     Triggers when: BATCH_SIZE finals OR SILENCE_MS of quiet
 *
 * ── Phase 4 integration notes ────────────────────────────────────────
 *
 * To plug in the LLM in Phase 4, replace the onBatch stub in server.js
 * with an async function that calls geminiService. Two things to handle:
 *
 *   1. Guard against overlapping calls:
 *      The trigger fires regardless of whether the previous LLM call is
 *      still running. In Phase 4, set `isLlmBusy` in server.js and skip
 *      onBatch (or queue it) while the previous call is in-flight.
 *      This trigger intentionally does NOT own that state — keeping it here
 *      would couple the trigger to the LLM lifecycle.
 *
 *   2. Timeout + fallback:
 *      onBatch should wrap the LLM call in a 5s timeout and send the
 *      safe fallback payload on failure (defined in shared/fallback.js,
 *      which will be added in Phase 4).
 */

const BATCH_SIZE  = 3;       // finals accumulated since last batch trigger
const SILENCE_MS  = 3_000;   // quiet window (ms) before a forced batch trigger

/**
 * @param {{
 *   onImmediate: (session: object) => void,
 *   onBatch:     (session: object) => void,
 * }} callbacks
 */
export function createAnalysisTrigger({ onImmediate, onBatch }) {
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
    }, SILENCE_MS);
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

    if (pendingCount >= BATCH_SIZE) {
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
