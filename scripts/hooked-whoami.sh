#!/usr/bin/env bash
# hooked-whoami — depuis une session Claude Code, affiche son propre détail hooked
# (session_id, modèle, effort, mode, projet, état, coût…).
#
# La session lit son id dans $CLAUDE_CODE_SESSION_ID (posé par Claude Code dans
# l'environnement des appels d'outil) et interroge directement /api/session. Avant la migration
# hors tmux, l'identité disponible dans l'environnement était le pane tmux ($TMUX_PANE), et il
# fallait un endpoint /api/whoami pour faire le pont pane -> session_id.
#
#   HOOKED_PORT      port du serveur hooked (défaut 4123)
#   HOOKED_MCP_URL   URL de base (prioritaire sur HOOKED_PORT)
#
# Options : --raw (JSON brut, sans jq) ; --id (imprime seulement le session_id).
set -euo pipefail

base="${HOOKED_MCP_URL:-http://127.0.0.1:${HOOKED_PORT:-4123}}"
base="${base%/}"

sid="${CLAUDE_CODE_SESSION_ID:-}"
if [ -z "$sid" ]; then
  echo "hooked-whoami: \$CLAUDE_CODE_SESSION_ID vide — à lancer depuis un appel d'outil d'une session Claude Code." >&2
  exit 1
fi

if [ "${1:-}" = "--id" ]; then printf '%s\n' "$sid"; exit 0; fi

resp="$(curl -fsS "${base}/api/session?id=$(printf %s "$sid" | jq -sRr @uri)")" || {
  echo "hooked-whoami: impossible de joindre hooked sur ${base} (le serveur tourne-t-il ?)." >&2
  exit 1
}

case "${1:-}" in
  --raw) printf '%s\n' "$resp" ;;
  *)     printf '%s\n' "$resp" | jq '{id, project, model, launchModel, effort, permissionMode, state, live, link}' ;;
esac
