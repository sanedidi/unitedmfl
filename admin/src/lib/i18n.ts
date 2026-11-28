import { ru } from "./i18n-ru";

/** Interface languages. Uzbek is the source language: every key IS the Uzbek text. */
export type Lang = "uz" | "ru";
export const LANGS: { code: Lang; label: string; short: string }[] = [
  { code: "uz", label: "O‘zbekcha", short: "UZ" },
  { code: "ru", label: "Русский", short: "RU" },
];

const KEY = "umfl_lang";

function detect(): Lang {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "ru" || q === "uz") {
      localStorage.setItem(KEY, q);
      return q;
    }
    const v = localStorage.getItem(KEY);
    if (v === "ru" || v === "uz") return v;
  } catch {
    /* storage blocked */
  }
  return "uz";
}

/** Current language; fixed for the page lifetime (switching reloads the page). */
export const lang: Lang = detect();
if (typeof document !== "undefined") document.documentElement.lang = lang;

export function setLang(l: Lang) {
  if (l === lang) return;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* ignore */
  }
  location.reload();
}

type Arg = string | number | null | undefined | false;

/** Translate an Uzbek source string; `{0}`, `{1}`… are replaced by args. */
export function tx(key: string, ...args: Arg[]): string {
  let s = lang === "ru" ? ru[key] ?? key : key;
  if (args.length) s = s.replace(/\{(\d+)\}/g, (_, i) => {
    const v = args[+i];
    return v == null || v === false ? "" : String(v);
  });
  return s;
}

/** Locale for Intl/date formatting. */
export const locale = lang === "ru" ? "ru-RU" : "uz-UZ";
