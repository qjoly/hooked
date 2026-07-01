#!/bin/bash
# Lanceur hooked en dev (Vite HMR / auto-reload), appelé par le LaunchAgent macOS (cf. install.sh).
# launchd démarre avec un PATH minimal → on y remet node/npm (shims mise + Homebrew arm/intel).
# Si `node: command not found` dans /tmp/hooked.err.log, ajoute ici le dossier de ton node (`which node`).
export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

# racine du repo, quelle que soit l'emplacement du clone (ce script est dans deploy/macos/).
cd "$(dirname "$0")/../.." || exit 1

# vite lancé DIRECTEMENT (pas via npm) → launchd surveille le vrai process node,
# donc arrêt/relance propres (pas de vite orphelin au bootout/logout).
exec node node_modules/vite/bin/vite.js dev --host 0.0.0.0 --port "${HOOKED_PORT:-4123}"
