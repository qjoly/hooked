#!/usr/bin/env bash
# --- tap hooked (wrapper de statusline) -----------------------------------------------------
# Dépose les infos riches de la statusline (effort, rate limits 5 h / 7 j RÉELS du compte,
# remplissage du contexte) dans ~/.claude/hooked/status/<session_id>.json pour que le dashboard
# hooked les affiche. Un fichier par session, écrasé à chaque rendu → zéro croissance.
# Best-effort, jamais bloquant. Nécessite `jq`.
#
# Branché automatiquement par install.cjs : la commande statusLine d'origine est passée via
# la variable HOOKED_SL et ré-exécutée ici pour que ta statusline continue de s'afficher.
#
# Every spawn counts: this runs on each render of each session, and on macOS the EDR sensor
# bills each process creation. Hence a single child process, `jq`: stdin is slurped by a
# builtin, `mkdir` runs only when the directory is missing, and nothing re-execs a shell.
IFS= read -r -d '' input || true

hooked_status_dir="${HOME}/.claude/hooked/status"
hooked_sid=""
if [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9._-]+)\" ]]; then
  hooked_sid="${BASH_REMATCH[1]}"
fi
if [ -n "$hooked_sid" ]; then
  # Buffer jq before writing: redirecting straight onto the target would truncate a good
  # snapshot before jq gets the chance to reject a malformed payload.
  hooked_json=$(jq -c '{session_id, model, effort, rate_limits, context_window, fast_mode, thinking, ts: now}' \
    <<< "$input" 2>/dev/null) \
    && { [ -d "$hooked_status_dir" ] || mkdir -p "$hooked_status_dir" 2>/dev/null; } \
    && printf '%s\n' "$hooked_json" > "${hooked_status_dir}/${hooked_sid}.json" 2>/dev/null
fi

# Ré-affiche la statusline d'origine, en lui réinjectant le même JSON sur stdin.
if [ -n "${HOOKED_SL:-}" ]; then
  eval "$HOOKED_SL" <<< "$input"
fi
# --------------------------------------------------------------------------------------------
