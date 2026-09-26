import { useEffect, useState } from "react";
import { speakText, speechSupported, stopSpeech, registerSpeechSetter } from "../speech.js";
import { useT, useSpeechLang } from "../i18n/LanguageProvider.jsx";

// Small read-aloud button using the browser's built-in TTS. speakText/
// stopSpeech live in ../speech.js and are shared with SyncedSpeech
// (auto-play, word-boundary highlighting) and LanguageProvider (stops
// speech on language change).
const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
export { speakText, stopSpeech, speechSupported };

export default function SpeakButton({ id, text, className = "", onBoundary = null }) {
  const [speaking, setSpeaking] = useState(false);
  const t = useT();
  const speechLang = useSpeechLang();

  useEffect(() => registerSpeechSetter(id, setSpeaking), [id]);

  if (!synth) return null;

  function toggle(e) {
    e.stopPropagation(); // don't flip the parent tile
    if (speaking) {
      stopSpeech();
      return;
    }
    speakText(id, text, { onWord: onBoundary, lang: speechLang });
  }

  return (
    <button
      className={`wx-refresh${className ? ` ${className}` : ""}`}
      onClick={toggle}
      title={speaking ? t("speech.stop") : t("speech.read")}
      aria-label={speaking ? t("speech.stop") : t("speech.read")}
    >
      {speaking ? "⏹" : "🔊"}
    </button>
  );
}
