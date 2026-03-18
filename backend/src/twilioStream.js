/**
 * twilioStream.js
 *
 * Handles an incoming Twilio MediaStream WebSocket connection.
 *
 * Twilio sends a sequence of JSON frames over WS:
 *   { event: 'connected', ... }
 *   { event: 'start',     start: { callSid, customParameters: { lang } } }
 *   { event: 'media',     media: { track, payload } }  — base64 mulaw audio
 *   { event: 'stop',      ... }
 *
 * This module decodes the audio and pipes it to Deepgram via sttProvider.
 * Transcripts are surfaced via the onTranscript callback with speaker: 'customer'.
 */

import { createSttProvider } from './sttProvider.js';

/**
 * @param {{
 *   apiKey:         string,
 *   onCallStarted:  (info: { callSid: string, lang: string }) => void,
 *   onTranscript:   (utterance: { text: string, lang: string, ts: number, speaker: string }) => void,
 *   onCallEnded:    () => void,
 * }} opts
 * @returns {(ws: import('ws').WebSocket) => void}
 */
export function createTwilioStreamHandler({ apiKey, onCallStarted, onTranscript, onCallEnded }) {
  return function handleTwilioWs(ws) {
    let stt = null;
    let callLang = 'tr-TR';
    let callSid  = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      switch (msg.event) {
        case 'connected':
          console.log('[TWILIO] MediaStream connected');
          break;

        case 'start': {
          callSid  = msg.start?.callSid ?? 'unknown';
          callLang = msg.start?.customParameters?.lang ?? 'tr-TR';

          console.log(`[TWILIO] Call started — sid:${callSid} lang:${callLang}`);

          // Twilio MediaStream uses mulaw 8kHz — pass format explicitly
          stt = createSttProvider({
            apiKey,
            language:   callLang,
            encoding:   'mulaw',
            sampleRate: 8000,
            container:  null,
          });

          stt.on('transcript', ({ text }) => {
            onTranscript({ text, lang: callLang, ts: Date.now(), speaker: 'customer' });
          });

          stt.on('error', (err) => {
            console.error('[TWILIO] STT error:', err.message);
          });

          // onCallStarted returns false to reject (e.g. another call already active)
          const accepted = onCallStarted({ callSid, lang: callLang });
          if (accepted === false) {
            console.warn(`[TWILIO] Call ${callSid} rejected by server — closing stream`);
            stt.close();
            stt = null;
            ws.close();
            return;
          }
          break;
        }

        case 'media': {
          // Only process inbound (customer) audio
          if (msg.media?.track !== 'inbound') break;

          const audioChunk = Buffer.from(msg.media.payload, 'base64');
          stt?.write(audioChunk);
          break;
        }

        case 'stop':
          console.log(`[TWILIO] Call stopped — sid:${callSid}`);
          stt?.close();
          stt = null;
          onCallEnded();
          break;

        default:
          // Ignore unknown Twilio events
          break;
      }
    });

    ws.on('close', () => {
      console.log('[TWILIO] WS closed');
      if (stt) {
        stt.close();
        stt = null;
        onCallEnded();
      }
    });

    ws.on('error', (err) => {
      console.error('[TWILIO] WS error:', err.message);
    });
  };
}
