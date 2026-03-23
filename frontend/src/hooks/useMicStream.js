/**
 * useMicStream.js
 *
 * Mic-only Deepgram streaming path.
 * getUserMedia → MediaRecorder → binary WS → backend → Deepgram (nova-3)
 *
 * Unlike useTabAudio (tab/system audio), this captures only the local mic.
 * Backend receives source:'mic' and forces speaker='agent', diarize:false.
 * Transcripts arrive back as server-sent TRANSCRIPT_FINAL{speaker:'agent'}.
 *
 * Exposes: { isStreaming, error, start(lang), stop(), clearError() }
 */

import { useState, useRef, useCallback } from 'react';
import { WS_EVENTS } from '../constants';

const TIMESLICE_MS = 250;

export function useMicStream({ send, sendBinary }) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError]             = useState(null);

  const streamRef   = useRef(null); // MediaStream
  const recorderRef = useRef(null); // MediaRecorder

  const clearError = useCallback(() => setError(null), []);

  const start = useCallback(async (lang = 'tr-TR') => {
    setError(null);

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      const code = (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
        ? 'not-allowed'
        : 'error';
      setError(code);
      return;
    }

    streamRef.current = stream;

    // Pre-warm: open Deepgram WS before MediaRecorder starts so connection
    // handshake completes while the first chunks are arriving.
    send(WS_EVENTS.AUDIO_START, { lang, source: 'mic' });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    let recorder;
    try {
      recorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      console.error('[MIC] MediaRecorder init failed:', err.message);
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setError('error');
      return;
    }

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        e.data.arrayBuffer().then((buf) => sendBinary(buf));
      }
    };

    recorder.onerror = (e) => {
      console.error('[MIC] MediaRecorder error:', e.error?.message);
      setError('error');
    };

    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current   = null;
      recorderRef.current = null;
    };

    recorderRef.current = recorder;
    recorder.start(TIMESLICE_MS);
    setIsStreaming(true);
    console.log('[MIC] Streaming started, lang:', lang);
  }, [send, sendBinary]);

  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop();
    } else if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    send(WS_EVENTS.AUDIO_STOP, {});
    setIsStreaming(false);
    console.log('[MIC] Streaming stopped');
  }, [send]);

  return { isStreaming, error, start, stop, clearError };
}
