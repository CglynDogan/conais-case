import { useEffect, useRef } from 'react';
import './TranscriptBar.css';

/**
 * TranscriptBar
 *
 * Renders transcript lines as chat bubbles.
 *
 * Each line is either a plain string (legacy) or { text, speaker } object.
 * speaker: 'me'       → right side, indigo bubble  (salesperson)
 * speaker: 'customer' → left  side, gray bubble    (customer — requires diarization)
 * speaker: 'unknown'  → left  side, gray bubble    (browser-call: undifferentiated stream)
 *
 * @param {object}         props
 * @param {Array}          props.finalLines   - committed lines: string[] or {text,speaker}[]
 * @param {string}         props.interimText  - in-progress mic recognition (always 'me')
 */
export function TranscriptBar({ finalLines, interimText }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [finalLines, interimText]);

  const isEmpty = finalLines.length === 0 && !interimText;

  return (
    <div className="chat-log">
      {isEmpty ? (
        <span className="chat-empty">Listening…</span>
      ) : (
        <>
          {finalLines.map((line, i) => {
            const text    = typeof line === 'string' ? line : line.text;
            const speaker = typeof line === 'string' ? 'me'  : (line.speaker ?? 'me');

            // Side and bubble class are determined independently so diarized speakers
            // get visual separation without falsely claiming "Ben" (agent) identity.
            //
            //   'me' / 'agent'   → right + indigo  (genuinely known: mic mode)
            //   'customer'       → left  + neutral  (genuinely known: demo mode)
            //   'speaker_0'      → left  + slate    (diarized: first voice, role unknown)
            //   'speaker_1'      → right + blue     (diarized: second voice, role unknown)
            //   'unknown'        → left  + neutral
            const sideClass   = (speaker === 'me' || speaker === 'agent' || speaker === 'speaker_1')
                                  ? 'chat-wrap--me' : 'chat-wrap--other';
            const bubbleClass = speaker === 'me'        ? 'chat-bubble--me'
                              : speaker === 'agent'     ? 'chat-bubble--me'
                              : speaker === 'customer'  ? 'chat-bubble--other'
                              : speaker === 'speaker_0' ? 'chat-bubble--dia-a'
                              : speaker === 'speaker_1' ? 'chat-bubble--dia-b'
                              : 'chat-bubble--other';
            const label       = speaker === 'me'        ? 'Ben'
                              : speaker === 'agent'     ? 'Ben'
                              : speaker === 'customer'  ? 'Müşteri'
                              : speaker === 'speaker_0' ? 'A'
                              : speaker === 'speaker_1' ? 'B'
                              : 'Konuşma';

            return (
              <div key={i} className={`chat-wrap ${sideClass}`}>
                <div className={`chat-bubble ${bubbleClass}`}>
                  {text}
                </div>
                <span className="chat-label">{label}</span>
              </div>
            );
          })}

          {interimText && (
            <div className="chat-wrap chat-wrap--me">
              <div className="chat-bubble chat-bubble--me chat-bubble--interim">
                {interimText}
              </div>
            </div>
          )}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
