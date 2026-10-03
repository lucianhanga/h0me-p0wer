import { useEffect, useRef, useState } from "react";
import SyncedSpeech from "./SyncedSpeech.jsx";
import { speechSupported } from "./SpeakButton.jsx";
import { useLanguage, useSpeechLang, useT } from "../i18n/LanguageProvider.jsx";

// Voice Q&A button (header, next to the title): press → browser STT
// (SpeechRecognition) → POST /api/ask → the AI corrects the transcript and
// answers with the full home-energy context. The answer card shows the
// corrected question, the answer, and a read-aloud button.
const SR =
  typeof window !== "undefined"
    ? (window.SpeechRecognition ?? window.webkitSpeechRecognition)
    : null;

export default function AskButton() {
  const t = useT();
  const { language } = useLanguage();
  const speechLang = useSpeechLang();
  const [state, setState] = useState("idle"); // idle | listening | thinking | done | error
  const [transcript, setTranscript] = useState("");
  const [result, setResult] = useState(null); // {correctedQuestion, answer}
  const [error, setError] = useState(null);
  const recRef = useRef(null);
  const closeTimer = useRef(null);
  // 2026-10-03 (user report: "it didn't recognize that I finished the
  // question, then 'speech recognition failed' errors — it hung"):
  // Chrome's SpeechRecognition often ends a session WITHOUT ever marking
  // the last utterance isFinal (pause timeout), and the old code only
  // submitted on isFinal — so a finished question was silently discarded
  // on `end`, while the still-open session hung and later errored. Now:
  // the transcript is mirrored in a ref, `speechend` stops the session
  // promptly, and `end`/`error` SUBMIT the last transcript instead of
  // dropping it. submittedRef guards against double submits.
  const transcriptRef = useRef("");
  const submittedRef = useRef(false);

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

  function finish(text) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    try {
      recRef.current?.stop();
    } catch {
      /* already stopped */
    }
    ask(text);
  }

  function start() {
    if (!SR) return;
    setResult(null);
    setError(null);
    setTranscript("");
    transcriptRef.current = "";
    submittedRef.current = false;
    recRef.current?.abort(); // kill any hung previous session before starting
    const rec = new SR();
    recRef.current = rec;
    rec.lang = speechLang;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      const text = [...e.results].map((r) => r[0].transcript).join(" ");
      setTranscript(text);
      transcriptRef.current = text;
      if (e.results[e.results.length - 1].isFinal) finish(text);
    };
    // The user stopped talking — finalize NOW instead of hanging until
    // Chrome's own (long) timeout.
    rec.onspeechend = () => {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    };
    rec.onerror = (e) => {
      if (e.error === "aborted") return; // our own stop/abort — not an error
      // An error with a pending transcript still yields an answer (the
      // transcript is good even if the session died messily).
      if (!submittedRef.current && transcriptRef.current.trim()) {
        finish(transcriptRef.current);
        return;
      }
      setState("error");
      setError(
        e.error === "not-allowed"
          ? t("ask.micDenied")
          : e.error === "no-speech"
            ? t("ask.noSpeech")
            : t("ask.failed", { error: e.error }),
      );
    };
    rec.onend = () => {
      // Session ended without a final result (pause timeout): submit the
      // last interim transcript rather than dropping the question.
      if (!submittedRef.current && transcriptRef.current.trim()) {
        finish(transcriptRef.current);
        return;
      }
      setState((s) => (s === "listening" ? "idle" : s));
    };
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
        body: JSON.stringify({ question, lang: language }),
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
    // Kill a still-open mic session when the overlay closes mid-listen —
    // otherwise the session hangs in the background and the NEXT attempt
    // errors (the 2026-10-03 "speech recognition failed" reports).
    if (state === "listening") {
      submittedRef.current = true; // closing discards the question
      recRef.current?.abort();
    }
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
              ? t("ask.stop")
              : t("ask.byVoice")
            : t("ask.unsupported")
        }
        aria-label={t("ask.byVoice")}
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
            <button className="ask-close" onClick={close} aria-label={t("ask.close")}>×</button>
            {state === "listening" && (
              <p className="muted">{t("ask.listening")} {transcript && <em>{transcript}</em>}</p>
            )}
            {state === "thinking" && (
              <p className="muted">
                {t("ask.thinkingWithTranscript", { transcript })}
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
