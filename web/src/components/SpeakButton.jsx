import { useEffect, useState } from "react";

// Small read-aloud button using the browser's built-in TTS (Web Speech API —
// no key, no backend). One utterance at a time across ALL buttons: starting
// one stops whichever is currently speaking; clicking the active one stops.
const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
let activeId = null;
const setters = new Map(); // id -> setSpeaking

export default function SpeakButton({ id, text, className = "" }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setters.set(id, setSpeaking);
    return () => setters.delete(id);
  }, [id]);

  if (!synth) return null;

  function stop() {
    synth.cancel();
    setters.get(activeId)?.(false);
    activeId = null;
  }

  function toggle(e) {
    e.stopPropagation(); // don't flip the parent tile
    if (activeId === id) {
      stop();
      return;
    }
    if (activeId) stop();
    const u = new SpeechSynthesisUtterance(text);
    // Prefer an English voice (Android Chrome ships Google voices); the
    // briefing language is English per AI_LANGUAGE.
    const voices = synth.getVoices();
    const voice =
      voices.find((v) => /^en[-_]/i.test(v.lang) && /google/i.test(v.name)) ??
      voices.find((v) => /^en[-_]/i.test(v.lang));
    if (voice) {
      u.voice = voice;
      u.lang = voice.lang;
    }
    u.onend = u.onerror = () => {
      if (activeId === id) activeId = null;
      setSpeaking(false);
    };
    activeId = id;
    setSpeaking(true);
    synth.speak(u);
  }

  return (
    <button
      className={`wx-refresh${className ? ` ${className}` : ""}`}
      onClick={toggle}
      title={speaking ? "Stop reading" : "Read this tile aloud"}
      aria-label={speaking ? "Stop reading" : "Read this tile aloud"}
    >
      {speaking ? "⏹" : "🔊"}
    </button>
  );
}
