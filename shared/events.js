/**
 * WebSocket event contract — single source of truth.
 *
 * Naming convention:  <direction>:<topic>
 *   client:*      — sent by the browser to the server
 *   server:*      — sent by the server to the browser
 *   transcript:*  — speech recognition data (client → server)
 *   analysis:*    — coaching analysis results (server → client)
 *   demo:*        — demo mode control (client → server)
 *
 * Backend (ESM):  import { WS_EVENTS } from '../../shared/events.js'
 * Frontend (ESM): import { WS_EVENTS } from '@shared/events'
 */

export const WS_EVENTS = {
  // ── Client → Server ──────────────────────────────────────────
  /** Connectivity check. Server replies with server:pong. */
  CLIENT_PING: 'client:ping',

  /** Interim (non-final) transcript chunk from Web Speech API. */
  TRANSCRIPT_INTERIM: 'transcript:interim',

  /** Final (committed) transcript chunk from Web Speech API. */
  TRANSCRIPT_FINAL: 'transcript:final',

  /** Start a scripted demo playback sequence. */
  DEMO_TRIGGER: 'demo:trigger',

  // ── Server → Client ──────────────────────────────────────────
  /** Response to client:ping. */
  SERVER_PONG: 'server:pong',

  /**
   * LLM / heuristics coaching payload.
   * Rule shape:  { source: 'rule', tone_alert: { type, message } }
   * LLM shape:   { source: 'llm', feedback, suggested_questions, info_card }
   */
  ANALYSIS_UPDATE: 'analysis:update',

  // ── Browser audio streaming (client → server) ─────────────────
  /** Browser-call mode starting. payload: { lang } — resets session on server. */
  AUDIO_START: 'audio:start',

  /** Browser audio stream ending. payload: {} */
  AUDIO_STOP: 'audio:stop',

  // ── Browser audio streaming (server → client) ─────────────────
  /** Server-side audio error (e.g. Deepgram key missing). payload: { reason } */
  AUDIO_ERROR: 'audio:error',

};
