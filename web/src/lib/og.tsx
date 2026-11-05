import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { initials, teamColor } from "./format";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_TYPE = "image/png";

let fonts: Promise<{ name: string; data: Buffer; weight: 600 | 800; style: "normal" }[]> | null = null;
function loadFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), "src/assets/og");
    fonts = Promise.all([
      readFile(join(dir, "unbounded-latin-800-normal.woff")).then((data) => ({ name: "Unbounded", data, weight: 800 as const, style: "normal" as const })),
      readFile(join(dir, "onest-latin-600-normal.woff")).then((data) => ({ name: "Onest", data, weight: 600 as const, style: "normal" as const })),
    ]);
  }
  return fonts;
}

type Team = { id: number; name: string; short_name?: string; colors?: string[] } | null;

function Crest({ team, size }: { team: Team; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: team ? teamColor(team) : "#333A46", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontFamily: "Unbounded", fontSize: size * 0.32, border: "6px solid rgba(255,255,255,.25)" }}>
      {team ? initials(team.name, team.short_name) : "?"}
    </div>
  );
}

/** Branded 1200×630 social preview. */
export async function ogImage(p: { kicker: string; title: string; subtitle?: string; home?: Team; away?: Team; center?: string }) {
  const versus = p.home !== undefined || p.away !== undefined;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, color: "#fff", fontFamily: "Onest",
        background: "linear-gradient(135deg, #1f2a6b 0%, #0d1014 55%, #1c2a0b 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ width: 56, height: 56, borderRadius: 56, background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 22, height: 22, borderRadius: 22, border: "5px solid #E5383B" }} />
          </div>
          <div style={{ fontFamily: "Unbounded", fontSize: 30 }}>UNITED MFL</div>
          <div style={{ marginLeft: "auto", fontSize: 24, color: "#91DA27", fontFamily: "Unbounded", letterSpacing: 2 }}>{p.kicker.toUpperCase()}</div>
        </div>
        {versus ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: 360 }}>
              <Crest team={p.home ?? null} size={150} />
              <div style={{ fontSize: 40, textAlign: "center" }}>{p.home?.name || "Aniqlanmagan"}</div>
            </div>
            <div style={{ fontFamily: "Unbounded", fontSize: p.center && p.center.length > 6 ? 72 : 120, color: "#fff" }}>{p.center || "VS"}</div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, width: 360 }}>
              <Crest team={p.away ?? null} size={150} />
              <div style={{ fontSize: 40, textAlign: "center" }}>{p.away?.name || "Aniqlanmagan"}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontFamily: "Unbounded", fontSize: p.title.length > 40 ? 64 : 88, lineHeight: 1.05, letterSpacing: -2 }}>{p.title}</div>
        )}
        <div style={{ display: "flex", fontSize: 30, color: "#C9CDD3" }}>{p.subtitle || ""}</div>
      </div>
    ),
    { ...OG_SIZE, fonts: await loadFonts() },
  );
}
