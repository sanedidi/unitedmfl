"use client";
import { useEffect } from "react";

/** Counts one article view per page load (article data itself is cached). */
export function ViewBeacon({ slug }: { slug: string }) {
  useEffect(() => {
    const url = `/api/v1/news/${encodeURIComponent(slug)}/view`;
    if (navigator.sendBeacon) navigator.sendBeacon(url);
    else fetch(url, { method: "POST", keepalive: true }).catch(() => {});
  }, [slug]);
  return null;
}
