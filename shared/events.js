/**
 * WebSocket event contract — single source of truth.
 *
 * Naming convention:  <direction>:<topic>
 *   client:*      — sent by the browser to the server
 *   server:*      — sent by the server to the browser
 *   transcript:*  — speech recognition data (client → server)
 *   analysis:*    — coaching analysis results (server → client)
 *   system:*      — connection / status events (bidirectional)
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
   * Shape: { tone_alert, suggestions, info_card }
   */
  ANALYSIS_UPDATE: 'analysis:update',

  /** Non-fatal server-side error notification. */
  SYSTEM_ERROR: 'system:error',

  /** General status message (e.g. "buffer flushed", "LLM timeout"). */
  SYSTEM_STATUS: 'system:status',

  // ── Browser audio streaming (client → server) ─────────────────
  /** Browser-call mode starting. payload: { lang } — resets session on server. */
  AUDIO_START: 'audio:start',

  /** Browser audio stream ending. payload: {} */
  AUDIO_STOP: 'audio:stop',

  // ── Browser audio streaming (server → client) ─────────────────
  /** Server-side audio error (e.g. Deepgram key missing). payload: { reason } */
  AUDIO_ERROR: 'audio:error',

  // ── Twilio call lifecycle (server → client) ────────────────────
  /** A Twilio call has connected and STT is active. payload: { callSid, lang } */
  CALL_STARTED: 'call:started',

  /** The active Twilio call has ended. payload: {} */
  CALL_ENDED: 'call:ended',
};
