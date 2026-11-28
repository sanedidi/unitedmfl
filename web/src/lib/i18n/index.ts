// Universal entry: "#i18n-env" resolves to env.server.ts in Server Components
// (react-server condition) and to env.client.ts in client components / SSR.
import { useLang } from "#i18n-env";
import { makeT, type T } from "./core";

export { useLang };
export * from "./core";

/** Translator for the current request / page. Keys are the Uzbek source strings. */
export function useT(): T {
  return makeT(useLang());
}

/**
 * Module-level label tables (status names, event names…) can't call useT() when
 * they are defined. lazyT wraps such a table so every string is translated when
 * it is READ, i.e. while rendering, in the current request's language.
 * `fields` limits translation to those property names (other strings stay as is).
 */
export function lazyT<O extends object>(o: O, fields?: readonly string[]): O {
  return new Proxy(o, {
    get(target, key, recv) {
      const v = Reflect.get(target, key, recv);
      if (typeof v === "string") return !fields || fields.includes(String(key)) ? makeT(useLang())(v) : v;
      if (v && typeof v === "object") return lazyT(v as object, fields);
      return v;
    },
  });
}
