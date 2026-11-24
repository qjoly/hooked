#!/bin/bash
# Service launcher shared by launchd (macOS) and systemd --user (Linux) — see
# the service-install task in mise.toml, which bakes HOOKED_MODE / PORT / HOST
# into the service environment and runs this through `mise x` (node/npm on PATH).
#
# Designed to survive a branch switch: on every (re)start it re-runs `npm ci`
# when package-lock.json changed, and in prod mode rebuilds when HEAD moved
# since the last build. The service manager restarts us on crash, so a tree
# left half-switched converges on the next restart.
#
#   HOOKED_MODE=prod (default) → node build (rebuilds first if stale)
#   HOOKED_MODE=dev            → Vite dev server (HMR, /api in-process,
#                                follows branch switches live)
set -e
cd "$(dirname "$0")/.." || exit 1

MODE="${HOOKED_MODE:-prod}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4123}"
# adapter-node caps request bodies at 512K by default, far below a pasted screenshot sent as a
# base64 data-URL (/api/upload-image). 21M of base64 ≈ the 15 MB decoded cap of server/images.js.
# `npm start` sets the same default; the service runs `node build` directly, so set it here too.
export BODY_SIZE_LIMIT="${BODY_SIZE_LIMIT:-21M}"

bash deploy/npm-deps.sh

if [ "$MODE" = "dev" ]; then
  # Vite launched DIRECTLY (not via npm) so the service manager watches the
  # real node process → clean stop/restart, no orphan. strictPort: fail
  # loudly if a stray `node build` still squats the port (see AGENTS.md).
  exec node node_modules/vite/bin/vite.js dev --host "$HOST" --port "$PORT" --strictPort
fi

# prod: rebuild when the built commit is not HEAD (typically after a branch
# switch). The stamp lives in build/ so a fresh build resets it; the `build`
# mise task writes it too, so `mise run deploy` does not trigger a second
# build here. Uncommitted source changes are NOT detected — build explicitly
# (`mise run deploy`) for those.
SRC_STAMP="build/.hooked-src-commit"
HEAD="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
if [ ! -f build/index.js ] || [ "$HEAD" != "$(cat "$SRC_STAMP" 2>/dev/null)" ]; then
  echo "[hooked] build out of date (HEAD $HEAD) — running npm run build..."
  npm run build
  printf '%s\n' "$HEAD" > "$SRC_STAMP"
  echo "[hooked] build complete."
fi
exec node build
