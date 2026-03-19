/**
 * audioStream.js
 *
 * Handles browser-captured audio streamed over WebSocket for real-time coaching.
 *
 * Audio source: browser tab / system audio via getDisplayMedia + MediaRecorder
 * Format: WebM/Opus at 48kHz (browser default)
 *
 * This module is the browser-call equivalent of twilioStream.js — it drives
 * the same sttProvider → transcript → session → trigger pipeline, but the
 * audio comes from the browser instead of from Twilio.
 *
 * Usage (one instance per browser WS connection):
 *   const handler = createAudioStreamHandler({ apiKey, onTranscript });
 *   handler.handleStart('en-US');   // called when AUDIO_START event arrives
 *   handler.handleChunk(buffer);    // called for each binary WS frame
 *   handler.handleStop();           // called when AUDIO_STOP event arrives or WS closes
 */

import { createSttProvider } from './sttProvider.js';

/**
 * @param {{
 *   apiKey:       string,
 *   onTranscript: (utterance: { text: string, lang: string, ts: number, speaker: string }) => void,
 *   onError?:     (reason: string) => void,
 * }} opts
 */
export function createAudioStreamHandler({ apiKey, onTranscript, onError }) {
  let stt         = null;
  let active      = false;
  let currentLang = 'tr-TR';
  let chunkCount  = 0;

  function handleStart(lang = 'tr-TR') {
    if (!apiKey) {
      console.warn('[AUDIO] DEEPGRAM_API_KEY not set — browser audio stream disabled');
      onError?.('deepgram-not-configured');
      return;
    }

    // Stop any previously active stream before starting a new one
    if (active) {
      console.warn('[AUDIO] Stopping previous stream before starting new one');
      handleStop();
    }

    currentLang = lang;
    active      = true;
    chunkCount  = 0;

    // Browser MediaRecorder produces WebM/Opus — use browser-format defaults
    stt = createSttProvider({ apiKey, language: lang });

    stt.on('transcript', ({ text, speaker }) => {
      onTranscript({ text, lang: currentLang, ts: Date.now(), speaker: speaker ?? 'unknown' });
    });

    stt.on('error', (err) => {
      console.error('[AUDIO] STT error:', err.message);
      onError?.('stt-error');
    });

    stt.on('close', () => {
      const wasActive = active;
      active = false;
      stt    = null;
      // Unexpected close while capture was still running
      if (wasActive) onError?.('stt-disconnected');
    });

    console.log(`[AUDIO] Stream started (lang:${lang})`);
  }

  function handleChunk(data) {
    chunkCount++;
    if (chunkCount <= 3) {
      console.log(`[AUDIO] Chunk #${chunkCount}: ${data?.byteLength ?? 0} bytes`);
    } else if (chunkCount === 4) {
      console.log('[AUDIO] Chunk logging suppressed — stream flowing');
    }
    stt?.write(data);
  }

  function handleStop() {
    if (stt) {
      stt.close();
      stt = null;
    }
    if (active) {
      console.log('[AUDIO] Stream stopped');
    }
    active = false;
  }

  function isActive() {
    return active;
  }

  return { handleStart, handleChunk, handleStop, isActive };
}
