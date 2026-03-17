import { useState, useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useSpeechRecognition } from './hooks/useSpeechRecognition';
import { TranscriptBar } from './components/TranscriptBar';
import { WS_EVENTS } from './constants';
import './App.css';

// ── Display maps ───────────────────────────────────────────────────

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
// Rule-based signal colors by type
const TONE_COLOR = {
  normal:          '#64748b',
  positive:        '#16a34a',
  too_fast:        '#f59e0b',
  long_monologue:  '#f59e0b',
  price_objection: '#ef4444',
  off_topic:       '#8b5cf6',
};
// Human-readable labels for heuristic signal types
const TONE_LABEL = {
  price_objection: 'Price Objection',
  too_fast:        'Speaking Too Fast',
  long_monologue:  'Long Monologue',
  off_topic:       'Off Topic',
  positive:        'Positive Signal',
  normal:          'Normal',
};
// LLM priority colors
const PRIORITY_COLOR = {
  high:   '#ef4444',
  medium: '#6366f1',
  low:    '#64748b',
};
// Human-readable priority labels
const PRIORITY_LABEL = {
  high:   'Action Needed',
  medium: 'Suggestion',
  low:    'Note',
};

const LANGUAGES = ['tr-TR', 'en-US'];

// ── App ───────────────────────────────────────────────────────────

export default function App() {
  // ── WebSocket ──────────────────────────────────────────────
  const [lastEventSummary, setLastEventSummary] = useState(null);

  // Rule-based signal (source: 'rule') — immediate, every utterance
  const [ruleSignal, setRuleSignal]   = useState(null);
  // LLM result (source: 'llm') — batched, every ~3 utterances
  const [llmResult,  setLlmResult]    = useState(null);
  // Lines echoed back from demo playback
  const [demoLines, setDemoLines]     = useState([]);

  const handleWsMessage = useCallback((msg) => {
    setLastEventSummary({ type: msg.type, source: msg.payload?.source ?? null, ts: Date.now() });

    if (msg.type === WS_EVENTS.ANALYSIS_UPDATE) {
      if (msg.payload?.source === 'rule') setRuleSignal(msg.payload);
      if (msg.payload?.source === 'llm')  setLlmResult(msg.payload);
    }
    // Demo mode: server echoes transcript:final lines back — show them in transcript
    if (msg.type === WS_EVENTS.TRANSCRIPT_FINAL && msg.payload?.text) {
      setDemoLines((prev) => [...prev, msg.payload.text]);
    }
  }, []);

  const { status: connStatus, send } = useWebSocket(handleWsMessage);

  // ── Transcript state ───────────────────────────────────────
  const [lang, setLang]             = useState('tr-TR');
  const [finalLines, setFinalLines] = useState([]);
  const [isDemoMode, setIsDemoMode] = useState(false);

  // ── Speech recognition ─────────────────────────────────────
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

  const handleToggleListen = () => {
    if (isListening) {
      stop();
    } else {
      setFinalLines([]);
      setDemoLines([]);
      setRuleSignal(null);
      setLlmResult(null);
      setIsDemoMode(false);
      start(lang);
    }
  };

  const handleLangToggle = () => {
    const next = LANGUAGES[(LANGUAGES.indexOf(lang) + 1) % LANGUAGES.length];
    setLang(next);
    if (isListening) { stop(); setTimeout(() => start(next), 200); }
  };

  const handleDemo = () => {
    if (isListening) stop();
    setFinalLines([]);
    setDemoLines([]);
    setRuleSignal(null);
    setLlmResult(null);
    setIsDemoMode(true);
    send(WS_EVENTS.DEMO_TRIGGER, { lang });
  };

  // ── Derive display values ──────────────────────────────────
  const suggestions = llmResult?.suggested_questions ?? [];
  const infoCard    = llmResult?.info_card ?? null;
  const llmMessage  = llmResult?.coach_message ?? '';

  // Combined transcript: live lines during speech, demo lines during demo
  const visibleLines = isDemoMode ? demoLines : finalLines;

  // ── Render ─────────────────────────────────────────────────
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

        {/* Row 1: Coaching Feedback + Suggested Questions */}
        <div className="row">

          {/* Coaching Feedback */}
          <div className="panel panel--coaching">
            <span className="panel-label">Coaching</span>

            {!ruleSignal && !llmMessage && (
              <p className="panel-placeholder">Coaching signals will appear here once the conversation starts.</p>
            )}

            {ruleSignal && (
              <div
                className="coaching-signal"
                style={{ borderColor: TONE_COLOR[ruleSignal.tone_alert?.type] ?? TONE_COLOR.normal }}
              >
                <span
                  className="coaching-signal__type"
                  style={{ color: TONE_COLOR[ruleSignal.tone_alert?.type] ?? TONE_COLOR.normal }}
                >
                  {TONE_LABEL[ruleSignal.tone_alert?.type] ?? ruleSignal.tone_alert?.type}
                </span>
                <span className="coaching-signal__message">{ruleSignal.tone_alert?.message}</span>
                <span className="coaching-signal__tag">rule-based</span>
              </div>
            )}

            {llmMessage && (
              <div
                className="coaching-signal coaching-signal--llm"
                style={{ borderColor: PRIORITY_COLOR[llmResult?.priority] ?? PRIORITY_COLOR.low }}
              >
                <span
                  className="coaching-signal__type"
                  style={{ color: PRIORITY_COLOR[llmResult?.priority] ?? PRIORITY_COLOR.low }}
                >
                  {PRIORITY_LABEL[llmResult?.priority] ?? llmResult?.priority}
                </span>
                <span className="coaching-signal__message">{llmMessage}</span>
                <span className="coaching-signal__tag">AI coach</span>
              </div>
            )}
          </div>

          {/* Suggested Questions */}
          <div className="panel panel--suggestions">
            <span className="panel-label">Suggested Questions</span>
            {suggestions.length > 0 ? (
              <div className="suggestion-list">
                {suggestions.map((q, i) => (
                  <div key={i} className="suggestion-card">
                    {q}
                  </div>
                ))}
              </div>
            ) : (
              <p className="panel-placeholder">Follow-up question ideas will appear here.</p>
            )}
          </div>
        </div>

        {/* Row 2: Info Card — shown only when LLM returns one */}
        {infoCard && (
          <div className="panel panel--info panel--info-active">
            <span className="panel-label">Quick Reference</span>
            <p className="info-card__term">{infoCard.term}</p>
            <p className="info-card__note">{infoCard.note}</p>
          </div>
        )}

        {/* Row 3: Mic Controls + Live Transcript */}
        <div className="panel panel--transcript">
          <div className="transcript-header">
            <span className="panel-label">
              {isDemoMode ? 'Demo Transcript' : 'Live Transcript'}
            </span>
            <div className="mic-controls">
              {!isDemoMode && (
                <button className="btn btn--ghost" onClick={handleLangToggle} title="Toggle language">
                  {lang}
                </button>
              )}
              {!isDemoMode && (
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
          {micError && (
            <p className="mic-error">{MIC_ERROR_MSG[micError] ?? 'Unknown microphone error.'}</p>
          )}
          {(isListening || isDemoMode || visibleLines.length > 0) ? (
            <TranscriptBar
              finalLines={visibleLines}
              interimText={isDemoMode ? '' : interimText}
            />
          ) : (
            <p className="panel-placeholder">Press Start to begin listening, or run Demo.</p>
          )}
        </div>

        {/* Row 4: Connection state */}
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
