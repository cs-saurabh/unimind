#!/bin/sh
# Gate startup on real dependency readiness, then bootstrap indexes (idempotent) and
# launch the worker. This is what makes the compose come up cleanly "one after another"
# even though the Helix image ships no health tooling for a depends_on healthcheck.
set -e

HELIX_URL="${HELIX_URL:-http://helix:6969}"
III_URL="${III_URL:-ws://iii:49134}"
III_HOST="$(echo "$III_URL" | sed -E 's#^ws://([^:/]+):([0-9]+).*#\1#')"
III_PORT="$(echo "$III_URL" | sed -E 's#^ws://([^:/]+):([0-9]+).*#\2#')"

echo "[worker] waiting for Helix at $HELIX_URL ..."
until curl -s -o /dev/null "$HELIX_URL/"; do sleep 1; done
echo "[worker] Helix is up."

echo "[worker] waiting for iii engine at $III_HOST:$III_PORT ..."
until nc -z "$III_HOST" "$III_PORT"; do sleep 1; done
echo "[worker] iii engine is up."

echo "[worker] bootstrapping Helix indexes (idempotent) ..."
npx tsx src/db/bootstrap.ts

echo "[worker] starting unimind worker ..."
exec npx tsx src/iii/worker.ts
