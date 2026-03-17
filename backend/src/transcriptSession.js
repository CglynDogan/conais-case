/**
 * transcriptSession.js
 *
 * Session-level state for one WebSocket connection.
 * Holds two things:
 *
 *   1. utterances[]      — raw transcript, newest last
 *   2. conversationState — accumulated intake intelligence across LLM batches
 *
 * Speaker field on utterances:
 *   'customer' | 'agent' | 'unknown'
 *   The current Web Speech API path always produces 'unknown'.
 *   A future VoIP / diarization layer can populate the correct value
 *   without changing any downstream code.
 *
 * Lifecycle: created on connection open, discarded on connection close.
 */

import { initialFieldStatus, mergeFieldStatus } from './intakeSchema.js';

const CONTEXT_WINDOW_SIZE = 10;

/**
 * @typedef {{
 *   text:      string,
 *   lang:      string,
 *   ts:        number,
 *   wordCount: number,
 *   speaker:   'customer' | 'agent' | 'unknown',
 * }} Utterance
 */

/**
 * @typedef {{
 *   fieldStatus:     Record<string, string>,
 *   customerSignals: string[],
 *   lastWhisperNote: string,
 *   speakersSeen:    string[],
 * }} ConversationState
 */

export function createTranscriptSession() {
  /** @type {Utterance[]} */
  let utterances = [];

  /** @type {ConversationState} */
  let conversationState = freshConversationState();

  // ── Mutations ──────────────────────────────────────────────

  function reset() {
    utterances = [];
    conversationState = freshConversationState();
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
      lang:      payload.lang     ?? 'tr-TR',
      ts:        payload.ts       ?? Date.now(),
      wordCount: countWords(payload.text),
      speaker:   payload.speaker  ?? 'unknown',
    };
    utterances.push(utterance);
    return utterance;
  }

  /**
   * Update the accumulated conversation state after an LLM batch result.
   * Field statuses are merged with the monotonic merge rule.
   * Customer signals are deduplicated.
   *
   * @param {{
   *   field_status?:     Record<string, string>,
   *   customer_signals?: string[],
   *   whisper_note?:     string,
   * }} patch
   */
  function updateConversationState(patch) {
    if (patch.field_status) {
      conversationState.fieldStatus = mergeFieldStatus(
        conversationState.fieldStatus,
        patch.field_status,
      );
    }
    if (Array.isArray(patch.customer_signals)) {
      conversationState.customerSignals = [
        ...new Set([...conversationState.customerSignals, ...patch.customer_signals]),
      ];
    }
    if (typeof patch.whisper_note === 'string' && patch.whisper_note.trim()) {
      conversationState.lastWhisperNote = patch.whisper_note.trim();
    }
  }

  /** @returns {ConversationState} snapshot (shallow copy) */
  function getConversationState() {
    return {
      fieldStatus:     { ...conversationState.fieldStatus },
      customerSignals: [...conversationState.customerSignals],
      lastWhisperNote: conversationState.lastWhisperNote,
      speakersSeen:    [...conversationState.speakersSeen],
    };
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

  /**
   * Returns the last `n` utterances as plain text strings.
   * Used by prompt builder when speaker info is not needed.
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
    updateConversationState,
    getConversationState,
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

function freshConversationState() {
  return {
    fieldStatus:     initialFieldStatus(),  // all 'unknown'
    customerSignals: [],
    lastWhisperNote: '',
    speakersSeen:    [],
  };
}
