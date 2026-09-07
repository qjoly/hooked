#!/usr/bin/env node
'use strict';
/*
 * node-pty ships prebuilt binaries, and on macOS it needs a companion executable — `spawn-helper` —
 * to allocate the PTY. npm does not preserve the executable bit when unpacking those prebuilds, so
 * the file lands as `-rw-r--r--` and every spawn fails with a bare `posix_spawnp failed.` — no hint
 * that a permission bit is the cause. Diagnosed exactly that way here: `/bin/echo` failed as surely
 * as `/bin/zsh`, and `/dev/ptmx` was readable, which ruled out both the shell and the sandbox.
 *
 * Run from `postinstall` so a fresh `npm ci` (or a Node upgrade that re-unpacks) stays working
 * instead of handing the next person the same opaque error. Never fails the install: a terminal that
 * cannot start is a degraded feature, not a reason to break the whole dependency tree.
 */
const fs = require('node:fs');
const path = require('node:path');

const prebuilds = path.join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');
let fixed = 0;
try {
  for (const dir of fs.readdirSync(prebuilds)) {
    const helper = path.join(prebuilds, dir, 'spawn-helper');
    try {
      const mode = fs.statSync(helper).mode;
      if (mode & 0o111) continue;            // déjà exécutable
      fs.chmodSync(helper, (mode | 0o755) & 0o7777);
      fixed++;
    } catch (_) { /* pas de spawn-helper sur cette plateforme (Windows) : rien à faire */ }
  }
} catch (_) { /* node-pty absent : le terminal est simplement indisponible */ }
if (fixed) console.log(`[hooked] node-pty: made ${fixed} spawn-helper binary(ies) executable`);
