#!/bin/bash
# Installe hooked comme service utilisateur Linux (systemd --user) : démarre AU LOGIN, se relance
# en cas de crash, tourne en dev (Vite HMR / auto-reload). Installe les dépendances npm automatiquement.
#   ./deploy/linux/install.sh            # port 4123
#   HOOKED_PORT=5000 ./deploy/linux/install.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT="hooked-dev"
SERVICE="$HOME/.config/systemd/user/$UNIT.service"
PORT="${HOOKED_PORT:-4123}"

command -v node >/dev/null || { echo "✗ node introuvable dans le PATH — installe-le (mise/nvm/apt) puis relance."; exit 1; }
NODE_BIN="$(dirname "$(command -v node)")"
chmod +x "$DIR/run-dev.sh"

REPO="$(cd "$DIR/../.." && pwd)"
echo "→ Installing npm dependencies (npm ci)..."
(cd "$REPO" && npm ci && sha256sum package-lock.json | awk '{print $1}' > node_modules/.package-lock-sha256)
echo "✓ npm ci complete."

mkdir -p "$HOME/.config/systemd/user"

cat > "$SERVICE" <<EOF
[Unit]
Description=hooked dashboard (dev)
After=network.target

[Service]
Environment=HOOKED_PORT=$PORT
Environment=HOOKED_NODE_BIN=$NODE_BIN
ExecStart=/bin/bash $DIR/run-dev.sh
Restart=always
RestartSec=10
StandardOutput=append:/tmp/hooked.log
StandardError=append:/tmp/hooked.err.log

[Install]
WantedBy=default.target
EOF

# (re)charge proprement
systemctl --user daemon-reload
systemctl --user enable "$UNIT"
systemctl --user restart "$UNIT"

# démarrer même sans session ouverte (équivalent "au boot", pas seulement au login graphique)
loginctl enable-linger "$USER" >/dev/null 2>&1 || true

echo "✅ Service '$UNIT' installé — démarre au login."
echo "   URL     : http://localhost:$PORT   (localhost = contexte sécurisé → notifs natives OK)"
echo "   Logs    : /tmp/hooked.log  (erreurs : /tmp/hooked.err.log ; ou journalctl --user -u $UNIT -f)"
echo "   Statut  : systemctl --user status $UNIT"
echo "   Arrêter : systemctl --user disable --now $UNIT"
