/**
 * useTabAudio
 *
 * Captures browser tab / system audio via getDisplayMedia and streams it
 * to the backend over WebSocket as binary frames for real-time STT.
 *
 * Intended use: coaching during a Jitsi Meet (or any browser-based call)
 * by capturing the call tab's audio, which includes all remote participants.
 *
 * Browser support: Chrome on Windows required for tab audio capture.
 *   preferCurrentTab is explicitly false — the user must select their call tab, not the app tab.
 *
 * Audio format: audio/webm;codecs=opus (browser MediaRecorder default)
 *   Chunks are emitted every TIMESLICE_MS and sent as binary WS frames.
 *   The backend handles reassembly and forwards to Deepgram.
 *
 * API shape (parallel to useSpeechRecognition):
 *   { isCapturing, captureStatus, start(lang), stop, error, clearError }
 *
 * captureStatus values:
 *   null           — idle, not started
 *   'requesting'   — getDisplayMedia dialog is open, waiting for user
 *   'capturing'    — recording and streaming audio to backend
 *   'stopped'      — ended normally (auto-clears after 3s)
 *
 * Error values:
 *   'not-allowed'  — user denied the screen/audio share prompt
 *   'no-audio'     — user shared a source with no audio track
 *   'unsupported'  — getDisplayMedia not available in this browser
 *   'error'        — unexpected failure
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { WS_EVENTS } from '../constants';

// Emit a chunk to the backend every 250ms
const TIMESLICE_MS = 250;

// Preferred MIME types in priority order — first supported wins
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const type of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * @param {{ send: Function, sendBinary: Function }} opts
 */
export function useTabAudio({ send, sendBinary }) {
  const [isCapturing,    setIsCapturing]    = useState(false);
  const [captureStatus,  setCaptureStatus]  = useState(null);
  const [error,          setError]          = useState(null);

  const recorderRef = useRef(null);
  const streamRef   = useRef(null);

  // Auto-clear 'stopped' status after 3s
  useEffect(() => {
    if (captureStatus !== 'stopped') return;
    const id = setTimeout(() => setCaptureStatus(null), 3000);
    return () => clearTimeout(id);
  }, [captureStatus]);

  // ── clearError ────────────────────────────────────────────────────
  const clearError = useCallback(() => setError(null), []);

  // ── stop ─────────────────────────────────────────────────────────
  // Called by the user, by the browser "Stop sharing" button, or on unmount.
  // AUDIO_STOP is sent by the recorder's onstop handler so it fires exactly once.
  const stop = useCallback(() => {
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop(); // triggers onstop → sends AUDIO_STOP
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current  = null;
    recorderRef.current = null;
    setIsCapturing(false);
  }, []);

  // ── start ─────────────────────────────────────────────────────────
  const start = useCallback(
    async (lang = 'tr-TR') => {
      if (typeof navigator?.mediaDevices?.getDisplayMedia === 'undefined') {
        setError('unsupported');
        return;
      }

      setError(null);

      // ── 1. Ask the user to share a tab / window / screen with audio ──
      // video:true is required to open the picker on all platforms (including macOS).
      // video:false throws TypeError immediately on macOS Chrome before the picker opens.
      // Video tracks are stopped right after to avoid unnecessary screen capture.
      setCaptureStatus('requesting');
      let stream;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
          // Do NOT use preferCurrentTab:true — it pre-selects the coaching app tab
          // (localhost), which has no call audio. The user must select their Jitsi/call
          // tab manually from the picker.
          preferCurrentTab: false,
        });
      } catch (err) {
        setCaptureStatus(null);
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setError('not-allowed');
        } else if (err.name === 'NotSupportedError' || err.name === 'TypeError') {
          setError('unsupported');
        } else {
          setError('error');
        }
        return;
      }

      // Stop video tracks — only audio is needed for coaching
      stream.getVideoTracks().forEach((t) => t.stop());

      // ── 2. Guard: make sure we actually got audio ──────────────────
      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        stream.getTracks().forEach((t) => t.stop());
        setCaptureStatus(null);
        setError('no-audio');
        return;
      }

      // Keep original stream reference for cleanup; record audio-only stream
      streamRef.current = stream;
      const audioOnlyStream = new MediaStream(audioTracks);

      // ── 3. Tell the backend a new session is starting ─────────────
      send(WS_EVENTS.AUDIO_START, { lang });

      // ── 4. Start MediaRecorder ────────────────────────────────────
      const mimeType = pickMimeType();
      let recorder;
      try {
        recorder = new MediaRecorder(audioOnlyStream, mimeType ? { mimeType } : {});
      } catch {
        setCaptureStatus(null);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        setError('recorder-error');
        return;
      }
      recorderRef.current = recorder;
      console.log(`[TAB_AUDIO] MediaRecorder mimeType: "${recorder.mimeType}"`);

      let frontendChunkCount = 0;
      recorder.ondataavailable = async (e) => {
        if (e.data.size > 0) {
          frontendChunkCount++;
          if (frontendChunkCount <= 3) {
            console.log(`[TAB_AUDIO] Chunk #${frontendChunkCount}: ${e.data.size} bytes`);
          }
          const buffer = await e.data.arrayBuffer();
          sendBinary(buffer);
        }
      };

      recorder.onstop = () => {
        send(WS_EVENTS.AUDIO_STOP, {});
        setIsCapturing(false);
        setCaptureStatus('stopped');
      };

      recorder.onerror = () => {
        setError('recorder-error');
        setIsCapturing(false);
        setCaptureStatus(null);
        streamRef.current?.getTracks().forEach((t) => t.stop());
        streamRef.current  = null;
        recorderRef.current = null;
      };

      // User clicks the browser's built-in "Stop sharing" button
      audioTracks[0].onended = () => {
        if (recorderRef.current?.state !== 'inactive') {
          recorderRef.current?.stop();
        }
        setIsCapturing(false);
        setCaptureStatus('stopped');
      };

      try {
        recorder.start(TIMESLICE_MS);
      } catch {
        setCaptureStatus(null);
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current  = null;
        recorderRef.current = null;
        setError('recorder-error');
        return;
      }
      setIsCapturing(true);
      setCaptureStatus('capturing');
    },
    [send, sendBinary],
  );

  // ── Cleanup on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (recorderRef.current?.state !== 'inactive') {
        recorderRef.current?.stop();
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return { isCapturing, captureStatus, start, stop, error, clearError };
}
