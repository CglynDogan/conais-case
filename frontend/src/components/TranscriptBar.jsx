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
            const isMe    = speaker === 'me';
            const label   = speaker === 'customer' ? 'Müşteri' : speaker === 'me' ? 'Ben' : 'Konuşma';

            return (
              <div key={i} className={`chat-wrap ${isMe ? 'chat-wrap--me' : 'chat-wrap--other'}`}>
                <div className={`chat-bubble ${isMe ? 'chat-bubble--me' : 'chat-bubble--other'}`}>
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
