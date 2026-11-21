/*
 * Providers « configurés » sur la machine (détection cheap, mémoïsée 30 s) :
 *   claude — binaire `claude` dans le PATH ;
 *   pi     — binaire `pi` dans le PATH, ou ~/.pi/agent existe (pi + sign-in Mistral dessus,
 *            cf. docs/port-pi.md — package pi-mistral-subscription).
 * Sert à l'UI : le badge claude/pi d'une session (sidebar) n'est affiché que quand
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
  const piAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const pi = which(process.env.HOOKED_PI_BIN || 'pi') || fs.existsSync(piAgentDir);
  const claude = which('claude');
  cache = { claude, pi };
  cacheAt = Date.now();
  return cache;
}

export { configuredProviders };
