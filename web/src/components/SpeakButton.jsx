import { useEffect, useState } from "react";

// Small read-aloud button using the browser's built-in TTS (Web Speech API —
// no key, no backend). One utterance at a time across ALL buttons: starting
// one stops whichever is currently speaking; clicking the active one stops.
// speakText/stopSpeech are exported so SyncedSpeech can drive the same
// coordination (auto-play, word-boundary highlighting).
const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
export const speechSupported = Boolean(synth);
let activeId = null;
const setters = new Map(); // id -> setSpeaking

export function stopSpeech() {
  if (!synth) return;
  synth.cancel();
  setters.get(activeId)?.(false);
  activeId = null;
}

export function speakText(id, text, { onWord = null } = {}) {
  if (!synth) return;
  if (activeId) stopSpeech();
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
  if (onWord) u.onboundary = (e) => onWord(e.charIndex ?? null);
  u.onend = u.onerror = () => {
    if (activeId === id) activeId = null;
    setters.get(id)?.(false);
    onWord?.(null);
  };
  activeId = id;
  setters.get(id)?.(true);
  synth.speak(u);
}

export default function SpeakButton({ id, text, className = "", onBoundary = null }) {
  const [speaking, setSpeaking] = useState(false);

  useEffect(() => {
    setters.set(id, setSpeaking);
    return () => setters.delete(id);
  }, [id]);

  if (!synth) return null;

  function toggle(e) {
    e.stopPropagation(); // don't flip the parent tile
    if (activeId === id) {
      stopSpeech();
      return;
    }
    speakText(id, text, { onWord: onBoundary });
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
