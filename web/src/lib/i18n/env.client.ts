import { useContext } from "react";
import { isLang, type Lang } from "./core";
import { LangContext } from "./provider";

/** Client-side language. In the browser it is read from <html lang> (set by the server
 *  from the cookie), so it also works outside render (event handlers, effects). */
export function useLang(): Lang {
  if (typeof document !== "undefined") {
    const l = document.documentElement.lang;
    return isLang(l) ? l : "uz";
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useContext(LangContext);
}
