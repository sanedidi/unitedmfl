import { CHUNK, SECTIONS, sectionUrls, urlsetXml, xmlResponse, type Section } from "@/lib/sitemap";

export const dynamic = "force-dynamic";

export async function GET(_: Request, { params }: { params: Promise<{ file: string }> }) {
  const m = /^([a-z]+)(?:-(\d+))?\.xml$/.exec((await params).file);
  if (!m || !SECTIONS.includes(m[1] as Section)) return new Response("Not found", { status: 404 });
  const urls = await sectionUrls(m[1] as Section);
  const part = m[2] ? Number(m[2]) : 1;
  const slice = urls.slice((part - 1) * CHUNK, part * CHUNK);
  if (!slice.length) return new Response("Not found", { status: 404 });
  return xmlResponse(urlsetXml(slice));
}
