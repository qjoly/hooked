#!/usr/bin/env bash
# Install the "Start hooked session" macOS Quick Action into ~/Library/Services.
# Selecting text anywhere → right-click → Services → "Start hooked session" starts a
# hooked session with the selection as the first prompt, in the default project
# (Settings → Default project). See README.md.
set -euo pipefail

NAME="Start hooked session.workflow"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$NAME"
DEST_DIR="$HOME/Library/Services"
DEST="$DEST_DIR/$NAME"

if [ ! -d "$SRC" ]; then
  echo "error: workflow bundle not found at $SRC" >&2
  exit 1
fi

mkdir -p "$DEST_DIR"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"

# Refresh the Services cache so the item shows without a re-login.
/System/Library/CoreServices/pbs -flush >/dev/null 2>&1 || true

echo "Installed: $DEST"
echo
echo "Next:"
echo "  1. In hooked → Settings → Default project, pick the folder new sessions launch in."
echo "  2. Select text anywhere → right-click → Services → \"Start hooked session\"."
echo "  3. (Optional) System Settings → Keyboard → Keyboard Shortcuts → Services → assign a key."
echo
echo "Uninstall: rm -rf \"$DEST\" && /System/Library/CoreServices/pbs -flush"
