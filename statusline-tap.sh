#!/usr/bin/env bash
# --- tap hooked (wrapper de statusline) -----------------------------------------------------
# Dépose les infos riches de la statusline (effort, rate limits 5 h / 7 j RÉELS du compte,
# remplissage du contexte) dans ~/.claude/hooked/status/<session_id>.json pour que le dashboard
# hooked les affiche. Un fichier par session, écrasé à chaque rendu → zéro croissance.
# Best-effort, jamais bloquant. Nécessite `jq`.
#
# Branché automatiquement par install.cjs : la commande statusLine d'origine est passée via
# la variable HOOKED_SL et ré-exécutée ici pour que ta statusline continue de s'afficher.
input=$(cat)

hooked_status_dir="${HOME}/.claude/hooked/status"
hooked_sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
case "$hooked_sid" in
  "" | *[!A-Za-z0-9._-]*) : ;;  # id absent ou douteux : on ne tappe pas
  *)
    mkdir -p "$hooked_status_dir" 2>/dev/null && \
    printf '%s' "$input" | jq -c '{session_id, model, effort, rate_limits, context_window, fast_mode, thinking, ts: now}' \
      > "${hooked_status_dir}/${hooked_sid}.json" 2>/dev/null
    ;;
esac

# Ré-affiche la statusline d'origine, en lui réinjectant le même JSON sur stdin.
if [ -n "${HOOKED_SL:-}" ]; then
  printf '%s' "$input" | sh -c "$HOOKED_SL"
fi
# --------------------------------------------------------------------------------------------
