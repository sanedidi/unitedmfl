#!/usr/bin/env node
// SEO smoke test against a running build:  BASE=http://localhost:3000 npm run test:seo
// Crawls the sitemap and checks status codes, metadata, canonical, robots, JSON-LD,
// headings and internal links; exits with code 1 on any error.

const BASE = (process.env.BASE || "http://localhost:3000").replace(/\/$/, "");
const errors = [];
const warns = [];
const fail = (url, msg) => errors.push(`${url}: ${msg}`);
const warn = (url, msg) => warns.push(`${url}: ${msg}`);

async function get(path, opts = {}) {
  const res = await fetch(BASE + path, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" }, ...opts });
  const body = res.headers.get("content-type")?.includes("image") ? "" : await res.text();
  return { status: res.status, location: res.headers.get("location"), type: res.headers.get("content-type") || "", body };
}
const attr = (tag, name) => (new RegExp(`${name}="([^"]*)"`).exec(tag) || [])[1];
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const stripTags = (s) => decode(s.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "")).trim();
const toPath = (u) => { const x = new URL(u); return x.pathname + x.search; };

function head(html) {
  const h = html.slice(0, html.indexOf("</head>") + 7);
  const metas = [...h.matchAll(/<meta [^>]*>/g)].map((m) => m[0]);
  const meta = (key, val) => metas.find((m) => attr(m, key) === val);
  return {
    title: stripTags((/<title>([\s\S]*?)<\/title>/.exec(h) || [])[1] || ""),
    description: decode(attr(meta("name", "description") || "", "content") || ""),
    canonical: attr((/<link rel="canonical"[^>]*>/.exec(h) || [""])[0], "href"),
    robots: attr(meta("name", "robots") || "", "content") || "",
    ogImage: attr(meta("property", "og:image") || "", "content"),
    ogTitle: attr(meta("property", "og:title") || "", "content"),
    twitter: attr(meta("name", "twitter:card") || "", "content"),
    lang: (/<html[^>]* lang="([^"]+)"/.exec(html) || [])[1],
  };
}

function checkJsonLd(url, html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const types = [];
  for (const raw of blocks) {
    let data;
    try { data = JSON.parse(raw); } catch (e) { fail(url, `invalid JSON-LD: ${e.message}`); continue; }
    const nodes = (Array.isArray(data) ? data : [data]).flatMap((d) => d["@graph"] || [d]);
    for (const n of nodes) {
      types.push(n["@type"]);
      const need = { SportsEvent: ["name", "startDate", "url"], NewsArticle: ["headline", "datePublished", "image", "author", "publisher"], Person: ["name", "url"], SportsTeam: ["name", "url"],
        BreadcrumbList: ["itemListElement"], Product: ["name", "offers"], VideoObject: ["name", "thumbnailUrl", "uploadDate"], WebSite: ["url", "name"], SportsOrganization: ["name", "url"] }[n["@type"]] || [];
      for (const k of need) if (n[k] == null || n[k] === "") fail(url, `JSON-LD ${n["@type"]} missing "${k}"`);
      if (n["@type"] === "BreadcrumbList") n.itemListElement.forEach((it, i) => { if (it.position !== i + 1 || !it.item || !it.name) fail(url, "BreadcrumbList item malformed"); });
    }
  }
  return types;
}

async function main() {
  // robots.txt
  const robots = await get("/robots.txt");
  if (robots.status !== 200) fail("/robots.txt", `status ${robots.status}`);
  if (!/Sitemap: https?:\/\/\S+\/sitemap\.xml/.test(robots.body)) fail("/robots.txt", "no Sitemap line");
  for (const d of ["/qidiruv", "/api/", "/internal/"]) if (!robots.body.includes(`Disallow: ${d}`)) fail("/robots.txt", `missing Disallow: ${d}`);
  if (/Disallow: \/\s*$/m.test(robots.body)) fail("/robots.txt", "whole site disallowed");

  // sitemap index → children → urls
  const idx = await get("/sitemap.xml");
  if (idx.status !== 200 || !idx.body.includes("<sitemapindex")) fail("/sitemap.xml", "not a sitemap index");
  const children = [...idx.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = [];
  for (const c of children) {
    const r = await get(toPath(c));
    if (r.status !== 200 || !r.body.includes("<urlset")) { fail(c, `child sitemap status ${r.status}`); continue; }
    for (const m of r.body.matchAll(/<url><loc>([^<]+)<\/loc>(?:<lastmod>([^<]+)<\/lastmod>)?<\/url>/g)) {
      urls.push({ loc: decode(m[1]), lastmod: m[2] });
      if (m[2] && isNaN(Date.parse(m[2]))) fail(m[1], `bad lastmod ${m[2]}`);
      if (m[2] && Date.parse(m[2]) > Date.now() + 60000) fail(m[1], "lastmod in the future");
    }
  }
  if (urls.length < 5) fail("/sitemap.xml", `only ${urls.length} URLs`);
  const origin = urls[0] ? new URL(urls[0].loc).origin : "";

  // crawl every sitemap URL
  const titles = new Map(), descs = new Map(), links = new Set(), typesSeen = new Set();
  for (const { loc } of urls) {
    const path = toPath(loc);
    const r = await get(path);
    if (r.status !== 200) { fail(path, `status ${r.status}${r.location ? ` → ${r.location}` : ""} (sitemap must list final URLs)`); continue; }
    const h = head(r.body);
    if (h.lang !== "uz") fail(path, `html lang=${h.lang}`);
    if (!h.title || h.title.length < 10) fail(path, "missing/short <title>");
    if (h.title.length > 70) warn(path, `long title (${h.title.length})`);
    if (!h.description || h.description.length < 50) fail(path, "missing/short meta description");
    if (h.description.length > 170) warn(path, `long description (${h.description.length})`);
    if (h.canonical?.replace(/\/$/, "") !== loc.replace(/\/$/, "")) fail(path, `canonical ${h.canonical} ≠ sitemap loc`);
    if (/noindex/.test(h.robots)) fail(path, "listed in sitemap but noindex");
    if (!h.ogImage || !h.ogTitle) fail(path, "missing Open Graph");
    if (h.twitter !== "summary_large_image") fail(path, "missing twitter:card");
    const h1 = [...r.body.matchAll(/<h1[\s>]/g)].length;
    if (h1 !== 1) fail(path, `${h1} <h1> elements`);
    checkJsonLd(path, r.body).forEach((t) => typesSeen.add(t));
    titles.set(h.title, [...(titles.get(h.title) || []), path]);
    descs.set(h.description, [...(descs.get(h.description) || []), path]);
    for (const m of r.body.matchAll(/<a [^>]*href="(\/[^"#]*)"/g)) links.add(decode(m[1]));
    if (h.ogImage) {
      const img = await fetch(BASE + toPath(h.ogImage.replace(origin, BASE)), { redirect: "manual" }).catch(() => null);
      if (!img || img.status !== 200 || !img.headers.get("content-type")?.startsWith("image/")) fail(path, `og:image not an image (${h.ogImage})`);
    }
  }
  for (const [t, ps] of titles) if (ps.length > 1) fail(ps.join(", "), `duplicate title "${t}"`);
  for (const [d, ps] of descs) if (ps.length > 1) warn(ps.join(", "), `duplicate description "${d.slice(0, 60)}…"`);

  // internal links must resolve directly (no redirect hops, no 404)
  for (const l of links) {
    if (l.startsWith("/api/") || l.startsWith("/_next/")) continue;
    const r = await get(l);
    if (r.status !== 200) fail(l, `internal link → ${r.status}${r.location ? ` ${r.location}` : ""}`);
  }

  // legacy/short URLs redirect permanently to the canonical slug
  const match = urls.find((u) => /\/matchlar\/\d+-/.test(u.loc));
  if (match) {
    const id = /\/matchlar\/(\d+)-/.exec(match.loc)[1];
    const r = await get(`/matchlar/${id}`);
    if (r.status !== 308 || !r.location?.endsWith(toPath(match.loc))) fail(`/matchlar/${id}`, `expected 308 → canonical, got ${r.status} ${r.location}`);
  }
  const player = urls.find((u) => /\/oyinchilar\/\d+-/.test(u.loc));
  if (player) {
    const id = /\/oyinchilar\/(\d+)-/.exec(player.loc)[1];
    const r = await get(`/oyinchilar/${id}-wrong-name`);
    if (r.status !== 308) fail(`/oyinchilar/${id}-wrong-name`, `expected 308, got ${r.status}`);
  }

  // real 404s (no soft 404)
  for (const p of ["/matchlar/99999999", "/jamoalar/yoq-jamoa", "/oyinchilar/abc", "/yangiliklar/yoq-maqola", "/merch/yoq", "/yoq-sahifa", "/sitemaps/yoq.xml"]) {
    const r = await get(p);
    if (r.status !== 404) fail(p, `expected 404, got ${r.status}`);
  }

  // filtered / internal pages are not indexable and point to the main list
  for (const [p, canon] of [["/matchlar?holat=kelgusi", "/matchlar"], ["/oyinchilar?q=a", "/oyinchilar"], ["/qidiruv?q=a1", null]]) {
    const r = await get(p);
    const h = head(r.body);
    if (!/noindex/.test(h.robots)) fail(p, "should be noindex");
    if (canon && toPath(h.canonical || "http://x/") !== canon) fail(p, `canonical should be ${canon}`);
  }

  for (const t of ["SportsEvent", "SportsTeam", "Person", "NewsArticle", "BreadcrumbList", "WebSite"]) if (!typesSeen.has(t)) warn("JSON-LD", `no ${t} found on any page`);

  console.log(`Checked ${urls.length} sitemap URLs, ${links.size} internal links, JSON-LD types: ${[...typesSeen].join(", ")}`);
  warns.forEach((w) => console.log("WARN ", w));
  errors.forEach((e) => console.log("ERROR", e));
  console.log(errors.length ? `\n✗ ${errors.length} error(s)` : "\n✓ SEO checks passed");
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
