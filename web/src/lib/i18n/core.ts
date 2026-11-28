import { ru } from "./ru";

/** Site languages. Uzbek is the source language: every key IS the Uzbek text. */
export type Lang = "uz" | "ru";
export const DEFAULT_LANG: Lang = "uz";
export const LANG_COOKIE = "lang";
export const isLang = (v: unknown): v is Lang => v === "uz" || v === "ru";

type Arg = string | number | null | undefined | false;
export type T = (key: string, ...args: Arg[]) => string;

const cache: Partial<Record<Lang, T>> = {};

/** Translator for a language; `{0}`, `{1}`… in the text are replaced by args. */
export function makeT(lang: Lang): T {
  return (cache[lang] ??= (key, ...args) => {
    let s = lang === "ru" ? ru[key] ?? key : key;
    if (args.length) s = s.replace(/\{(\d+)\}/g, (_, i) => {
      const v = args[+i];
      return v == null || v === false ? "" : String(v);
    });
    return s;
  });
}

export const LOCALE: Record<Lang, string> = { uz: "uz-UZ", ru: "ru-RU" };
export const OG_LOCALE: Record<Lang, string> = { uz: "uz_UZ", ru: "ru_RU" };
