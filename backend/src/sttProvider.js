/**
 * sttProvider.js
 *
 * Deepgram streaming STT client.
 * Audio source: Browser Call — WebM/Opus from MediaRecorder (container=webm).
 *
 * Emits 'transcript' on every is_final result from Deepgram.
 * speech_final is NOT required — with interim_results:false every event
 * Deepgram sends already has is_final=true (non-overlapping committed segments).
 *
 * Events emitted:
 *   'transcript'  { text: string, speaker: string | null }
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
 *   sampleRate?: number,  // Default: 48000 (browser capture rate).
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
  diarize    = true,   // false for single-speaker sources (mic-only mode)
}) {
  const emitter = new EventEmitter();

  // Deepgram expects the base language code (e.g. 'tr', 'en')
  const langCode = language.split('-')[0];

  const model = process.env.DEEPGRAM_MODEL ?? 'nova-3';

  const paramObj = {
    model,
    language:        langCode,
    smart_format:    'true',   // improved punctuation, numbers, and formatting
    filler_words:    'true',   // preserve filler words (Turkish: ee, şey, yani, etc.)
    interim_results: 'false',
    endpointing:     '300',
    diarize:         diarize ? 'true' : 'false',
  };

  if (container) {
    // Container format (e.g. WebM/Opus from browser MediaRecorder).
    // encoding and sample_rate are embedded in the container header.
    // Deepgram closes with 1011 if encoding is also sent — they are mutually exclusive.
    paramObj.container = container;
  } else {
    // Raw audio (no container header): encoding and sample_rate must be explicit.
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

    // Accept any is_final result — speech_final is NOT required.
    // speech_final only fires on silence gaps (endpointing: 300ms), which
    // rarely occur in continuous browser/Jitsi audio. With interim_results:false
    // every event Deepgram sends already has is_final=true, so all segments are
    // non-overlapping committed transcripts.
    if (
      data.type === 'Results' &&
      data.is_final === true
    ) {
      const alt  = data.channel?.alternatives?.[0];
      const text = alt?.transcript ?? '';
      if (!text.trim()) return;

      // Extract dominant speaker index from the words array (diarize=true).
      // Each word carries a speaker integer; pick the most frequent one for this segment.
      // Produces 'speaker_0', 'speaker_1', etc. — honest labels, no role assumption.
      let speakerTag = null;
      const words = alt?.words ?? [];
      if (words.length > 0) {
        const counts = {};
        for (const w of words) {
          if (w.speaker != null) counts[w.speaker] = (counts[w.speaker] ?? 0) + 1;
        }
        const keys = Object.keys(counts);
        if (keys.length > 0) {
          const dominant = keys.reduce((a, b) => counts[a] > counts[b] ? a : b);
          speakerTag = `speaker_${dominant}`;
        }
      }

      emitter.emit('transcript', { text: text.trim(), speaker: speakerTag });
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
