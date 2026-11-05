import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { initials } from "./format";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_TYPE = "image/png";

let fonts: Promise<{ name: string; data: Buffer; weight: 600 | 800; style: "normal" }[]> | null = null;
function loadFonts() {
  if (!fonts) {
    const dir = join(process.cwd(), "src/assets/og");
    fonts = Promise.all([
      readFile(join(dir, "archivo-latin-800-normal.woff")).then((data) => ({ name: "Archivo", data, weight: 800 as const, style: "normal" as const })),
      readFile(join(dir, "inter-latin-600-normal.woff")).then((data) => ({ name: "Inter", data, weight: 600 as const, style: "normal" as const })),
    ]);
  }
  return fonts;
}

type Team = { id: number; name: string; short_name?: string; colors?: string[] } | null;

const INK = "#15181C";
const LIME = "#91DA27";

function Crest({ team, size }: { team: Team; size: number }) {
  return (
    <div style={{ width: size, height: size, borderRadius: size, background: "#ECEDEF", border: "2px solid #DDE0E4", display: "flex", alignItems: "center", justifyContent: "center", color: team ? INK : "#6E7581", fontFamily: "Archivo", fontSize: size * 0.3 }}>
      {team ? initials(team.name, team.short_name) : "?"}
    </div>
  );
}

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill={color}>
      <path d="M0 0H37V14.3A38 38 0 0 0 14.3 37H0Z" />
      <path d="M100 0H63V14.3A38 38 0 0 1 85.7 37H100Z" />
      <path d="M0 100H37V85.7A38 38 0 0 1 14.3 63H0Z" />
      <path d="M100 100H63V85.7A38 38 0 0 0 85.7 63H100Z" />
      <path fillRule="evenodd" d="M50 21.5a28.5 28.5 0 1 1 0 57 28.5 28.5 0 0 1 0-57Zm0 13a15.5 15.5 0 1 0 0 31 15.5 15.5 0 0 0 0-31Z" />
    </svg>
  );
}

/** Branded 1200×630 social preview: white card on graphite, one lime accent. */
export async function ogImage(p: { kicker: string; title: string; subtitle?: string; home?: Team; away?: Team; center?: string }) {
  const versus = p.home !== undefined || p.away !== undefined;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, color: "#fff", fontFamily: "Inter", background: INK }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontFamily: "Inter", fontSize: 34, letterSpacing: -1 }}>United</div>
          <Mark size={36} color="#fff" />
          <div style={{ fontFamily: "Inter", fontSize: 34, letterSpacing: -1 }}>MFL</div>
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 14, fontSize: 22, letterSpacing: 3, color: "#fff" }}>
            <div style={{ width: 32, height: 3, background: LIME }} />
            {p.kicker.toUpperCase()}
          </div>
        </div>
        {versus ? (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff", color: INK, borderRadius: 8, padding: "36px 48px" }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: 320 }}>
              <Crest team={p.home ?? null} size={128} />
              <div style={{ fontSize: 36, textAlign: "center" }}>{p.home?.name || "Aniqlanmagan"}</div>
            </div>
            <div style={{ fontFamily: "Archivo", fontSize: p.center && p.center.length > 6 ? 72 : 112, color: INK, letterSpacing: -3 }}>{p.center || "VS"}</div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, width: 320 }}>
              <Crest team={p.away ?? null} size={128} />
              <div style={{ fontSize: 36, textAlign: "center" }}>{p.away?.name || "Aniqlanmagan"}</div>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", fontFamily: "Archivo", fontSize: p.title.length > 40 ? 64 : 88, lineHeight: 1.05, letterSpacing: -3 }}>{p.title}</div>
        )}
        <div style={{ display: "flex", fontSize: 28, color: "rgba(255,255,255,.72)" }}>{p.subtitle || ""}</div>
      </div>
    ),
    { ...OG_SIZE, fonts: await loadFonts() },
  );
}
