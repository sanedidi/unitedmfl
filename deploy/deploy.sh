#!/usr/bin/env bash
# United MFL — one-command deploy / update on a fresh Ubuntu/Debian server.
#   curl -fsSL https://raw.githubusercontent.com/sanedidi/unitedmfl/main/deploy/deploy.sh | sudo bash
# or, inside a clone:  sudo ./deploy/deploy.sh
set -euo pipefail

REPO="${REPO:-https://github.com/sanedidi/unitedmfl.git}"
DIR="${DIR:-/opt/unitedmfl}"
BRANCH="${BRANCH:-main}"

log() { printf '\033[1;32m==>\033[0m %s\n' "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required" >&2
  exit 1
fi
command -v git >/dev/null 2>&1 || { log "Installing git"; (apt-get update -qq && apt-get install -y -qq git) || yum install -y git; }

if [ -d "$DIR/.git" ]; then
  log "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" reset --hard --quiet "origin/$BRANCH"
else
  log "Cloning $REPO into $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR/deploy"
if [ ! -f .env ]; then
  log "Creating deploy/.env with generated secrets"
  cp .env.example .env
  gen() { openssl rand -hex "$1" 2>/dev/null || head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(gen 24)|" .env
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(gen 32)|" .env
  if ! grep -q '^ADMIN_EMAIL=.\+' .env; then
    pw="$(gen 9)"
    sed -i "s|^ADMIN_EMAIL=.*|ADMIN_EMAIL=admin@unitedmfl.local|; s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$pw|" .env
    echo "First admin: admin@unitedmfl.local / $pw  (change it after the first login)" | tee "$DIR/deploy/FIRST_ADMIN.txt"
    chmod 600 "$DIR/deploy/FIRST_ADMIN.txt"
  fi
  chmod 600 .env
fi

log "Building and starting containers"
docker compose up -d --build --remove-orphans
docker image prune -f >/dev/null 2>&1 || true

log "Waiting for the API"
for i in $(seq 1 60); do
  if docker compose exec -T api wget -qO- http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done
docker compose ps
log "Done. Site: $(grep '^SITE_ADDRESS=' .env | cut -d= -f2-)  Admin: $(grep '^ADMIN_ADDRESS=' .env | cut -d= -f2-)"
