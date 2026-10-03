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

// Read-aloud unit expansion (2026-10-03, user request: in Romanian "kWh"
// must be read "kilowați oră"): speech engines mangle "kWh"/"kW"/"W"/"°C".
// The text is expanded for the UTTERANCE only; toOriginal maps every
// expanded-text char index back to the original string so SyncedSpeech's
// word-by-word highlighting (onboundary charIndex) stays aligned with the
// DISPLAYED text.
const UNIT_SPEECH = {
  en: [
    [/\bkWh\b/g, "kilowatt-hours"],
    [/\bkWp\b/g, "kilowatt-peak"],
    [/\bkW\b/g, "kilowatts"],
    [/\bW\b/g, "watts"],
    [/°C\b/g, "degrees Celsius"],
  ],
  de: [
    [/\bkWh\b/g, "Kilowattstunden"],
    [/\bkWp\b/g, "Kilowatt-Peak"],
    [/\bkW\b/g, "Kilowatt"],
    [/\bW\b/g, "Watt"],
    [/°C\b/g, "Grad Celsius"],
  ],
  ro: [
    [/\bkWh\b/g, "kilowați oră"],
    [/\bkWp\b/g, "kilowați vârf"],
    [/\bkW\b/g, "kilowați"],
    [/\bW\b/g, "wați"],
    [/°C\b/g, "grade Celsius"],
  ],
};

function expandUnits(text, lang) {
  const rules = UNIT_SPEECH[(lang ?? "en").slice(0, 2)] ?? UNIT_SPEECH.en;
  let out = text;
  // map[i] = original-text index of out[i]
  let map = Array.from({ length: text.length }, (_, i) => i);
  for (const [re, rep] of rules) {
    out = out.replace(re, (m, ...rest) => {
      // replace() callback: (match, ...groups, offset, string) — our rules
      // have no capture groups, so rest = [offset, string]. The offset is
      // in the CURRENT (partially expanded) text; map[offset] is the
      // ORIGINAL index of the match start — that's what new chars map to.
      const offset = rest[rest.length - 2];
      map.splice(offset, m.length, ...Array(rep.length).fill(map[offset] ?? offset));
      return rep;
    });
  }
  return { text: out, toOriginal: (i) => (i == null ? null : (map[i] ?? i)) };
}

export function speakText(id, text, { onWord = null, lang = "en-US" } = {}) {
  if (!synth) return;
  if (activeId) stopSpeech();
  const { text: spoken, toOriginal } = expandUnits(text, lang);
  const u = new SpeechSynthesisUtterance(spoken);
  const voice = pickVoice(lang);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else {
    u.lang = lang;
  }
  if (onWord) u.onboundary = (e) => onWord(toOriginal(e.charIndex ?? null));
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
