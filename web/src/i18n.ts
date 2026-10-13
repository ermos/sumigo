import { fr } from './locales/fr';
import { es } from './locales/es';

// Keys are the English strings: English needs no dictionary, and a key missing from fr.ts fails the type check.
export type Key = keyof typeof fr;
export type Lang = 'en' | 'fr' | 'es';
export const languages: Record<Lang, string> = {
  en: 'English',
  fr: 'Français',
  es: 'Español',
};
const dicts: Record<Lang, Partial<Record<Key, string>>> = { en: {}, fr, es };

const pick = (l?: string | null) => (l && l in languages ? (l as Lang) : undefined);
const stored = () => {
  try {
    return localStorage.getItem('lang');
  } catch {
    return null;
  }
};

// The saved choice wins, then the browser language, then English.
export const lang: Lang = pick(stored()) ?? pick(navigator.language.slice(0, 2)) ?? 'en';
document.documentElement.lang = lang;

// setLang reloads the page: strings are read at render time, so a fresh start is all a switch needs.
export const setLang = (l: Lang) => {
  try {
    localStorage.setItem('lang', l);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  location.reload();
};

// t translates an English string and fills its {name} placeholders from vars. Unknown placeholders are kept.
export const t = (key: Key, vars: Record<string, string | number> = {}) => (dicts[lang][key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

// tError translates an API error by its code. In English, or for a code missing here, the server message is shown.
export const tError = (code: string | undefined, vars: Record<string, string> | undefined, message: string) => {
  const key = `error.${code}` as Key;
  return code && dicts[lang][key] ? t(key, vars) : message.charAt(0).toUpperCase() + message.slice(1);
};
