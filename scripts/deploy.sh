#!/usr/bin/env bash
#
# deploy.sh — production deploy entrypoint
#
# Usage: /srv/arbitrage/deploy.sh <tag>
#   Triggered via SSH from GitHub Actions release.yml.
#   Requires the deploy user to be in the docker group and
#   `docker login ghcr.io` already completed.
#
# Environment variables:
#   DEPLOY_ROOT      default /srv/arbitrage
#   HEALTH_ATTEMPTS  default 5 (each HEALTH_INTERVAL seconds apart)
#   HEALTH_INTERVAL  default 12
#   NOTIFY_CMD       default $DEPLOY_ROOT/scripts/notify-deploy.sh
#   SKIP_PULL        default 0; set to 1 to skip `docker pull` (integration tests)
#   SKIP_MIGRATE     default 0; set to 1 to skip prisma migrate deploy (integration tests)
#   HEALTH_URL       default http://127.0.0.1:3000/api/health
#
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "usage: $0 <tag>" >&2
  exit 2
fi

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"
HEALTH_ATTEMPTS="${HEALTH_ATTEMPTS:-5}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-12}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"
NOTIFY_CMD="${NOTIFY_CMD:-$DEPLOY_ROOT/scripts/notify-deploy.sh}"
COMPOSE_FILE="$DEPLOY_ROOT/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_ROOT/.env.production"
IMAGE_REPO="ghcr.io/caiyin-bit/arbitrage"
CURRENT_TAG_FILE="$DEPLOY_ROOT/.current-tag"
FAILED_TAG_FILE="$DEPLOY_ROOT/.failed-tag"

cd "$DEPLOY_ROOT"

START_TS=$(date +%s)
STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$DEPLOY_ROOT/backups/pre-deploy-$STAMP.sql.gz"
PREV_TAG=""
if [[ -f "$CURRENT_TAG_FILE" ]]; then
  PREV_TAG=$(cat "$CURRENT_TAG_FILE")
fi
ROLLED_BACK=false

log() { echo "[deploy $(date +%H:%M:%S)] $*"; }

notify() {
  # Failure here is non-fatal; deploy.sh should not exit because notifications are broken
  local kind=$1 reason=${2:-}
  if [[ -x "$NOTIFY_CMD" ]]; then
    DEPLOY_KIND="$kind" \
    DEPLOY_TAG="$TAG" \
    DEPLOY_PREV_TAG="$PREV_TAG" \
    DEPLOY_DURATION="$(($(date +%s) - START_TS))" \
    DEPLOY_REASON="$reason" \
    DEPLOY_ROLLED_BACK="$ROLLED_BACK" \
    "$NOTIFY_CMD" || log "notify failed (non-fatal)"
  else
    log "no notify cmd at $NOTIFY_CMD, skipping"
  fi
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ---------------------------------------------------------------------------
# Step 1: Backup DB
# ---------------------------------------------------------------------------
log "step 1: pg_dump → $DUMP"
mkdir -p "$DEPLOY_ROOT/backups"
compose exec -T postgres pg_dump -U arbitrage arbitrage | gzip -9 > "$DUMP"
log "backup size: $(du -h "$DUMP" | cut -f1)"

# ---------------------------------------------------------------------------
# Step 2: Pull new image
# ---------------------------------------------------------------------------
# SKIP_PULL=1 is used by integration tests which pre-stage images via `docker tag`
if [[ "${SKIP_PULL:-0}" != "1" ]]; then
  log "step 2: docker pull $IMAGE_REPO:$TAG"
  TAG="$TAG" compose pull app
else
  log "step 2: SKIP_PULL=1, skipping docker pull"
fi

# ---------------------------------------------------------------------------
# Step 3: Migration (in a throwaway container, does not touch running app)
# ---------------------------------------------------------------------------
if [[ "${SKIP_MIGRATE:-0}" != "1" ]]; then
  log "step 3: prisma migrate deploy (throwaway container)"
  if ! TAG="$TAG" compose run --rm \
         --no-deps \
         -e DATABASE_URL="postgresql://arbitrage:${DB_PASSWORD}@postgres:5432/arbitrage" \
         app node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma; then
    log "ERROR: migration failed — NOT restarting app. Manual intervention required."
    echo "$TAG" > "$FAILED_TAG_FILE"
    notify "deploy_failed" "prisma migrate deploy failed — check logs at $DEPLOY_ROOT"
    exit 3
  fi
else
  log "step 3: SKIP_MIGRATE=1, skipping prisma migrate deploy"
fi

# ---------------------------------------------------------------------------
# Step 4: Switch app container to new image
# ---------------------------------------------------------------------------
log "step 4: docker compose up -d app with TAG=$TAG"
TAG="$TAG" compose up -d app

# ---------------------------------------------------------------------------
# Step 5: Health check
# ---------------------------------------------------------------------------
log "step 5: health check ($HEALTH_ATTEMPTS x ${HEALTH_INTERVAL}s)"
HEALTH_OK=0
for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
  sleep "$HEALTH_INTERVAL"
  if curl -fsS "$HEALTH_URL" > /dev/null; then
    log "  attempt $i/$HEALTH_ATTEMPTS: OK"
    HEALTH_OK=$((HEALTH_OK + 1))
  else
    log "  attempt $i/$HEALTH_ATTEMPTS: FAIL"
  fi
done

if [[ $HEALTH_OK -lt "$HEALTH_ATTEMPTS" ]]; then
  log "ERROR: health check failed ($HEALTH_OK/$HEALTH_ATTEMPTS succeeded)"

  if [[ -n "$PREV_TAG" ]]; then
    log "rollback: switching app to $PREV_TAG"
    TAG="$PREV_TAG" compose up -d app || log "rollback up failed"

    log "rollback: restoring DB from $DUMP"
    if gunzip -c "$DUMP" | compose exec -T postgres psql -U arbitrage -d arbitrage > /dev/null; then
      ROLLED_BACK=true
      log "rollback complete"
    else
      log "ERROR: DB restore failed — service may be in inconsistent state"
    fi
  else
    log "no previous tag; stopping app (first deploy failure)"
    compose stop app || true
  fi

  echo "$TAG" > "$FAILED_TAG_FILE"
  notify "deploy_failed" "health check failed after $HEALTH_ATTEMPTS attempts"
  exit 4
fi

# ---------------------------------------------------------------------------
# Step 6: Success
# ---------------------------------------------------------------------------
echo "$TAG" > "$CURRENT_TAG_FILE"
rm -f "$FAILED_TAG_FILE"
log "SUCCESS: $TAG is now live (prev: ${PREV_TAG:-none})"
notify "deploy_succeeded"
