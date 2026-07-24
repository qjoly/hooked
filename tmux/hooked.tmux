#!/usr/bin/env bash
# hooked.tmux — TPM entry point for the hooked sessions sidebar.
#
# Install (TPM):
#   set -g @plugin 'GitBluub/hooked'
#   prefix + I to install, then prefix + <key> (default: h) toggles the sidebar.
#
# Options (set before TPM init):
#   @hooked-sidebar-key     prefix key to toggle the sidebar (default: h)
#   @hooked-sidebar-width   sidebar width in columns (default: 40)
#   @hooked-port            hooked server port (default: 4123)
#   @hooked-url             full base URL, overrides @hooked-port
#   @hooked-node            node binary to use (default: node on PATH)
#
# Requires: node on PATH (or @hooked-node) and a running hooked server.

CURRENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KEY="$(tmux show-option -gqv @hooked-sidebar-key 2>/dev/null)"
KEY="${KEY:-h}"

tmux bind-key "$KEY" run-shell "'$CURRENT_DIR/hooked-sidebar.sh'"
