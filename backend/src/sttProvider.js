/**
 * sttProvider.js
 *
 * Deepgram streaming STT client for Twilio MediaStream audio.
 *
 * Receives mulaw 8kHz audio chunks from the Twilio path and streams them
 * to Deepgram's WebSocket API. Emits 'transcript' only when Deepgram
 * signals both is_final AND speech_final — i.e. a committed sentence.
 *
 * Events emitted:
 *   'transcript'  { text: string }
 *   'error'       Error
 *   'close'       (no args)
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';

/**
 * @param {{
 *   apiKey:      string,
 *   language?:   string,  // e.g. 'tr-TR' — base code used ('tr')
 *   encoding?:   string,  // Deepgram encoding param. Default: 'opus' (browser WebM/Opus)
 *   sampleRate?: number,  // Default: 48000 (browser capture). Twilio mulaw uses 8000.
 *   container?:  string | null, // 'webm' for browser MediaRecorder output; null to omit.
 * }} opts
 * @returns {{ write(chunk: Buffer): void, close(): void, on: Function, off: Function }}
 */
export function createSttProvider({
  apiKey,
  language   = 'tr-TR',
  encoding   = 'opus',
  sampleRate = 48000,
  container  = 'webm',
}) {
  const emitter = new EventEmitter();

  // Deepgram expects the base language code (e.g. 'tr', 'en')
  const langCode = language.split('-')[0];

  const model = process.env.DEEPGRAM_MODEL ?? 'nova-3';

  const paramObj = {
    model,
    language:        langCode,
    punctuate:       'true',
    interim_results: 'false',
    endpointing:     '300',
    encoding,
    sample_rate:     String(sampleRate),
  };
  if (container) paramObj.container = container;

  const params = new URLSearchParams(paramObj);

  const url = `${DEEPGRAM_URL}?${params.toString()}`;

  // Audio frames that arrive before the Deepgram WS is open are queued here
  // and flushed on 'open'. Cap at 200 chunks (~4s at 50 frames/sec) to bound memory.
  const MAX_PENDING = 200;
  const pendingChunks = [];

  const dg = new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  });

  dg.on('open', () => {
    console.log(`[STT] Deepgram connection open — flushing ${pendingChunks.length} buffered chunks`);
    for (const chunk of pendingChunks) {
      dg.send(chunk);
    }
    pendingChunks.length = 0;
  });

  dg.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Only process final, speech-final transcript events
    if (
      data.type === 'Results' &&
      data.is_final === true &&
      data.speech_final === true
    ) {
      const text = data.channel?.alternatives?.[0]?.transcript ?? '';
      if (text.trim()) {
        emitter.emit('transcript', { text: text.trim() });
      }
    }
  });

  dg.on('error', (err) => {
    console.error('[STT] Deepgram error:', err.message);
    emitter.emit('error', err);
  });

  dg.on('close', (code, reason) => {
    console.log(`[STT] Deepgram connection closed (${code})`);
    pendingChunks.length = 0;
    emitter.emit('close');
  });

  function write(chunk) {
    if (dg.readyState === WebSocket.OPEN) {
      dg.send(chunk);
    } else if (dg.readyState === WebSocket.CONNECTING) {
      if (pendingChunks.length < MAX_PENDING) {
        pendingChunks.push(chunk);
      }
    }
    // CLOSING / CLOSED: drop silently
  }

  function close() {
    if (dg.readyState === WebSocket.OPEN || dg.readyState === WebSocket.CONNECTING) {
      // Send CloseStream signal to Deepgram before closing
      if (dg.readyState === WebSocket.OPEN) {
        dg.send(JSON.stringify({ type: 'CloseStream' }));
      }
      dg.close();
    }
  }

  return {
    write,
    close,
    on:  emitter.on.bind(emitter),
    off: emitter.off.bind(emitter),
  };
}
