import { abs } from "@/lib/seo";
import { CHUNK, indexXml, SECTIONS, sectionUrls, xmlResponse, type Url } from "@/lib/sitemap";

export const dynamic = "force-dynamic";

/** Sitemap index: one child sitemap per content type, split into chunks when large. */
export async function GET() {
  const items: Url[] = [];
  for (const s of SECTIONS) {
    const urls = await sectionUrls(s);
    if (!urls.length) continue;
    const chunks = Math.ceil(urls.length / CHUNK);
    for (let i = 0; i < chunks; i++) {
      const part = urls.slice(i * CHUNK, (i + 1) * CHUNK);
      const lastmod = part.map((u) => u.lastmod).filter(Boolean).sort().at(-1);
      items.push({ loc: abs(`/sitemaps/${s}${chunks > 1 ? `-${i + 1}` : ""}.xml`), lastmod });
    }
  }
  return xmlResponse(indexXml(items));
}
