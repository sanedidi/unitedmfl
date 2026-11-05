import { initials } from "@/lib/format";
import type { TeamRef } from "@/lib/types";

/** Team crest: the uploaded emblem, or a neutral circle with the team code (no invented club colours). */
export function Crest({ team, size = 40, unknownLabel = "?" }: { team: Partial<TeamRef> & { id?: number; name?: string } | null; size?: number; unknownLabel?: string }) {
  const fs = Math.max(9, Math.round(size * (size <= 28 ? 0.3 : 0.32)));
  if (!team || !team.name) {
    return (
      <span className="crest crest-unknown" style={{ width: size, height: size, fontSize: fs }} aria-hidden>
        {unknownLabel}
      </span>
    );
  }
  return (
    <span className="crest" style={{ width: size, height: size, fontSize: fs }} aria-hidden>
      {team.crest_url ? <img src={team.crest_url} alt="" /> : initials(team.name, team.short_name)}
    </span>
  );
}
