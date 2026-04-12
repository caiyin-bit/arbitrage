#!/usr/bin/env bash
# Local development environment bootstrap
# Usage: ./dev.sh [--reset]

set -euo pipefail

cd "$(dirname "$0")"

RESET=0
if [[ "${1:-}" == "--reset" ]]; then
  RESET=1
fi

echo "==> Checking prerequisites..."
command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }
command -v pnpm >/dev/null || { echo "ERROR: pnpm not found"; exit 1; }

if [[ ! -f .env.local ]]; then
  echo "==> .env.local not found, creating from .env.example"
  cp .env.example .env.local
  KEY=$(openssl rand -hex 32)
  # Replace empty ENCRYPTION_KEY= with generated key (macOS + Linux compatible)
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" .env.local
  else
    sed -i "s|^ENCRYPTION_KEY=.*|ENCRYPTION_KEY=$KEY|" .env.local
  fi
  echo "    ENCRYPTION_KEY generated and written to .env.local"
fi

if [[ $RESET -eq 1 ]]; then
  echo "==> Resetting Docker volumes (--reset flag)"
  docker compose down -v
fi

echo "==> Starting Postgres + Redis"
docker compose up -d postgres redis

echo "==> Waiting for services to be healthy..."
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

if [[ ! -d node_modules ]]; then
  echo "==> Installing dependencies"
  pnpm install
fi

echo "==> Generating Prisma client"
pnpm dotenv -e .env.local -- prisma generate >/dev/null

echo "==> Pushing schema to database"
pnpm db:push

echo "==> Seeding default settings"
pnpm db:seed

echo ""
echo "==> Starting Next.js dev server on http://localhost:3000"
echo "    (Ctrl+C to stop)"
echo ""
exec pnpm dev
