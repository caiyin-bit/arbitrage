#!/usr/bin/env bash
#
# notify-deploy.sh — deploy.sh's Telegram notification callback
#
# Reads from environment variables:
#   DEPLOY_KIND        deploy_succeeded | deploy_failed
#   DEPLOY_TAG         the tag being deployed
#   DEPLOY_PREV_TAG    previous tag (empty string for first deploy)
#   DEPLOY_DURATION    seconds
#   DEPLOY_REASON      failure reason (only for deploy_failed)
#   DEPLOY_ROLLED_BACK true | false (only for deploy_failed)
#
# And from $DEPLOY_ROOT/.env.production:
#   TELEGRAM_BOT_TOKEN
#   TELEGRAM_CHAT_ID
#
# Message formats MUST match src/server/services/notifier/format.ts byte-for-byte.
# When changing one, change the other + update tests/unit/telegram-format.test.ts.
#
set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-/srv/arbitrage}"

if [[ -f "$DEPLOY_ROOT/.env.production" ]]; then
  # shellcheck disable=SC1091
  set -a
  . "$DEPLOY_ROOT/.env.production"
  set +a
fi

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
  echo "[notify] telegram not configured, skipping" >&2
  exit 0
fi

KIND="${DEPLOY_KIND:-unknown}"
TAG="${DEPLOY_TAG:-unknown}"
PREV="${DEPLOY_PREV_TAG:-}"
DUR="${DEPLOY_DURATION:-0}"
REASON="${DEPLOY_REASON:-}"
ROLLED="${DEPLOY_ROLLED_BACK:-false}"

case "$KIND" in
  deploy_succeeded)
    if [[ -n "$PREV" ]]; then
      MSG="🚀 Deploy succeeded: ${TAG}
Previous: ${PREV}
Duration: ${DUR}s"
    else
      MSG="🚀 Deploy succeeded: ${TAG}
First deploy
Duration: ${DUR}s"
    fi
    ;;
  deploy_failed)
    if [[ "$ROLLED" == "true" && -n "$PREV" ]]; then
      MSG="❌ Deploy failed: ${TAG}
Rolled back to ${PREV}
Reason: ${REASON}"
    else
      MSG="❌ Deploy failed: ${TAG}
Service may be down — manual intervention required
Reason: ${REASON}"
    fi
    ;;
  *)
    MSG="⚠️ Unknown deploy event: $KIND for $TAG"
    ;;
esac

curl -fsS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" \
  --data-urlencode "text=${MSG}" \
  > /dev/null

echo "[notify] sent $KIND for $TAG"
