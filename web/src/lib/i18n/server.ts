import "server-only";
import { getLang } from "./env.server";
import { makeT } from "./core";

export { getLang };

/** For generateMetadata, route handlers and other non-render server code. */
export async function getT() {
  return makeT(await getLang());
}
