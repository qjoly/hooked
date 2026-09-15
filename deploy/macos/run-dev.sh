#!/bin/bash
# Lanceur hooked en dev (Vite HMR / auto-reload), appelé par le LaunchAgent macOS (cf. install.sh).
# launchd démarre avec un PATH minimal → on y remet node/npm (shims mise + Homebrew arm/intel).
# Si `node: command not found` dans /tmp/hooked.err.log, ajoute ici le dossier de ton node (`which node`).
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# racine du repo, quelle que soit l'emplacement du clone (ce script est dans deploy/macos/).
cd "$(dirname "$0")/../.." || exit 1

# Install deps if node_modules is missing or package-lock.json changed since last install.
STAMP="node_modules/.package-lock-sha256"
_install_reason=""
if [ ! -d node_modules ]; then
  _install_reason="node_modules missing"
elif [ ! -f "$STAMP" ]; then
  _install_reason="install stamp missing"
elif [ "$(shasum -a 256 package-lock.json | awk '{print $1}')" != "$(cat "$STAMP")" ]; then
  _install_reason="package-lock.json changed"
fi
if [ -n "$_install_reason" ]; then
  echo "[hooked] $_install_reason — running npm ci..."
  npm ci
  shasum -a 256 package-lock.json | awk '{print $1}' > "$STAMP"
  echo "[hooked] npm ci complete."
else
  echo "[hooked] deps up to date, skipping npm ci."
fi

# vite lancé DIRECTEMENT (pas via npm) → launchd surveille le vrai process node,
# donc arrêt/relance propres (pas de vite orphelin au bootout/logout).
exec node node_modules/vite/bin/vite.js dev --port "${HOOKED_PORT:-4123}"
