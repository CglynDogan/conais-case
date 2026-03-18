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

    // Browser MediaRecorder produces WebM/Opus — use browser-format defaults
    stt = createSttProvider({ apiKey, language: lang });

    stt.on('transcript', ({ text }) => {
      onTranscript({ text, lang: currentLang, ts: Date.now(), speaker: 'unknown' });
    });

    stt.on('error', (err) => {
      console.error('[AUDIO] STT error:', err.message);
    });

    stt.on('close', () => {
      active = false;
      stt    = null;
    });

    console.log(`[AUDIO] Stream started (lang:${lang})`);
  }

  function handleChunk(data) {
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
