/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Compression is done by the reverse proxy (Caddy); gzip here would buffer the live SSE stream.
  compress: false,
  reactStrictMode: true,
  images: { unoptimized: true },
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
