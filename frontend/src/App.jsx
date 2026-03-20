import { useState, useCallback, useEffect, useRef } from 'react';
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
  capturing:  'Streaming tab audio + microphone',
  stopped:    'Capture stopped',
};

// Coaching signal colors and labels (rule-based)
const SIGNAL_COLOR = {
  // ── Guardrails (conversation safety) ───────────────────────
  emotionally_escalated: '#ef4444', // red   — de-escalate immediately
  overwhelmed:           '#8b5cf6', // violet — simplify
  customer_closing:      '#f97316', // orange — stop pushing
  // ── Sales coaching signals ──────────────────────────────────
  price_objection:       '#ef4444', // red
  over_persuading:       '#f59e0b', // amber
  too_fast:              '#f59e0b', // amber
  long_monologue:        '#f59e0b', // amber
};
const SIGNAL_LABEL = {
  emotionally_escalated: 'Escalated',
  overwhelmed:           'Overwhelmed',
  customer_closing:      'Closing Signal',
  price_objection:       'Price Objection',
  over_persuading:       'Over-Persuading',
  too_fast:              'Speaking Too Fast',
  long_monologue:        'Long Monologue',
};

const LANGUAGES = ['tr-TR', 'en-US'];

const SESSION_MODE_LABEL = {
  mic:          'Mic Mode',
  'browser-call': 'Browser Call',
  demo:         'Demo',
};

function exportTranscript({ lines, mode, feedback, suggestions }) {
  const now    = new Date();
  const ts     = now.toISOString().replace('T', ' ').slice(0, 19);
  const fname  = `transcript-${ts.replace(/[: ]/g, '-')}.md`;
  const mLabel = SESSION_MODE_LABEL[mode] ?? 'Unknown';

  const body = lines.map((line) => {
    const text    = typeof line === 'string' ? line : line.text;
    const speaker = typeof line === 'string' ? null  : line.speaker;
    const prefix  = speaker === 'me' ? 'Ben: ' : speaker === 'customer' ? 'Müşteri: ' : '';
    return `${prefix}${text}`;
  }).join('\n');

  let md = `# Coaching Session Transcript\n\nDate: ${ts}\nMode: ${mLabel}\n\n---\n\n## Conversation\n\n${body}`;

  if (feedback) {
    md += `\n\n---\n\n## Last Coaching Advice\n\n${feedback}`;
  }
  if (suggestions.length > 0) {
    md += `\n\n## Suggested Questions\n\n${suggestions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
  }

  const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
  const a   = Object.assign(document.createElement('a'), { href: url, download: fname });
  a.click();
  URL.revokeObjectURL(url);
}

// Lightweight keyword heuristic for question intent labels.
// Returns a short tag or null — no backend field, no invented intelligence.
function getQuestionIntent(text) {
  const t = text.toLowerCase();
  if (/bütçe|budget|cost|fiyat|maliyet|roi|return|kazan|tasarruf|saving/.test(t)) return 'Değer / ROI';
  if (/karar|decide|decision|ne zaman|when|timeline|süreç|adım/.test(t))          return 'Karar';
  if (/engel|obstacle|concern|sorun|problem|challenge|neden değil/.test(t))        return 'Engel';
  if (/acil|urgent|öncelik|priority|critical/.test(t))                             return 'Öncelik';
  if (/başarı|success|hedef|goal|metric|ölçüt|kriter/.test(t))                    return 'Başarı';
  return null;
}

// Rule-based signal auto-clears after this many ms to avoid stale hints
const RULE_HINT_TTL_MS = 8_000;

// ── Echo dedup helpers ───────────────────────────────────────────────
// When Browser Call dual-input is active, the user's own voice enters
// via both the local mic (Web Speech API) and the tab audio (Deepgram).
// This normalises text for comparison and checks for a recent mic match.

const MIC_ECHO_WINDOW_MS = 6_000;

function normalizeForDedup(text) {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

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

  // Auto-clear rule hint after TTL to avoid stale signals
  useEffect(() => {
    if (!ruleSignal) return;
    const id = setTimeout(() => setRuleSignal(null), RULE_HINT_TTL_MS);
    return () => clearTimeout(id);
  }, [ruleSignal]);

  // ── Session mode — persists after stop for export metadata ────
  const [sessionMode, setSessionMode] = useState(null);

  // ── Browser call dual-input refs ────────────────────────────────
  // Tracks whether Browser Call mode is active so handleFinalResult
  // can route mic finals to demoLines (merged with tab audio) without
  // depending on isCapturing state, which would create a circular dep.
  const isBrowserCallModeRef = useRef(false);
  const browserCallLangRef   = useRef('tr-TR');
  // Circular buffer of recent mic finals used for echo dedup.
  // Entries: { normalized: string, ts: number }
  const recentMicFinalsRef   = useRef([]);

  // ── Audio error (server-side: e.g. Deepgram key missing) ───────
  const [audioError, setAudioError] = useState(null);

  // ── Last WS event (system panel) ───────────────────────────────
  const [lastEventSummary, setLastEventSummary] = useState(null);

  // ── WS message handler ──────────────────────────────────────────
  const handleWsMessage = useCallback((msg) => {
    setLastEventSummary({ type: msg.type, source: msg.payload?.source ?? null });

    if (msg.type === WS_EVENTS.ANALYSIS_UPDATE) {
      if (msg.payload?.source === 'rule') setRuleSignal(msg.payload);
      if (msg.payload?.source === 'llm') {
        setLlmResult((prev) => ({
          ...msg.payload,
          // Retain previous non-empty feedback/questions if the new result is empty
          feedback:            msg.payload.feedback?.trim()              || prev?.feedback            || '',
          suggested_questions: msg.payload.suggested_questions?.length   ? msg.payload.suggested_questions
                                                                         : (prev?.suggested_questions ?? []),
        }));
      }
    }
    if (msg.type === WS_EVENTS.TRANSCRIPT_FINAL && msg.payload?.text) {
      // During browser call dual-input: suppress Deepgram turns that exactly match
      // a recent mic final — those are the user's own voice echoed through the tab.
      // Exact-match only (after normalisation); partial overlaps are not suppressed
      // because that risks silencing genuine remote speech.
      if (isBrowserCallModeRef.current) {
        const norm = normalizeForDedup(msg.payload.text);
        const now  = Date.now();
        const isEcho = recentMicFinalsRef.current.some(
          (e) => now - e.ts < MIC_ECHO_WINDOW_MS && e.normalized === norm,
        );
        if (isEcho) return;
      }
      setDemoLines((prev) => [...prev, { text: msg.payload.text, speaker: msg.payload.speaker ?? 'unknown', ts: msg.payload.ts ?? Date.now() }]);
    }
    if (msg.type === WS_EVENTS.AUDIO_ERROR) {
      setAudioError(msg.payload?.reason ?? 'error');
    }
  }, []);

  const { status: connStatus, send, sendBinary } = useWebSocket(handleWsMessage);

  // ── Speech recognition ──────────────────────────────────────────
  const handleFinalResult = useCallback(
    (result) => {
      // During Browser Call: mic turns merge into demoLines alongside tab audio.
      // Outside Browser Call: mic turns go to finalLines (mic-only session).
      if (isBrowserCallModeRef.current) {
        setDemoLines((prev) => [...prev, { text: result.text, speaker: 'me', ts: result.ts }]);
        // Record this mic final so the echo dedup in handleWsMessage can filter
        // the same speech when Deepgram returns it from the tab audio stream.
        const now = Date.now();
        recentMicFinalsRef.current = [
          ...recentMicFinalsRef.current.filter((e) => now - e.ts < MIC_ECHO_WINDOW_MS),
          { normalized: normalizeForDedup(result.text), ts: now },
        ];
      } else {
        setFinalLines((prev) => [...prev, { text: result.text, speaker: 'me', ts: result.ts }]);
      }
      send(WS_EVENTS.TRANSCRIPT_FINAL, {
        text:       result.text,
        confidence: result.confidence,
        lang:       result.lang,
        ts:         result.ts,
        speaker:    'agent',  // mic = salesperson
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

  // ── Browser call: auto-start mic when capture goes live ─────────
  // useTabAudio.start() is async and doesn't return a success signal,
  // so we watch isCapturing to know when the tab stream is actually live.
  const prevIsCapturingRef = useRef(false);
  useEffect(() => {
    const wasCapturing = prevIsCapturingRef.current;
    prevIsCapturingRef.current = isCapturing;

    if (!isBrowserCallModeRef.current) return;

    if (!wasCapturing && isCapturing) {
      // Tab capture just went live — start mic alongside it
      start(browserCallLangRef.current);
    } else if (wasCapturing && !isCapturing) {
      // Tab capture ended (user stopped or browser "Stop sharing" button)
      isBrowserCallModeRef.current = false;
      stop();
    }
  }, [isCapturing]); // start/stop are stable useCallback refs

  // ── Controls ────────────────────────────────────────────────────
  const resetSession = () => {
    setRuleSignal(null);
    setLlmResult(null);
    setFinalLines([]);
    setDemoLines([]);
    recentMicFinalsRef.current = [];
  };

  const handleToggleListen = () => {
    if (isListening) {
      stop();
    } else {
      clearCaptureError();
      setAudioError(null);
      resetSession();
      setIsDemoMode(false);
      setSessionMode('mic');
      start(lang);
    }
  };

  const handleLangToggle = () => {
    const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
    setLang(next);
    if (isListening) { stop(); setTimeout(() => start(next), 200); }
  };

  const handleStartBrowserCall = async () => {
    // Stop any existing mic or capture sessions cleanly before resetting
    if (isListening) stop();
    if (isCapturing) stopCapture();
    clearCaptureError();
    setAudioError(null);
    resetSession();
    setIsDemoMode(false);
    setSessionMode('browser-call');
    browserCallLangRef.current = lang;
    isBrowserCallModeRef.current = true;
    // Mic auto-starts via useEffect once isCapturing becomes true (after picker)
    await startCapture(lang);
  };

  const handleStopBrowserCall = () => {
    isBrowserCallModeRef.current = false;
    stopCapture();
    stop(); // stop mic that was auto-started with the capture
  };

  const handleDemo = () => {
    if (isListening) stop();
    if (isCapturing) stopCapture();
    clearCaptureError();
    setAudioError(null);
    resetSession();
    setIsDemoMode(true);
    setSessionMode('demo');
    send(WS_EVENTS.DEMO_TRIGGER, { lang });
  };

  // ── Derived display values ──────────────────────────────────────
  const feedback    = llmResult?.feedback            ?? '';
  const suggestions = llmResult?.suggested_questions ?? [];
  const infoCard    = llmResult?.info_card           ?? null;

  // After Browser Call stops, isCapturing becomes false and we'd fall to finalLines (empty).
  // Fall back to demoLines so transcript stays visible after stop.
  // Sort by ts so mic and tab audio entries interleave chronologically rather than by arrival order.
  const rawVisibleLines = (isDemoMode || isCapturing)
    ? demoLines
    : finalLines.length > 0 ? finalLines : demoLines;
  const visibleLines = rawVisibleLines.slice().sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  // True when no session is actively running — show export button
  const isSessionIdle = !isListening && !isCapturing && !isDemoMode;

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="app">

      {/* ── Header ── */}
      <header className="app-header">
        <h1 className="app-title">Sales Call Coach</h1>
        <div className="header-right">
          <button
            className="btn btn--demo"
            onClick={handleDemo}
            disabled={connStatus !== 'connected'}
            title="Run scripted demo"
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

        {/* ── 1. Primary AI Coaching Card ── */}
        <div className="panel coaching-card">
          <div className="coaching-card__header">
            <span className="panel-label" style={{ marginBottom: 0 }}>AI Coaching</span>
            <span className="coaching-card__badge">AI Coach</span>
          </div>
          {feedback ? (
            <p className="coaching-card__text">{feedback}</p>
          ) : (
            <p className="panel-placeholder coaching-card__empty">
              Coaching advice will appear once the conversation starts.
            </p>
          )}
        </div>

        {/* ── 2. Warning Chips — rule-based signals, auto-expire ── */}
        {ruleSignal && (
          <div className="warning-row">
            <div
              className="warning-chip"
              style={{
                borderColor: (SIGNAL_COLOR[ruleSignal.tone_alert?.type] ?? '#64748b') + '55',
                background:  (SIGNAL_COLOR[ruleSignal.tone_alert?.type] ?? '#64748b') + '18',
              }}
            >
              <span className="warning-chip__dot" style={{ background: SIGNAL_COLOR[ruleSignal.tone_alert?.type] ?? '#64748b' }} />
              <span className="warning-chip__label" style={{ color: SIGNAL_COLOR[ruleSignal.tone_alert?.type] ?? '#94a3b8' }}>
                {SIGNAL_LABEL[ruleSignal.tone_alert?.type] ?? ruleSignal.tone_alert?.type}
              </span>
              {ruleSignal.tone_alert?.message && (
                <span className="warning-chip__msg">{ruleSignal.tone_alert.message}</span>
              )}
            </div>
          </div>
        )}

        {/* ── 3. Suggested Next Questions ── */}
        <div className="panel panel--suggestions">
          <span className="panel-label">Suggested Next Questions</span>
          {suggestions.length > 0 ? (
            <div className="sq-cards">

              {/* Primary — recommended next question */}
              <div className="sq-primary">
                <div className="sq-primary__meta">
                  <span className="sq-badge sq-badge--recommended">Recommended</span>
                  {getQuestionIntent(suggestions[0]) && (
                    <span className="sq-badge sq-badge--intent">{getQuestionIntent(suggestions[0])}</span>
                  )}
                </div>
                <p className="sq-primary__text">{suggestions[0]}</p>
              </div>

              {/* Alternatives — secondary options */}
              {suggestions.slice(1).map((q, i) => (
                <div key={i + 1} className="sq-alt">
                  <div className="sq-alt__meta">
                    <span className="sq-alt__label">Alternative</span>
                    {getQuestionIntent(q) && (
                      <span className="sq-badge sq-badge--intent">{getQuestionIntent(q)}</span>
                    )}
                  </div>
                  <p className="sq-alt__text">{q}</p>
                </div>
              ))}

            </div>
          ) : (
            <p className="panel-placeholder">Follow-up question ideas will appear once AI has enough context.</p>
          )}
        </div>

        {/* ── 4. Info Card — shown only when LLM returns one ── */}
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
                  ? (isListening ? 'Browser Call · Mic + Tab' : 'Browser Call')
                  : isSessionIdle && visibleLines.length > 0
                    ? `${SESSION_MODE_LABEL[sessionMode] ?? 'Session'} — Ended`
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
                    disabled={connStatus !== 'connected' || isListening || captureStatus === 'requesting'}
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

              {/* Export — shown when idle and transcript has content */}
              {isSessionIdle && visibleLines.length > 0 && (
                <button
                  className="btn btn--export"
                  onClick={() => exportTranscript({ lines: visibleLines, mode: sessionMode, feedback, suggestions })}
                  title="Download transcript as Markdown"
                >
                  ⬇ Export
                </button>
              )}
            </div>
          </div>
          {captureStatus && !captureError && !audioError && (
            <p className="capture-status">{CAPTURE_STATUS_MSG[captureStatus]}</p>
          )}
          {isCapturing && isListening && (
            <p className="capture-note">
              Exact duplicates of your speech are filtered. Near-duplicates and ordering gaps may still occur.
            </p>
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
              interimText={isDemoMode ? '' : interimText}
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
