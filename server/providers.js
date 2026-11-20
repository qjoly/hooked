/*
 * Providers « configurés » sur la machine (détection cheap, mémoïsée 30 s) :
 *   claude — binaire `claude` dans le PATH ;
 *   vibe   — binaire `vibe-acp` dans le PATH, ou ~/.vibe existe.
 * Sert à l'UI : le badge claude/mistral d'une session (sidebar) n'est affiché que quand
 * les DEUX providers sont présents — avec un seul provider, le badge n'apprend rien.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

function which(bin) {
  try {
    const r = spawnSync('which', [bin], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

let cache = null;
let cacheAt = 0;

function configuredProviders() {
  if (cache && Date.now() - cacheAt < 30_000) return cache;
  const vibeHome = process.env.VIBE_HOME || path.join(os.homedir(), '.vibe');
  const vibe = which(process.env.HOOKED_VIBE_ACP_BIN || 'vibe-acp') || fs.existsSync(vibeHome);
  const claude = which('claude');
  cache = { claude, vibe };
  cacheAt = Date.now();
  return cache;
}

export { configuredProviders };
