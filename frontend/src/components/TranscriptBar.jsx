import { useEffect, useRef } from 'react';
import './TranscriptBar.css';

/**
 * TranscriptBar
 *
 * Displays the accumulated final transcript lines and the current
 * interim (non-final) text from the speech recognizer.
 *
 * @param {object} props
 * @param {string[]} props.finalLines  - committed utterances, newest last
 * @param {string}   props.interimText - in-progress recognition, replaced in place
 */
export function TranscriptBar({ finalLines, interimText }) {
  const bottomRef = useRef(null);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [finalLines, interimText]);

  const isEmpty = finalLines.length === 0 && !interimText;

  return (
    <div className="transcript-bar">
      {isEmpty ? (
        <span className="transcript-empty">Listening…</span>
      ) : (
        <>
          {finalLines.map((line, i) => (
            <p key={i} className="transcript-final">
              {line}
            </p>
          ))}
          {interimText && (
            <p className="transcript-interim">{interimText}</p>
          )}
        </>
      )}
      <div ref={bottomRef} />
    </div>
  );
}
