#!/usr/bin/env bash
# hooked-whoami — depuis une session Claude Code lancée par hooked, affiche son propre
# détail hooked (session_id, modèle, effort, mode, projet, état, coût…).
#
# La session ne connaît que son pane tmux ($TMUX_PANE) ; le serveur hooked fait le pont
# pane -> session_id via /api/whoami. Nécessite que le serveur hooked tourne.
#
#   HOOKED_PORT      port du serveur hooked (défaut 4123)
#   HOOKED_MCP_URL   URL de base (prioritaire sur HOOKED_PORT)
#
# Options : --raw (JSON brut, sans jq) ; --id (imprime seulement le session_id).
set -euo pipefail

base="${HOOKED_MCP_URL:-http://127.0.0.1:${HOOKED_PORT:-4123}}"
base="${base%/}"

if [ -z "${TMUX_PANE:-}" ]; then
  echo "hooked-whoami: \$TMUX_PANE vide — cette session ne tourne pas dans tmux (donc pas via hooked)." >&2
  exit 1
fi

resp="$(curl -fsS "${base}/api/whoami?pane=$(printf %s "$TMUX_PANE" | jq -sRr @uri)")" || {
  echo "hooked-whoami: impossible de joindre hooked sur ${base} (le serveur tourne-t-il ?)." >&2
  exit 1
}

case "${1:-}" in
  --raw) printf '%s\n' "$resp" ;;
  --id)  printf '%s\n' "$resp" | jq -r '.id' ;;
  *)     printf '%s\n' "$resp" | jq '{id, project, model, launchModel, effort, permissionMode, state, tmuxPane, tmuxAttach}' ;;
esac
