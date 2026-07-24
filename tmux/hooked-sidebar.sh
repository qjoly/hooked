#!/usr/bin/env bash
# hooked-sidebar — toggle the hooked sessions sidebar in the current tmux window.
#
# - No sidebar anywhere        -> spawn one as a left split in the current window.
# - Sidebar in current window  -> close it.
# - Sidebar in another window  -> summon it here (join-pane).
#
# The sidebar pane is tagged with pane_title "hooked-sidebar". It follows you across
# sessions on its own (see hooked-tui.cjs); this script only bootstraps/toggles it.
#
# tmux options (set before running):
#   @hooked-sidebar-width   pane width (default 40)
#   @hooked-port            hooked server port (default 4123)
#   @hooked-url             full base URL, overrides @hooked-port
#   @hooked-node            node binary to use (default: node on PATH)
set -euo pipefail

TITLE="hooked-sidebar"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TUI="$SCRIPT_DIR/hooked-tui.cjs"

opt() { tmux show-option -gqv "$1" 2>/dev/null; }

WIDTH="$(opt @hooked-sidebar-width)"; WIDTH="${WIDTH:-40}"
PORT="$(opt @hooked-port)"; PORT="${PORT:-4123}"
URL="$(opt @hooked-url)"
NODE="$(opt @hooked-node)"
[ -n "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"

if [ -z "$NODE" ]; then
  tmux display-message "hooked: node not found on PATH — set '@hooked-node' to your node binary."
  exit 0
fi

CUR_WIN="$(tmux display-message -p '#{window_id}')"
CUR_PANE="$(tmux display-message -p '#{pane_id}')"

# Locate an existing sidebar pane (id + its window), if any.
INFO="$(tmux list-panes -a -F '#{pane_id} #{pane_title} #{window_id}' \
        | awk -v t="$TITLE" '$2==t{print $1" "$3; exit}')"

if [ -n "$INFO" ]; then
  PANE="${INFO%% *}"
  WIN="${INFO##* }"
  if [ "$WIN" = "$CUR_WIN" ]; then
    tmux kill-pane -t "$PANE"
  else
    tmux join-pane -hb -f -l "$WIDTH" -s "$PANE" -t "$CUR_PANE"
    tmux select-pane -t "$PANE" -T "$TITLE"
  fi
  exit 0
fi

# None exists: create it as a left split of the current pane.
ENV="HOOKED_PORT=$PORT HOOKED_SIDEBAR_WIDTH=$WIDTH"
[ -n "$URL" ] && ENV="$ENV HOOKED_MCP_URL=$URL"
NEW="$(tmux split-window -hb -f -l "$WIDTH" -t "$CUR_PANE" -P -F '#{pane_id}' \
        "$ENV exec '$NODE' '$TUI'")"
tmux select-pane -t "$NEW" -T "$TITLE"
