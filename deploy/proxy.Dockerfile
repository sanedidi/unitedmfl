# Caddy reverse proxy + the admin SPA (React/Vite) baked in as static files.
FROM node:22-alpine AS admin
WORKDIR /app
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
ARG VITE_SITE_URL=https://unitedmfl.com
ENV VITE_SITE_URL=$VITE_SITE_URL
RUN npm run build

FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=admin /app/dist /srv/admin
