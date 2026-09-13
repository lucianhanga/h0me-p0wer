import { useEffect, useMemo, useState } from "react";
import SpeakButton, { speakText, stopSpeech } from "./SpeakButton.jsx";

// Answer text with karaoke-style sync: while it is read aloud, the word at
// the voice's current position is highlighted (SpeechSynthesis onboundary).
// autoPlay starts the reading immediately on mount — no button press needed
// (the shared coordination makes the button show ⏹ in sync).
export default function SyncedSpeech({ id, text, autoPlay = false, className = "" }) {
  const [char, setChar] = useState(null);

  const words = useMemo(() => {
    const out = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(text))) out.push({ w: m[0], i: m.index });
    return out;
  }, [text]);

  useEffect(() => {
    if (autoPlay && text) speakText(id, text, { onWord: setChar });
    return () => stopSpeech(); // panel closed / answer replaced mid-speech
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, text, autoPlay]);

  const activeIdx =
    char == null
      ? -1
      : words.findIndex((w, k) => char >= w.i && (k === words.length - 1 || char < words[k + 1].i));

  return (
    <div className={className}>
      <p className="ask-answer">
        {words.map((w, k) => (
          <span key={k} className={k === activeIdx ? "speak-active" : undefined}>
            {w.w}{" "}
          </span>
        ))}
      </p>
      <SpeakButton id={id} text={text} onBoundary={setChar} />
    </div>
  );
}
