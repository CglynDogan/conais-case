import { useState, useCallback, useEffect } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { useTabAudio } from './hooks/useTabAudio';
import { TranscriptBar } from './components/TranscriptBar';
import { WS_EVENTS } from './constants';
import './App.css';

// ── Display maps ────────────────────────────────────────────────────

const CONN_LABEL = {
  connecting:   'Connecting…',
  connected:    'Connected',
  disconnected: 'Disconnected',
  error:        'Connection error',
};
const CONN_COLOR = {
  connecting:   '#f59e0b',
  connected:    '#22c55e',
  disconnected: '#6b7280',
  error:        '#ef4444',
};
const MIC_ERROR_MSG = {
  'not-allowed': 'Microphone access denied. Check browser permissions.',
  unsupported:   'Web Speech API is not supported in this browser. Use Chrome.',
  error:         'Speech recognition stopped unexpectedly.',
};

const CAPTURE_ERROR_MSG = {
  'not-allowed':              'Tab sharing cancelled or denied. Try again and allow access.',
  'no-audio':                 'No audio captured. Check the "Share audio" box when selecting the tab.',
  unsupported:                'Tab audio capture is not supported on macOS Chrome. Use Chrome on Windows, or use Mic mode instead.',
  'recorder-error':           'MediaRecorder failed to start. Try a different tab or reload.',
  error:                      'Audio capture failed unexpectedly.',
  'deepgram-not-configured':  'Deepgram API key not set — transcription unavailable.',
  'stt-error':                'Transcription error — audio stream interrupted.',
  'stt-disconnected':         'Transcription stream disconnected unexpectedly.',
};

const CAPTURE_STATUS_MSG = {
  requesting: 'In the picker: select your Jitsi/call tab — not this coaching tab — then check "Share audio"',
  capturing:  'Streaming tab audio',
  stopped:    'Capture stopped',
};

// Rule-based signal colors and labels
const TONE_COLOR = {
  price_objection: '#ef4444',
  too_fast:        '#f59e0b',
  long_monologue:  '#f59e0b',
};
const TONE_LABEL = {
  price_objection: 'Price Objection',
  too_fast:        'Speaking Too Fast',
  long_monologue:  'Long Monologue',
};

const LANGUAGES = ['tr-TR', 'en-US'];

// Rule-based signal auto-clears after this many ms to avoid stale hints
const RULE_HINT_TTL_MS = 8_000;

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  // ── Analysis state ─────────────────────────────────────────────
  // Rule-based signal (source: 'rule') — immediate, every utterance
  const [ruleSignal, setRuleSignal] = useState(null);
  // LLM result (source: 'llm') — batched, every ~3 utterances
  const [llmResult,  setLlmResult]  = useState(null);

  // ── Transcript / demo ──────────────────────────────────────────
  const [lang, setLang]             = useState('tr-TR');
  const [finalLines, setFinalLines] = useState([]);
  const [demoLines, setDemoLines]   = useState([]);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // ── Twilio call state ───────────────────────────────────────────
  // null when no call active; { callSid, lang } when a Twilio call is live
  const [callState,   setCallState]   = useState(null);
  const [callElapsed, setCallElapsed] = useState(0);

  // Auto-clear rule hint after TTL to avoid stale signals
  useEffect(() => {
    if (!ruleSignal) return;
    const id = setTimeout(() => setRuleSignal(null), RULE_HINT_TTL_MS);
    return () => clearTimeout(id);
  }, [ruleSignal]);

  // Elapsed timer — counts seconds while a call is active
  useEffect(() => {
    if (!callState) {
      setCallElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      setCallElapsed((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [callState]);

  // ── Audio error (server-side: e.g. Deepgram key missing) ───────
  const [audioError, setAudioError] = useState(null);

  // ── Last WS event (system panel) ───────────────────────────────
  const [lastEventSummary, setLastEventSummary] = useState(null);

  // ── WS message handler ──────────────────────────────────────────
  const handleWsMessage = useCallback((msg) => {
    setLastEventSummary({ type: msg.type, source: msg.payload?.source ?? null });

    if (msg.type === WS_EVENTS.ANALYSIS_UPDATE) {
      if (msg.payload?.source === 'rule') setRuleSignal(msg.payload);
      if (msg.payload?.source === 'llm')  setLlmResult(msg.payload);
    }
    if (msg.type === WS_EVENTS.TRANSCRIPT_FINAL && msg.payload?.text) {
      setDemoLines((prev) => [...prev, msg.payload.text]);
    }
    if (msg.type === WS_EVENTS.CALL_STARTED) {
      resetSession();
      setCallState({ callSid: msg.payload?.callSid, lang: msg.payload?.lang });
    }
    if (msg.type === WS_EVENTS.CALL_ENDED) {
      setCallState(null);
    }
    if (msg.type === WS_EVENTS.AUDIO_ERROR) {
      setAudioError(msg.payload?.reason ?? 'error');
    }
  }, []);

  const { status: connStatus, send, sendBinary } = useWebSocket(handleWsMessage);

  // ── Speech recognition ──────────────────────────────────────────
  const handleFinalResult = useCallback(
    (result) => {
      setFinalLines((prev) => [...prev, result.text]);
      send(WS_EVENTS.TRANSCRIPT_FINAL, {
        text:       result.text,
        confidence: result.confidence,
        lang:       result.lang,
        ts:         result.ts,
      });
    },
    [send],
  );
  const handleInterimResult = useCallback(
    (text) => { send(WS_EVENTS.TRANSCRIPT_INTERIM, { text, ts: Date.now() }); },
    [send],
  );

  const { isListening, interimText, error: micError, isSupported, start, stop } =
    useSpeechRecognition({ onFinalResult: handleFinalResult, onInterimResult: handleInterimResult });

  // ── Browser-call mode (tab audio capture) ───────────────────────
  const {
    isCapturing,
    captureStatus,
    start:      startCapture,
    stop:       stopCapture,
    error:      captureError,
    clearError: clearCaptureError,
  } = useTabAudio({ send, sendBinary });

  // ── Controls ────────────────────────────────────────────────────
  const resetSession = () => {
    setRuleSignal(null);
    setLlmResult(null);
    setFinalLines([]);
    setDemoLines([]);
  };

  const handleToggleListen = () => {
    if (isListening) {
      stop();
    } else {
      clearCaptureError();
      setAudioError(null);
      resetSession();
      setIsDemoMode(false);
      start(lang);
    }
  };

  const handleLangToggle = () => {
    const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
    setLang(next);
    if (isListening) { stop(); setTimeout(() => start(next), 200); }
  };

  const handleStartBrowserCall = async () => {
    if (isListening) stop();
    if (isCapturing) stopCapture();
    clearCaptureError();
    setAudioError(null);
    resetSession();
    setIsDemoMode(false);
    await startCapture(lang);
  };

  const handleStopBrowserCall = () => {
    stopCapture();
  };

  const handleDemo = () => {
    if (isListening) stop();
    if (isCapturing) stopCapture();
    clearCaptureError();
    setAudioError(null);
    resetSession();
    setIsDemoMode(true);
    send(WS_EVENTS.DEMO_TRIGGER, { lang });
  };

  // ── Derived display values ──────────────────────────────────────
  const feedback    = llmResult?.feedback            ?? '';
  const suggestions = llmResult?.suggested_questions ?? [];
  const infoCard    = llmResult?.info_card           ?? null;

  const visibleLines = (isDemoMode || isCapturing || !!callState) ? demoLines : finalLines;

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── Header ── */}
      <header className="app-header">
        <h1 className="app-title">Sales Call Coach</h1>
        <div className="header-right">
          {callState && (
            <div className="conn-status" style={{ background: '#7c3aed' }} title={`Call SID: ${callState.callSid}`}>
              <span className="conn-dot" style={{ background: '#fff', animation: 'pulse 1.2s infinite' }} />
              Live Call {String(Math.floor(callElapsed / 60)).padStart(2, '0')}:{String(callElapsed % 60).padStart(2, '0')}
            </div>
          )}
          <button
            className="btn btn--demo"
            onClick={handleDemo}
            disabled={connStatus !== 'connected' || !!callState}
            title={callState ? 'Demo unavailable during a live call' : 'Run scripted demo'}
          >
            Demo
          </button>
          <div className="conn-status" style={{ background: CONN_COLOR[connStatus] }}>
            <span className="conn-dot" />
            {CONN_LABEL[connStatus]}
          </div>
        </div>
      </header>

      <main className="app-main">

        {/* ── Row 1: Coaching Feedback + Suggested Questions ── */}
        <div className="row">

          {/* Coaching Feedback */}
          <div className="panel panel--coaching">
            <span className="panel-label">Coaching</span>

            {!ruleSignal && !feedback && (
              <p className="panel-placeholder">
                Coaching signals will appear here once the conversation starts.
              </p>
            )}

            {/* Rule-based signal — immediate */}
            {ruleSignal && (
              <div
                className="coaching-signal"
                style={{ borderColor: TONE_COLOR[ruleSignal.tone_alert?.type] ?? '#64748b' }}
              >
                <span
                  className="coaching-signal__type"
                  style={{ color: TONE_COLOR[ruleSignal.tone_alert?.type] ?? '#64748b' }}
                >
                  {TONE_LABEL[ruleSignal.tone_alert?.type] ?? ruleSignal.tone_alert?.type}
                </span>
                <span className="coaching-signal__message">{ruleSignal.tone_alert?.message}</span>
                <span className="coaching-signal__tag">rule-based</span>
              </div>
            )}

            {/* LLM feedback — batched */}
            {feedback && (
              <div className="coaching-signal coaching-signal--llm">
                <span className="coaching-signal__message">{feedback}</span>
                <span className="coaching-signal__tag">AI coach</span>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          <div className="panel panel--suggestions">
            <span className="panel-label">Suggested Questions</span>
            {suggestions.length > 0 ? (
              <ol className="suggestion-list">
                {suggestions.map((q, i) => (
                  <li key={i} className="suggestion-card">{q}</li>
                ))}
              </ol>
            ) : (
              <p className="panel-placeholder">Follow-up question ideas will appear here.</p>
            )}
          </div>
        </div>

        {/* ── Row 2: Info Card — shown only when LLM returns one ── */}
        {infoCard && (
          <div className="panel panel--info">
            <span className="panel-label">Quick Reference</span>
            <p className="info-card__term">{infoCard.term}</p>
            <p className="info-card__note">{infoCard.note}</p>
          </div>
        )}

        {/* ── Row 3: Transcript (secondary) ── */}
        <div className="panel panel--transcript">
          <div className="transcript-header">
            <span className="panel-label">
              {isDemoMode
                ? 'Demo Transcript'
                : isCapturing
                  ? 'Browser Call'
                  : callState
                    ? 'Live Call Transcript'
                    : 'Live Transcript'}
            </span>
            <div className="mic-controls">
              {/* Language toggle — hidden during demo or browser-call capture */}
              {!isDemoMode && !isCapturing && (
                <button className="btn btn--ghost" onClick={handleLangToggle} title="Toggle language">
                  {lang}
                </button>
              )}

              {/* Browser-call mode controls */}
              {!isDemoMode && (
                isCapturing ? (
                  <button className="btn btn--stop" onClick={handleStopBrowserCall}>
                    ⏹ Stop Capture
                  </button>
                ) : (
                  <button
                    className="btn btn--browser"
                    onClick={handleStartBrowserCall}
                    disabled={connStatus !== 'connected' || isListening || !!callState || captureStatus === 'requesting'}
                    title="Capture browser tab audio (Jitsi, Meet, etc.)"
                  >
                    🖥 Browser Call
                  </button>
                )
              )}

              {/* Mic mode controls — hidden while capturing or in demo */}
              {!isDemoMode && !isCapturing && (
                !isSupported ? (
                  <span className="mic-unsupported">Chrome required for microphone</span>
                ) : (
                  <button
                    className={`btn ${isListening ? 'btn--stop' : 'btn--start'}`}
                    onClick={handleToggleListen}
                    disabled={!!callState}
                    title={callState ? 'Mic unavailable during a live call' : undefined}
                  >
                    {isListening ? '⏹ Stop' : '🎙 Start'}
                  </button>
                )
              )}

              {/* Demo exit */}
              {isDemoMode && (
                <button className="btn btn--ghost" onClick={() => {
                  setIsDemoMode(false);
                  setDemoLines([]);
                }}>
                  Exit Demo
                </button>
              )}
            </div>
          </div>
          {captureStatus && !captureError && !audioError && (
            <p className="capture-status">{CAPTURE_STATUS_MSG[captureStatus]}</p>
          )}
          {micError && (
            <p className="mic-error">{MIC_ERROR_MSG[micError] ?? 'Unknown microphone error.'}</p>
          )}
          {(captureError || audioError) && (
            <p className="mic-error">
              {CAPTURE_ERROR_MSG[captureError ?? audioError] ?? 'Audio capture error.'}
            </p>
          )}
          {(isListening || isCapturing || isDemoMode || visibleLines.length > 0) ? (
            <TranscriptBar
              finalLines={visibleLines}
              interimText={(isDemoMode || isCapturing) ? '' : interimText}
            />
          ) : (
            <p className="panel-placeholder">
              Press 🎙 Start to use your mic, 🖥 Browser Call to capture tab audio, or run Demo.
            </p>
          )}
        </div>

        {/* ── Row 4: Connection / system ── */}
        <div className="panel panel--connection">
          <div className="connection-row">
            <span className="panel-label" style={{ marginBottom: 0 }}>Connection</span>
            <div className="connection-actions">
              <button
                className="btn btn--ghost"
                onClick={() => send(WS_EVENTS.CLIENT_PING, { ts: Date.now() })}
                disabled={connStatus !== 'connected'}
              >
                Ping
              </button>
            </div>
            {lastEventSummary && (
              <span className="last-event">
                Last: <code>{lastEventSummary.type}</code>
                {lastEventSummary.source && <> · <code>{lastEventSummary.source}</code></>}
              </span>
            )}
          </div>
        </div>

      </main>
    </div>
  );
}
