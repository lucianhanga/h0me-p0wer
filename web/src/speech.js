// Shared speech coordination (Web Speech API — no key, no backend). One
// utterance at a time across ALL buttons: starting one stops whichever is
// currently speaking. Split out of SpeakButton.jsx (2026-09-27, i18n) so
// LanguageProvider can stop speech on language change without a circular
// import — this module must not import from the i18n layer; callers pass
// the language in.
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

// lang is a BCP-47 tag ("en-US"/"de-DE"/"ro-RO" via useSpeechLang()).
function pickVoice(lang) {
  const voices = synth.getVoices();
  const prefix = (lang ?? "en").slice(0, 2);
  return (
    voices.find((v) => v.lang?.toLowerCase().startsWith(prefix) && /google/i.test(v.name)) ??
    voices.find((v) => v.lang?.toLowerCase().startsWith(prefix))
  );
}

export function speakText(id, text, { onWord = null, lang = "en-US" } = {}) {
  if (!synth) return;
  if (activeId) stopSpeech();
  const u = new SpeechSynthesisUtterance(text);
  const voice = pickVoice(lang);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = lang;
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

// SpeakButton registers/unregisters its setter here so stopSpeech() can
// flip its icon back.
export function registerSpeechSetter(id, setter) {
  setters.set(id, setter);
  return () => setters.delete(id);
}
