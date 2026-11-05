import { useEffect, useState } from "react";
import { api, type Page } from "./api";
import type { Season, Stage, Team } from "./types";

type Refs = { teams: Team[]; seasons: Season[]; stages: Stage[] };
let cache: Promise<Refs> | null = null;

async function fetchRefs(): Promise<Refs> {
  const [teams, seasons, stages] = await Promise.all([
    api.get<Page<Team>>("/admin/teams?limit=200").catch(() => ({ items: [], total: 0 })),
    api.get<Page<Season>>("/admin/seasons?limit=200").catch(() => ({ items: [], total: 0 })),
    api.get<Page<Stage>>("/admin/stages?limit=200").catch(() => ({ items: [], total: 0 })),
  ]);
  return { teams: teams.items, seasons: seasons.items, stages: stages.items };
}

/** Reference lists for selects (teams, seasons, stages), cached for the session. */
export function useRefs() {
  const [refs, setRefs] = useState<Refs>({ teams: [], seasons: [], stages: [] });
  useEffect(() => {
    if (!cache) cache = fetchRefs();
    let live = true;
    cache.then((r) => live && setRefs(r)).catch(() => (cache = null));
    return () => {
      live = false;
    };
  }, []);
  return refs;
}
export const invalidateRefs = () => (cache = null);
export const activeSeason = (seasons: Season[]) => seasons.find((s) => s.is_active) || seasons[0];
