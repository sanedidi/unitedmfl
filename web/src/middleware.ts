import { NextResponse, type NextRequest } from "next/server";

/** `?lang=ru` / `?lang=uz` in any link switches the site language (cookie) and drops the parameter. */
export function middleware(req: NextRequest) {
  const lang = req.nextUrl.searchParams.get("lang");
  if (lang !== "ru" && lang !== "uz") return NextResponse.next();
  const url = req.nextUrl.clone();
  url.searchParams.delete("lang");
  const res = NextResponse.redirect(url, 307);
  res.cookies.set("lang", lang, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}

export const config = { matcher: ["/((?!api|uploads|_next|internal|favicon|icon|apple-touch-icon|robots|sitemap).*)"] };
