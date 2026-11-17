import { useEffect, useState } from "react";
import { api, type Page } from "./api";
import { fmtDate } from "./format";
import type { Match } from "./types";

type Opt = { value: string; label: string };

export function matchLabel(m: Match) {
  const teams = m.home || m.away ? `${m.home?.name || "?"} — ${m.away?.name || "?"}` : "Jamoalar aniqlanmagan";
  const when = m.kickoff_at ? fmtDate(m.kickoff_at) : "sana belgilanmagan";
  const stage = m.stage?.name || m.round;
  return [teams, when, stage].filter(Boolean).join(" · ");
}

/** Matches of the active season for «Match» selects (videos, news), newest first. */
export function useMatchOptions() {
  const [opts, setOpts] = useState<Opt[]>([]);
  useEffect(() => {
    let live = true;
    api.get<Page<Match>>("/admin/matches?limit=200")
      .then((r) => live && setOpts(r.items.map((m) => ({ value: String(m.id), label: matchLabel(m) }))))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return opts;
}
