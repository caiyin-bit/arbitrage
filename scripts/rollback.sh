#!/usr/bin/env bash
#
# rollback.sh — manual app rollback to a specific image tag
#
# Usage: /srv/arbitrage/rollback.sh <tag>
#
# This script switches the app container to a given image tag WITHOUT touching
# the database. Use it when deploy.sh already succeeded but a bug was found
# later — at that point the database contains real business data, so a blind
# DB restore would lose changes. If you need to roll back the DB too, choose a
# dump manually from /srv/arbitrage/backups/ and run:
#
#   gunzip -c backups/pre-deploy-XXX.sql.gz \
#     | docker compose exec -T postgres psql -U arbitrage arbitrage
#
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>" >&2
  echo ""
  echo "Available tags on this server:"
  docker image ls ghcr.io/caiyin-bit/arbitrage --format '  {{.Tag}}' 2>/dev/null || true
  exit 2
fi

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_ROOT/.env.production"
CURRENT_TAG_FILE="$DEPLOY_ROOT/.current-tag"

cd "$DEPLOY_ROOT"

log() { echo "[rollback $(date +%H:%M:%S)] $*"; }

CURRENT=""
[[ -f "$CURRENT_TAG_FILE" ]] && CURRENT=$(cat "$CURRENT_TAG_FILE")
log "current tag: ${CURRENT:-unknown}"
log "rolling back to: $TAG"

if ! docker image inspect "ghcr.io/caiyin-bit/arbitrage:$TAG" > /dev/null 2>&1; then
  log "image not present locally, pulling..."
  TAG="$TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull app
fi

TAG="$TAG" docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d app

sleep 5
if curl -fsS http://127.0.0.1:3000/api/health > /dev/null; then
  echo "$TAG" > "$CURRENT_TAG_FILE"
  log "SUCCESS: $TAG is now live"
else
  log "WARNING: app is up but /api/health not responding yet — monitor manually"
  echo "$TAG" > "$CURRENT_TAG_FILE"
fi
