#!/bin/bash
# Installe hooked comme service utilisateur macOS (LaunchAgent) : démarre AU LOGIN, se relance
# en cas de crash, tourne en dev (Vite HMR / auto-reload). Installe les dépendances npm automatiquement.
#   ./deploy/macos/install.sh            # port 4123
#   HOOKED_PORT=5000 ./deploy/macos/install.sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.hooked.dev"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${HOOKED_PORT:-4123}"

command -v node >/dev/null || { echo "✗ node introuvable dans le PATH — installe-le (mise/Homebrew) puis relance."; exit 1; }
chmod +x "$DIR/run-dev.sh"

REPO="$(cd "$DIR/../.." && pwd)"
echo "→ Installing npm dependencies (npm ci)..."
(cd "$REPO" && npm ci && shasum -a 256 package-lock.json | awk '{print $1}' > node_modules/.package-lock-sha256)
echo "✓ npm ci complete."

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/bash</string><string>$DIR/run-dev.sh</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>HOOKED_PORT</key><string>$PORT</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/hooked.log</string>
  <key>StandardErrorPath</key><string>/tmp/hooked.err.log</string>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
EOF

# (re)charge proprement
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

echo "✅ Service '$LABEL' installé — démarre au login."
echo "   URL     : http://localhost:$PORT   (localhost = contexte sécurisé → notifs natives OK)"
echo "   Logs    : /tmp/hooked.log  (erreurs : /tmp/hooked.err.log)"
echo "   Arrêter : launchctl bootout gui/\$(id -u)/$LABEL"
