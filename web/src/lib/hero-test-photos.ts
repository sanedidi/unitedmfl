// Synthetic stress-test "photos" for the hero layouts (/internal/hero).
// They are deliberately hard for white text: a night stadium with blown-out
// floodlights, an almost white frame (white kit against the sky) and a busy
// crowd. Inline SVG, so the comparison page needs no image files.

export type TestPhoto = "dark" | "light" | "busy";

export const TEST_PHOTOS: { id: TestPhoto; label: string }[] = [
  { id: "dark", label: "Qorong‘i foto — tungi stadion, yorug‘ projektorlar" },
  { id: "light", label: "Juda yorug‘ foto — oq forma va osmon" },
  { id: "busy", label: "Ola-chalpoq foto — tribuna, olomon" },
];

const W = 2400, H = 1100; // desktop banner size from the admin hint
const MW = 1080, MH = 1920; // portrait phone banner

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dark(w: number, h: number) {
  const r = rng(7);
  let stands = "";
  for (let i = 0; i < 260; i++) {
    const x = r() * w, y = h * 0.42 + r() * h * 0.16;
    stands += `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(2 + r() * 4).toFixed(1)}" fill="#ffffff" opacity="${(0.15 + r() * 0.6).toFixed(2)}"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#05070d"/><stop offset=".55" stop-color="#121a2b"/><stop offset="1" stop-color="#0b2414"/></linearGradient>
<radialGradient id="fl"><stop offset="0" stop-color="#ffffff"/><stop offset=".12" stop-color="#fffbe6"/><stop offset=".4" stop-color="#ffe9a8" stop-opacity=".35"/><stop offset="1" stop-color="#ffe9a8" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${w}" height="${h}" fill="url(#sky)"/>
<rect y="${h * 0.58}" width="${w}" height="${h * 0.42}" fill="#14431f"/>
<rect y="${h * 0.58}" width="${w}" height="${h * 0.42}" fill="#1c5a2a" opacity=".5"/>
${stands}
<circle cx="${w * 0.12}" cy="${h * 0.14}" r="${Math.max(w, h) * 0.22}" fill="url(#fl)"/>
<circle cx="${w * 0.42}" cy="${h * 0.1}" r="${Math.max(w, h) * 0.16}" fill="url(#fl)"/>
<circle cx="${w * 0.88}" cy="${h * 0.16}" r="${Math.max(w, h) * 0.2}" fill="url(#fl)"/>
<line x1="0" y1="${h * 0.8}" x2="${w}" y2="${h * 0.8}" stroke="#ffffff" stroke-opacity=".7" stroke-width="6"/>
</svg>`;
}

function light(w: number, h: number) {
  const r = rng(3);
  let clouds = "";
  for (let i = 0; i < 14; i++) {
    clouds += `<ellipse cx="${(r() * w).toFixed(0)}" cy="${(r() * h * 0.6).toFixed(0)}" rx="${(w * (0.08 + r() * 0.14)).toFixed(0)}" ry="${(h * (0.04 + r() * 0.06)).toFixed(0)}" fill="#ffffff"/>`;
  }
  // white-kit players: light grey shading only, the frame stays almost white
  let players = "";
  for (let i = 0; i < 5; i++) {
    const cx = w * (0.08 + i * 0.2 + r() * 0.05), top = h * (0.28 + r() * 0.1), s = Math.min(w, h) * 0.22;
    players += `<g><circle cx="${cx}" cy="${top}" r="${s * 0.13}" fill="#e9dccd"/><rect x="${cx - s * 0.28}" y="${top + s * 0.16}" width="${s * 0.56}" height="${s * 0.75}" rx="${s * 0.12}" fill="#ffffff" stroke="#e6e9ee" stroke-width="4"/><rect x="${cx - s * 0.24}" y="${top + s * 0.9}" width="${s * 0.48}" height="${s * 0.32}" fill="#f2f4f7"/></g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e8f1fb"/><stop offset=".7" stop-color="#ffffff"/><stop offset="1" stop-color="#f6f8f4"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#s)"/>${clouds}${players}
<rect y="${h * 0.86}" width="${w}" height="${h * 0.14}" fill="#eef5e6"/>
</svg>`;
}

function busy(w: number, h: number) {
  const r = rng(11);
  const pal = ["#ffffff", "#f5d90a", "#d7263d", "#1f5fd6", "#91da27", "#ff8a00", "#111111", "#7b2cbf", "#00b4d8", "#f4f5f6", "#e63946", "#2a9d8f"];
  let fans = "";
  const n = Math.round((w * h) / 7000);
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h, s = 18 + r() * 34, c = pal[Math.floor(r() * pal.length)];
    fans += `<rect x="${(x - s * 0.6).toFixed(0)}" y="${(y + s * 0.5).toFixed(0)}" width="${(s * 1.2).toFixed(0)}" height="${(s * 1.4).toFixed(0)}" rx="${(s * 0.3).toFixed(0)}" fill="${c}"/><circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${(s * 0.42).toFixed(0)}" fill="${r() > 0.5 ? "#e0b48a" : "#8d5a3b"}"/>`;
  }
  let flags = "";
  for (let i = 0; i < 9; i++) {
    const x = r() * w, y = r() * h * 0.8;
    flags += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${(w * 0.12).toFixed(0)}" height="${(h * 0.08).toFixed(0)}" fill="${pal[i % pal.length]}" transform="rotate(${(r() * 30 - 15).toFixed(0)} ${x.toFixed(0)} ${y.toFixed(0)})"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid slice">
<rect width="${w}" height="${h}" fill="#8a8f98"/>${fans}${flags}
</svg>`;
}

const uri = (svg: string) => `data:image/svg+xml;utf8,${encodeURIComponent(svg.replace(/\n/g, ""))}`;
const BUILD = { dark, light, busy };

export function testPhoto(id: TestPhoto) {
  return { desktop: uri(BUILD[id](W, H)), mobile: uri(BUILD[id](MW, MH)) };
}
