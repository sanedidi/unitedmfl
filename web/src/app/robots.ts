import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{
      userAgent: "*",
      allow: ["/", "/_next/static/", "/_next/image", "/uploads/"],
      // internal search results, API (JSON/SSE) and the cache-purge hook have no search value
      disallow: ["/qidiruv", "/api/", "/internal/"],
    }],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
