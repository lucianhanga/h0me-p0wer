import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  detectLanguage,
  loadStoredLanguage,
  storeLanguage,
  translate,
} from "./translate.js";
import { stopSpeech } from "../speech.js";

const LanguageContext = createContext(null);

// Holds the app language: initialised from localStorage, else the browser
// locale; persists every change and mirrors it onto <html lang>.
export function LanguageProvider({ children }) {
  const [language, setLanguageState] = useState(() => loadStoredLanguage() ?? detectLanguage());

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((next) => {
    storeLanguage(next);
    setLanguageState(next);
    // An ongoing reading in the old language must not continue after a switch.
    stopSpeech();
  }, []);

  const value = useMemo(() => ({ language, setLanguage }), [language, setLanguage]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("useLanguage must be used within a LanguageProvider");
  return context;
}

// `t` bound to the active language: t("nav.welcome"), t("common.updated", { time }).
export function useT() {
  const { language } = useLanguage();
  return useCallback((key, params) => translate(language, key, params), [language]);
}

// BCP-47 tag for speech APIs (STT/TTS) for the active language.
export function useSpeechLang() {
  const { language } = useLanguage();
  return { en: "en-US", de: "de-DE", ro: "ro-RO" }[language] ?? "en-US";
}
