import { en } from "./en.js";
import { de } from "./de.js";
import { ro } from "./ro.js";

// App i18n, following the h0me reference project's pattern (nested
// dictionaries + dot-path keys + {placeholder} interpolation). Plain JS
// variant — no compile-time key checking, so a missing key falls back:
// selected language → English → the key itself (never a blank string).
export const LANGUAGES = ["en", "de", "ro"];
export const LANGUAGE_STORAGE_KEY = "h0mep0wer.language";

const dictionaries = { en, de, ro };

export function isLanguage(value) {
  return LANGUAGES.includes(value);
}

// Browser default: de* → German, ro* → Romanian, everything else English.
export function detectLanguage() {
  if (typeof navigator === "undefined") return "en";
  const l = navigator.language.toLowerCase();
  if (l.startsWith("de")) return "de";
  if (l.startsWith("ro")) return "ro";
  return "en";
}

export function loadStoredLanguage() {
  try {
    const stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return isLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storeLanguage(lang) {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
  } catch {
    /* private mode etc. — non-fatal */
  }
}

function lookup(dict, key) {
  let node = dict;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

export function translate(lang, key, params) {
  const text = lookup(dictionaries[lang], key) ?? lookup(dictionaries.en, key) ?? key;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}
