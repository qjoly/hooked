#!/bin/bash
# Keeps node_modules in step with package-lock.json. Shared by deploy/service-run.sh (on every
# service start) and the hooked-launcher app (desktop/launcher), so both agree on when `npm ci` is
# due: the launcher installs before it restarts the service, and the restart must then find the
# stamp current instead of running `npm ci` a second time.
#
#
# Run it from the repository root. It does not cd there itself: the launcher pipes its own copy
# into `bash -s`, so a branch that predates this file is still handled by the same rule.
#
#   npm-deps.sh          run `npm ci` when node_modules is missing or the lockfile changed
#   npm-deps.sh --check  install nothing; exit 1 when an install is due, 0 otherwise
set -e

lock_hash() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum package-lock.json
  else shasum -a 256 package-lock.json
  fi | awk '{print $1}'
}

# Same stamp file as deploy/{linux,macos}/run-dev.sh so the flows agree.
STAMP="node_modules/.package-lock-sha256"
HASH="$(lock_hash)"
stale() { [ ! -d node_modules ] || [ "$HASH" != "$(cat "$STAMP" 2>/dev/null)" ]; }

if [ "${1:-}" = "--check" ]; then
  if stale; then exit 1; fi
  exit 0
fi

if stale; then
  echo "[hooked] dependencies out of date — running npm ci..."
  npm ci
  printf '%s\n' "$HASH" > "$STAMP"
  echo "[hooked] npm ci complete."
fi
