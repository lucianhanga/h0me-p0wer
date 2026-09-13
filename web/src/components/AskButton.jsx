import { useEffect, useRef, useState } from "react";
import SyncedSpeech from "./SyncedSpeech.jsx";
import { speechSupported } from "./SpeakButton.jsx";

// Voice Q&A button (header, next to the title): press → browser STT
// (SpeechRecognition) → POST /api/ask → the AI corrects the transcript and
// answers with the full home-energy context. The answer card shows the
// corrected question, the answer, and a read-aloud button.
const SR =
  typeof window !== "undefined"
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : null;

export default function AskButton() {
  const [state, setState] = useState("idle"); // idle | listening | thinking | done | error
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState(null); // {correctedQuestion, answer}
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const closeTimer = useRef(null);

  useEffect(
    () => () => {
      recRef.current?.abort();
      clearTimeout(closeTimer.current);
    },
    [],
  );

  // Dead-man switch: once armed, the overlay closes after 3 s — any tap on
  // the panel re-arms it, so it only closes when nobody interacts.
  function armAutoClose() {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(close, 3000);
  }

  function start() {
    if (!SR) return;
    setResult(null);
    setError(null);
    setTranscript("");
    const rec = new SR();
    recRef.current = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join(" ");
      setTranscript(text);
      if (e.results[e.results.length - 1].isFinal) ask(text);
    };
    rec.onerror = (e) => {
      setState("error");
      setError(
        e.error === "not-allowed"
          ? "Microphone access denied — allow it in the browser and try again."
          : `Speech recognition failed (${e.error}).`,
      );
    };
    rec.onend = () => setState((s) => (s === "listening" ? "idle" : s));
    setState("listening");
    rec.start();
  }

  function stop() {
    recRef.current?.stop();
  }

  async function ask(question) {
    if (!question.trim()) {
      setState("idle");
      return;
    }
    setState("thinking");
    try {
      const j = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      }).then((r) => r.json());
      if (j.ok) {
        setResult(j.data);
        setState("done");
        if (!speechSupported) armAutoClose(); // no read-aloud → close on time
      } else {
        setError(j.error);
        setState("error");
      }
    } catch (err) {
      setError(String(err.message ?? err));
      setState("error");
    }
  }

  function close() {
    clearTimeout(closeTimer.current);
    setResult(null);
    setError(null);
    setTranscript("");
    setState("idle");
  }

  const open = state !== "idle";
  return (
    <>
      <button
        className={`ask-btn${state === "listening" ? " listening" : ""}`}
        onClick={state === "listening" ? stop : start}
        disabled={!SR}
        title={
          SR
            ? state === "listening"
              ? "Stop listening"
              : "Ask a question by voice"
            : "Voice input not supported in this browser"
        }
        aria-label="Ask a question by voice"
      >
        🎤
      </button>
      {open && (
        <div className="ask-backdrop" onClick={close}>
          <div
            className="ask-panel card"
            onClick={(e) => {
              e.stopPropagation();
              if (state === "done") armAutoClose(); // dead-man switch: stay open while tapped
            }}
          >
            <button className="ask-close" onClick={close} aria-label="Close">×</button>
            {state === "listening" && (
              <p className="muted">Listening… {transcript && <em>{transcript}</em>}</p>
            )}
            {state === "thinking" && (
              <p className="muted">
                “{transcript}” — thinking…
              </p>
            )}
            {state === "error" && <p className="muted">{error}</p>}
            {state === "done" && result && (
              <>
                <p className="ask-question">“{result.correctedQuestion}”</p>
                <SyncedSpeech
                  id="ask-answer"
                  text={result.answer}
                  autoPlay
                  onSpeechEnd={armAutoClose}
                />
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
