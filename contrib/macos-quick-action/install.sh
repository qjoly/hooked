#!/usr/bin/env bash
# Install the hooked macOS Quick Actions into ~/Library/Services.
# Both start a hooked session from text selected in any app (Settings → Default project
# sets where). See README.md.
#   - "Start hooked session"        : sends the raw selection as the prompt.
#   - "Start hooked session (cite)" : quotes the selection and asks for an instruction,
#                                     then sends "> quoted text\n\ninstruction".
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$HOME/Library/Services"
mkdir -p "$DEST_DIR"

installed=0
for SRC in "$SRC_DIR"/*.workflow; do
  [ -d "$SRC" ] || continue
  NAME="$(basename "$SRC")"
  DEST="$DEST_DIR/$NAME"
  rm -rf "$DEST"
  cp -R "$SRC" "$DEST"
  echo "Installed: $DEST"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "error: no .workflow bundle found next to install.sh ($SRC_DIR)" >&2
  exit 1
fi

# Refresh the Services cache so the items show without a re-login.
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true

echo
echo "Next:"
echo "  1. In hooked → Settings → Default project, pick the folder new sessions launch in."
echo "  2. Select text anywhere → right-click → Services → \"Start hooked session\" (or \"(cite)\")."
echo "  3. (Optional) System Settings → Keyboard → Keyboard Shortcuts → Services → assign a key."
echo
echo "Uninstall: rm -rf \"$DEST_DIR\"/Start\\ hooked\\ session*.workflow && /System/Library/CoreServices/pbs -flush"
