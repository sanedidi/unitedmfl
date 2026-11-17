/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Compression is done by the reverse proxy (Caddy); gzip here would buffer the live SSE stream.
  compress: false,
  reactStrictMode: true,
  // fonts read at runtime by the Open Graph image routes
  outputFileTracingIncludes: { "/**": ["./src/assets/og/**"] },
  images: {
    // WebP only: AVIF encoding is several times slower and on our VPS the
    // first visitor waited seconds for every picture after each deploy.
    formats: ["image/webp"],
    deviceSizes: [390, 640, 828, 1080, 1440, 1920],
    imageSizes: [64, 128, 256, 384],
    minimumCacheTTL: 2592000,
    // uploads are served by the API under /uploads (same origin)
    localPatterns: [{ pathname: "/uploads/**" }],
    remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }],
  },
  // Resolve metadata before streaming so notFound() answers with a real 404 status.
  htmlLimitedBots: /.*/,
  async rewrites() {
    // In production Caddy routes /api and /uploads to the Go service directly.
    // In development these rewrites let the browser talk to the local API.
    const api = process.env.API_INTERNAL_URL || "http://localhost:8080";
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/uploads/:path*", destination: `${api}/uploads/:path*` },
    ];
  },
};
export default nextConfig;
