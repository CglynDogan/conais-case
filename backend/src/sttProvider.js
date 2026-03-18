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
  };

  if (container) {
    // Container format (e.g. WebM/Opus from browser MediaRecorder).
    // encoding and sample_rate are embedded in the container header.
    // Deepgram closes with 1011 if encoding is also sent — they are mutually exclusive.
    paramObj.container = container;
  } else {
    // Raw audio (e.g. Twilio mulaw): encoding and sample_rate must be explicit.
    paramObj.encoding    = encoding;
    paramObj.sample_rate = String(sampleRate);
  }

  const params = new URLSearchParams(paramObj);

  const url = `${DEEPGRAM_URL}?${params.toString()}`;
  console.log(`[STT] Connecting — model:${model} lang:${langCode} params:${params.toString()}`);

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

    // Log anything that isn't a Results event — errors, metadata, warnings
    if (data.type !== 'Results') {
      console.log(`[STT] Deepgram event type:${data.type}`, JSON.stringify(data));
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
    const reasonStr = reason?.toString?.() || '';
    console.log(`[STT] Deepgram connection closed (${code})${reasonStr ? ` — ${reasonStr}` : ''}`);
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
