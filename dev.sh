#!/usr/bin/env bash
# Local development environment bootstrap — full Docker mode
# Usage:
#   ./dev.sh           # build if needed, bring up everything, tail app logs
#   ./dev.sh --reset   # wipe DB volume + rebuild image
#   ./dev.sh --rebuild # rebuild image only (use after pnpm add / dep changes)

set -euo pipefail

cd "$(dirname "$0")"

RESET=0
REBUILD=0
for arg in "$@"; do
  case "$arg" in
    --reset) RESET=1; REBUILD=1 ;;
    --rebuild) REBUILD=1 ;;
  esac
done

echo "==> Checking prerequisites..."
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }

# Dockerfile.dev pins FROM local/node:20-alpine to avoid docker.io at build
# time. Auto-tag from an existing node:20-alpine pull if available.
if ! docker image inspect local/node:20-alpine >/dev/null 2>&1; then
  if docker image inspect node:20-alpine >/dev/null 2>&1; then
    echo "    Tagging node:20-alpine as local/node:20-alpine"
    docker tag node:20-alpine local/node:20-alpine
  else
    echo "ERROR: local/node:20-alpine not found."
    echo "       Run: docker pull node:20-alpine && docker tag node:20-alpine local/node:20-alpine"
    exit 1
  fi
fi

if [[ ! -f .env.local ]]; then
  echo "==> .env.local not found, creating from .env.example"
  cp .env.example .env.local
  KEY=$(openssl rand -hex 32)
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" .env.local
  else
    sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" .env.local
  fi
  echo "    ENCRYPTION_KEY generated and written to .env.local"
fi

if [[ $RESET -eq 1 ]]; then
  echo "==> Tearing down and wiping volumes (--reset)"
  docker compose down -v
fi

if [[ $REBUILD -eq 1 ]]; then
  echo "==> Rebuilding app image"
  docker compose build app
fi

echo "==> Starting Postgres + Redis"
docker compose up -d postgres redis

echo "==> Waiting for Postgres + Redis to be healthy..."
for i in {1..30}; do
  PG_STATUS=$(docker compose ps --format json postgres 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 || echo "")
  RD_STATUS=$(docker compose ps --format json redis 2>/dev/null | grep -o '"Health":"[^"]*"' | head -1 || echo "")
  if [[ "$PG_STATUS" == *"healthy"* && "$RD_STATUS" == *"healthy"* ]]; then
    echo "    Postgres + Redis healthy"
    break
  fi
  sleep 1
  if [[ $i -eq 30 ]]; then
    echo "ERROR: services did not become healthy in 30s"
    docker compose ps
    exit 1
  fi
done

# Build the app image on first run (docker will no-op if already built)
if [[ $REBUILD -eq 0 ]]; then
  echo "==> Ensuring app image is built (no-op if cached)"
  docker compose build app >/dev/null
fi

echo "==> Running prisma db push + seed in a single throwaway container"
# Must be one container run: each `docker compose run` gets a fresh anonymous
# node_modules volume, so a Prisma client generated in one invocation is not
# visible to the next.
docker compose run --rm app sh -c "pnpm prisma db push && pnpm tsx src/server/db/seed.ts"

echo ""
echo "==> Starting Next.js dev server in Docker on http://localhost:3000"
echo "    Tailing app logs. Ctrl+C to stop."
echo ""
exec docker compose up app
