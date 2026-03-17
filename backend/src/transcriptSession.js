/**
 * transcriptSession.js
 *
 * Session-level transcript state for one WebSocket connection.
 * Stores finalized utterances and provides a sliding context window
 * for LLM analysis in Phase 4.
 *
 * Lifecycle: created on connection open, discarded on connection close.
 */

const CONTEXT_WINDOW_SIZE = 10; // max utterances included in LLM context

/**
 * @typedef {{ text: string, lang: string, ts: number, wordCount: number }} Utterance
 */

export function createTranscriptSession() {
  /** @type {Utterance[]} */
  let utterances = [];

  // ── Mutations ──────────────────────────────────────────────

  function reset() {
    utterances = [];
  }

  /**
   * Add a finalized utterance to the session.
   * @param {{ text: string, lang: string, ts: number, confidence: number|null }} payload
   * @returns {Utterance} the stored utterance
   */
  function addUtterance(payload) {
    const utterance = {
      text: payload.text,
      lang: payload.lang ?? 'tr-TR',
      ts: payload.ts ?? Date.now(),
      wordCount: countWords(payload.text),
    };
    utterances.push(utterance);
    return utterance;
  }

  // ── Reads ──────────────────────────────────────────────────

  /** Most recent finalized utterance, or null. */
  function getLatest() {
    return utterances[utterances.length - 1] ?? null;
  }

  /** Second-most-recent utterance, or null. */
  function getPrevious() {
    return utterances[utterances.length - 2] ?? null;
  }

  /**
   * Returns the last `n` utterances — the analysis context window.
   * Used by LLM prompt builder in Phase 4.
   * @param {number} [n]
   * @returns {Utterance[]}
   */
  function getContextWindow(n = CONTEXT_WINDOW_SIZE) {
    return utterances.slice(-n);
  }

  /**
   * Returns the last `n` utterances as plain text strings.
   * Convenience method for Phase 4 prompt builder — avoids re-mapping
   * Utterance objects every time a prompt is constructed.
   * @param {number} [n]
   * @returns {string[]}
   */
  function getContextText(n = CONTEXT_WINDOW_SIZE) {
    return utterances.slice(-n).map((u) => u.text);
  }

  /** Total number of finalized utterances in this session. */
  function getCount() {
    return utterances.length;
  }

  return {
    reset,
    addUtterance,
    getLatest,
    getPrevious,
    getContextWindow,
    getContextText,
    getCount,
  };
}

// ── Helpers ────────────────────────────────────────────────

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
