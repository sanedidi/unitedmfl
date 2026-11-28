"use client";
import { createContext } from "react";
import type { Lang } from "./core";

export const LangContext = createContext<Lang>("uz");

/** Passes the request language (from the cookie) to client components during SSR. */
export function LangProvider({ lang, children }: { lang: Lang; children: React.ReactNode }) {
  return <LangContext.Provider value={lang}>{children}</LangContext.Provider>;
}
