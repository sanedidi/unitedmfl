# Caddy reverse proxy + the admin SPA and the team registration SPA (React/Vite)
# baked in as static files.
FROM node:22-alpine AS admin
WORKDIR /app
COPY admin/package.json admin/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY admin/ ./
ARG VITE_SITE_URL=https://unitedmfl.com
ENV VITE_SITE_URL=$VITE_SITE_URL
RUN npm run build

FROM node:22-alpine AS register
WORKDIR /app
COPY register/package.json register/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY register/ ./
ARG VITE_SITE_URL=https://unitedmfl.com
ARG VITE_HELP_URL=https://t.me/united_mfl
ENV VITE_SITE_URL=$VITE_SITE_URL VITE_HELP_URL=$VITE_HELP_URL
RUN npm run build

FROM caddy:2.10-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=admin /app/dist /srv/admin
COPY --from=register /app/dist /srv/register
