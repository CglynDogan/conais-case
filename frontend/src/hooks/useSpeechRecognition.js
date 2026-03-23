/**
 * useSpeechRecognition
 *
 * Wraps the browser Web Speech API.
 * Chrome-targeted: uses webkitSpeechRecognition as fallback.
 *
 * Restart strategy:
 *   Chrome fires onend even during continuous recognition.
 *   When shouldBeListening is true and onend fires, we schedule a restart.
 *   Restart counter resets on any successful result.
 *   'not-allowed' and manual stop never trigger a restart.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 400;

/**
 * @param {object} opts
 * @param {(result: { text: string, confidence: number, lang: string, ts: number }) => void} opts.onFinalResult
 * @param {(text: string) => void} [opts.onInterimResult]
 */
export function useSpeechRecognition({ onFinalResult, onInterimResult } = {}) {
  const [isListening, setIsListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  // null | 'unsupported' | 'not-allowed' | 'error'
  const [error, setError] = useState(null);

  const recognitionRef = useRef(null);
  const shouldBeListeningRef = useRef(false);
  const langRef = useRef('tr-TR');
  const restartCountRef = useRef(0);
  const restartTimerRef = useRef(null);

  // Keep callbacks stable via refs
  const onFinalResultRef = useRef(onFinalResult);
  const onInterimResultRef = useRef(onInterimResult);
  onFinalResultRef.current = onFinalResult;
  onInterimResultRef.current = onInterimResult;

  const isSupported =
    typeof window !== 'undefined' &&
    Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);

  // ── Build a fresh recognition instance ──────────────────────────
  const buildRecognition = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = langRef.current;
    r.maxAlternatives = 1;
    return r;
  }, []);

  // ── Restart scheduling ───────────────────────────────────────────
  const scheduleRestart = useCallback(() => {
    if (!shouldBeListeningRef.current) return;

    if (restartCountRef.current >= MAX_RESTART_ATTEMPTS) {
      console.warn('[STT] Max restart attempts reached — giving up');
      setError('error');
      setIsListening(false);
      shouldBeListeningRef.current = false;
      return;
    }

    restartCountRef.current += 1;
    clearTimeout(restartTimerRef.current);
    restartTimerRef.current = setTimeout(() => {
      if (!shouldBeListeningRef.current) return;
      console.log(`[STT] Restarting… (attempt ${restartCountRef.current})`);
      try {
        // Always build a fresh instance — reusing a stopped instance is unreliable
        const r = buildRecognition();
        attachHandlers(r); // eslint-disable-line no-use-before-define
        recognitionRef.current = r;
        r.start();
      } catch (e) {
        console.error('[STT] Restart failed:', e.message);
        scheduleRestart();
      }
    }, RESTART_DELAY_MS);
  }, [buildRecognition]); // attachHandlers added via closure — defined below

  // ── Attach event handlers ────────────────────────────────────────
  // Defined with useCallback so it can reference scheduleRestart
  const attachHandlers = useCallback(
    (r) => {
      r.onstart = () => {
        console.log('[STT] Started, lang:', r.lang);
        setIsListening(true);
        setError(null);
      };

      r.onresult = (event) => {
        restartCountRef.current = 0; // successful result — reset counter
        let interim = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const text = result[0].transcript;

          if (result.isFinal) {
            setInterimText('');
            const finalPayload = {
              text: text.trim(),
              confidence: result[0].confidence ?? null,
              lang: langRef.current,
              ts: Date.now(),
            };
            console.log('[STT] Final:', finalPayload.text);
            onFinalResultRef.current?.(finalPayload);
          } else {
            interim += text;
          }
        }

        if (interim) {
          setInterimText(interim);
          onInterimResultRef.current?.(interim);
        }
      };

      r.onend = () => {
        console.log('[STT] onend fired, shouldBeListening:', shouldBeListeningRef.current);
        setInterimText('');
        if (shouldBeListeningRef.current) {
          scheduleRestart();
        } else {
          setIsListening(false);
        }
      };

      r.onerror = (event) => {
        const code = event.error;
        console.warn('[STT] Error:', code);

        if (code === 'not-allowed' || code === 'service-not-allowed') {
          setError('not-allowed');
          setIsListening(false);
          shouldBeListeningRef.current = false;
          return;
        }

        if (code === 'aborted') {
          // Expected when stop() is called manually — not an error
          return;
        }

        if (code === 'no-speech') {
          // Browser silence timeout — expected when no one is speaking.
          // Reset the counter so repeated silence periods never exhaust restart attempts.
          restartCountRef.current = 0;
          return; // let onend handle the transparent restart
        }

        // network, audio-capture: let onend handle restart
      };
    },
    [scheduleRestart],
  );

  // ── Public API ───────────────────────────────────────────────────

  const start = useCallback(
    (lang = 'tr-TR') => {
      if (!isSupported) {
        setError('unsupported');
        return;
      }

      langRef.current = lang;
      shouldBeListeningRef.current = true;
      restartCountRef.current = 0;
      setError(null);

      const r = buildRecognition();
      attachHandlers(r);
      recognitionRef.current = r;

      try {
        r.start();
      } catch (e) {
        console.error('[STT] start() failed:', e.message);
      }
    },
    [isSupported, buildRecognition, attachHandlers],
  );

  const stop = useCallback(() => {
    shouldBeListeningRef.current = false;
    clearTimeout(restartTimerRef.current);
    restartCountRef.current = 0;
    setInterimText('');
    setIsListening(false);
    try {
      recognitionRef.current?.stop();
    } catch {
      // ignore InvalidStateError if already stopped
    }
  }, []);

  // ── Cleanup on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      shouldBeListeningRef.current = false;
      clearTimeout(restartTimerRef.current);
      try {
        recognitionRef.current?.stop();
      } catch {}
    };
  }, []);

  return {
    isListening,
    interimText,
    error,
    isSupported,
    start,
    stop,
  };
}
