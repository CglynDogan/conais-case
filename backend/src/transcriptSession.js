/**
 * transcriptSession.js
 *
 * Session-level utterance store for one WebSocket connection.
 * Holds the raw transcript as a time-ordered array of finalized utterances.
 *
 * Speaker field — values in use:
 *   'agent'     — mic input (known: salesperson's own microphone)
 *   'customer'  — demo script lines (known: scripted customer turns)
 *   'speaker_0' — Deepgram diarized, first voice (role unknown)
 *   'speaker_1' — Deepgram diarized, second voice (role unknown)
 *   'unknown'   — undifferentiated stream (no diarization available)
 *
 * Lifecycle: created on connection open, discarded on connection close.
 */

const CONTEXT_WINDOW_SIZE = 10;

/**
 * @typedef {{
 *   text:      string,
 *   lang:      string,
 *   ts:        number,
 *   wordCount: number,
 *   speaker:   'agent' | 'customer' | 'speaker_0' | 'speaker_1' | 'unknown',
 * }} Utterance
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
   * @param {{
   *   text:       string,
   *   lang:       string,
   *   ts:         number,
   *   confidence: number | null,
   *   speaker?:   string,
   * }} payload
   * @returns {Utterance}
   */
  function addUtterance(payload) {
    const utterance = {
      text:      payload.text,
      lang:      payload.lang    ?? 'tr-TR',
      ts:        payload.ts      ?? Date.now(),
      wordCount: countWords(payload.text),
      speaker:   payload.speaker ?? 'unknown',
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
   * @param {number} [n]
   * @returns {Utterance[]}
   */
  function getContextWindow(n = CONTEXT_WINDOW_SIZE) {
    return utterances.slice(-n);
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
    getCount,
  };
}

// ── Helpers ────────────────────────────────────────────────

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}
