"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Site visitors for the admin Dashboard («Sayt tashriflari»): one hit per page
// view and a heartbeat every minute while the tab is visible. No cookies: the
// browser keeps a random anonymous id in localStorage; the server stores only
// a hash of it.

const TRACK_URL = "/api/v1/track";
const ID_KEY = "umfl_vid";
const LANDED_KEY = "umfl_landed";
const PING_MS = 60_000;

function visitorId(): string {
  try {
    let v = localStorage.getItem(ID_KEY);
    if (!v || !/^[A-Za-z0-9_-]{16,64}$/.test(v)) {
      v = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID().replace(/-/g, "")
        : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      localStorage.setItem(ID_KEY, v);
    }
    return v;
  } catch {
    return ""; // private mode: the server falls back to a daily key
  }
}

function send(body: Record<string, unknown>) {
  const data = JSON.stringify(body);
  try {
    if (navigator.sendBeacon && navigator.sendBeacon(TRACK_URL, new Blob([data], { type: "text/plain" }))) return;
  } catch {
    /* fall through */
  }
  fetch(TRACK_URL, { method: "POST", body: data, keepalive: true, headers: { "Content-Type": "text/plain" } }).catch(() => {});
}

let landedInMemory = false;
/** True only for the first page this tab opens on the site. */
function firstPageOfVisit(): boolean {
  try {
    if (sessionStorage.getItem(LANDED_KEY)) return false;
    sessionStorage.setItem(LANDED_KEY, "1");
    return true;
  } catch {
    if (landedInMemory) return false;
    landedInMemory = true;
    return true;
  }
}

const skip = (p: string | null) => !p || p === "/preview" || p.startsWith("/preview/");

export function SiteTracker() {
  const path = usePathname();

  useEffect(() => {
    if (skip(path)) return;
    const landing = firstPageOfVisit();
    const utm = landing ? new URLSearchParams(window.location.search).get("utm_source") || "" : "";
    send({ t: "view", p: path, v: visitorId(), l: landing ? 1 : 0, r: landing ? document.referrer : "", s: utm });
  }, [path]);

  useEffect(() => {
    const ping = () => {
      if (document.visibilityState !== "visible" || skip(window.location.pathname)) return;
      send({ t: "ping", p: window.location.pathname, v: visitorId() });
    };
    const timer = window.setInterval(ping, PING_MS);
    const onVisible = () => { if (document.visibilityState === "visible") ping(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return null;
}
