"use client";
import { useEffect, useState } from "react";
import { matchMinute } from "@/lib/format";
import type { Match } from "@/lib/types";

/** Ticking match clock. Renders the server value first to avoid hydration mismatch. */
export function LiveMinute({ match, serverOffsetMs = 0, initial }: { match: Pick<Match, "period" | "clock_started_at" | "clock_offset_sec">; serverOffsetMs?: number; initial: string }) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const tick = () => setV(matchMinute(match, Date.now(), serverOffsetMs));
    tick();
    if (!match.clock_started_at) return;
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, [match.period, match.clock_started_at, match.clock_offset_sec, serverOffsetMs]); // eslint-disable-line react-hooks/exhaustive-deps
  return <>{v}</>;
}
