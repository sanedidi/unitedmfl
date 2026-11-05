import { initials, teamColor } from "@/lib/format";
import type { TeamRef } from "@/lib/types";

export function Crest({ team, size = 40, unknownLabel = "?" }: { team: Partial<TeamRef> & { id?: number; name?: string } | null; size?: number; unknownLabel?: string }) {
  const fs = Math.max(10, Math.round(size * 0.32));
  if (!team || !team.name) {
    return (
      <span className="crest crest-unknown" style={{ width: size, height: size, fontSize: fs }} aria-hidden>
        {unknownLabel}
      </span>
    );
  }
  return (
    <span className="crest" style={{ width: size, height: size, fontSize: fs, background: teamColor({ id: team.id || 0, colors: team.colors }) }} aria-hidden>
      {team.crest_url ? <img src={team.crest_url} alt="" /> : initials(team.name, team.short_name)}
    </span>
  );
}
