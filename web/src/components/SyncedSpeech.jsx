import { useEffect, useMemo, useState } from "react";
import SpeakButton, { speakText, stopSpeech, speechSupported } from "./SpeakButton.jsx";

// Answer text written AS it is spoken: words appear one by one at the voice's
// pace (SpeechSynthesis onboundary), the current word highlighted; the full
// text stays once the reading ends. autoPlay starts reading immediately —
// onSpeechEnd fires when the utterance finishes (drives the auto-close).
export default function SyncedSpeech({ id, text, autoPlay = false, className = "", onSpeechEnd = null }) {
  const [char, setChar] = useState(null); // boundary charIndex while speaking
  const [finished, setFinished] = useState(!speechSupported);

  const words = useMemo(() => {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[0], i: m.index });
    return out;
  }, [text]);

  useEffect(() => {
    function onWord(c) {
      if (c == null) {
        setChar(null);
        setFinished(true);
        onSpeechEnd?.();
      } else {
        setFinished(false);
        setChar(c);
      }
    }
    if (autoPlay && text) speakText(id, text, { onWord });
    return () => stopSpeech(); // panel closed / answer replaced mid-speech
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, text, autoPlay]);

  const activeIdx =
    char == null
      ? -1
      : words.findIndex((w, k) => char >= w.i && (k === words.length - 1 || char < words[k + 1].i));
  const revealed = finished ? words.length : activeIdx + 1;

  return (
    <div className={className}>
      <p className="ask-answer">
        {words.slice(0, revealed).map((w, k) => (
          <span key={k} className={k === activeIdx ? "speak-active" : undefined}>
            {w.w}{" "}
          </span>
        ))}
      </p>
      <SpeakButton
        id={id}
        text={text}
        onBoundary={(c) => {
          if (c == null) {
            setChar(null);
            setFinished(true);
            onSpeechEnd?.();
          } else {
            setFinished(false);
            setChar(c);
          }
        }}
      />
    </div>
  );
}
