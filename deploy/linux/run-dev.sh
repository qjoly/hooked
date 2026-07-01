#!/bin/bash
# Lanceur hooked en dev (Vite HMR / auto-reload), appelé par le service systemd user (cf. install.sh).
# systemd démarre avec un PATH minimal → on y remet node/npm. install.sh capture le dossier de
# node à l'installation et le passe via HOOKED_NODE_BIN ; on complète avec les emplacements usuels
# (shims mise, nvm courant, ~/.local/bin). Si `node: command not found` dans /tmp/hooked.err.log,
# ajoute ici le dossier de ton node (`which node`).
export PATH="${HOOKED_NODE_BIN:+$HOOKED_NODE_BIN:}$HOME/.local/share/mise/shims:$HOME/.local/bin:/usr/local/bin:$PATH"

# racine du repo, quelle que soit l'emplacement du clone (ce script est dans deploy/linux/).
cd "$(dirname "$0")/../.." || exit 1

# Install deps if node_modules is missing or package-lock.json changed since last install.
STAMP="node_modules/.package-lock-sha256"
_install_reason=""
if [ ! -d node_modules ]; then
  _install_reason="node_modules missing"
elif [ ! -f "$STAMP" ]; then
  _install_reason="install stamp missing"
elif [ "$(sha256sum package-lock.json | awk '{print $1}')" != "$(cat "$STAMP")" ]; then
  _install_reason="package-lock.json changed"
fi
if [ -n "$_install_reason" ]; then
  echo "[hooked] $_install_reason — running npm ci..."
  npm ci
  sha256sum package-lock.json | awk '{print $1}' > "$STAMP"
  echo "[hooked] npm ci complete."
else
  echo "[hooked] deps up to date, skipping npm ci."
fi

# vite lancé DIRECTEMENT (pas via npm) → systemd surveille le vrai process node,
# donc arrêt/relance propres (pas de vite orphelin au stop/restart).
exec node node_modules/vite/bin/vite.js dev --host 0.0.0.0 --port "${HOOKED_PORT:-4123}"
