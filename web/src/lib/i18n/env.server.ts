import { cache, use } from "react";
import { cookies } from "next/headers";
import { DEFAULT_LANG, LANG_COOKIE, isLang, type Lang } from "./core";

// Per-request box (React.cache is scoped to one server request): once the
// language is resolved, any code in the same request reads it synchronously.
const box = cache((): { v?: Lang; p?: Promise<Lang> } => ({}));

/** Request language from the `lang` cookie (memoised per request). */
export function getLang(): Promise<Lang> {
  const b = box();
  return (b.p ??= (async () => {
    let v: string | undefined;
    try {
      v = (await cookies()).get(LANG_COOKIE)?.value;
    } catch {
      v = undefined; // outside a request (build time)
    }
    b.v = isLang(v) ? v : DEFAULT_LANG;
    return b.v;
  })());
}

/** Synchronous access for Server Components and helpers called while rendering. */
export function useLang(): Lang {
  const b = box();
  if (b.v) return b.v;
  try {
    return use(getLang());
  } catch (e) {
    // use() outside render (route handlers, OG images): no dispatcher → TypeError.
    if (e instanceof TypeError) return DEFAULT_LANG;
    throw e; // Suspense signal while the cookie promise settles
  }
}
