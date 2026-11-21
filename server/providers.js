/*
 * Providers « configurés » sur la machine : détection auto (mémoïsée 30 s)
 *   claude — binaire `claude` dans le PATH ;
 *   pi     — binaire `pi` dans le PATH, ou ~/.pi/agent existe (pi + sign-in Mistral dessus,
 *            cf. docs/port-pi.md — package pi-mistral-subscription),
 * surchargée par le réglage explicite de settings.json (`providers: { claude, pi }`, défaut
 * 'auto' chacun, relu à chaque appel) : 'on' force le provider actif (utile quand la détection
 * échoue, p.ex. PATH figé sous launchd avec pi installé hors PATH + HOOKED_PI_BIN), 'off' le
 * masque de l'UI et refuse son lancement (err400 clair côté agent.js).
 *
 * Sert à l'UI : le badge claude/pi d'une session (sidebar) n'est affiché que quand
 * les DEUX providers sont présents — avec un seul provider, le badge n'apprend rien.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { readSettings } from './settings.js';

function which(bin) {
  try {
    const r = spawnSync('which', [bin], { stdio: 'ignore' });
    return r.status === 0;
  } catch (_) {
    return false;
  }
}

// Applique le réglage 'auto'|'on'|'off' sur le résultat de la détection auto. Pure → testée.
export function applyProviderOverride(autoDetected, setting) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return autoDetected;
}

// Seule la détection auto (which/ls) est mémoïsée 30 s — les réglages sont relus à chaque appel
// (readSettings a son propre cache mtime) pour qu'un changement de paramètre soit pris en compte
// immédiatement, sans attendre l'expiration.
let autoCache = null;
let autoAt = 0;

function autoDetect() {
  if (autoCache && Date.now() - autoAt < 30_000) return autoCache;
  const piAgentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  const piAuto = which(process.env.HOOKED_PI_BIN || 'pi') || fs.existsSync(piAgentDir);
  const claudeAuto = which('claude');
  autoCache = { claude: claudeAuto, pi: piAuto };
  autoAt = Date.now();
  return autoCache;
}

function configuredProviders() {
  const auto = autoDetect();
  let prov = { claude: 'auto', pi: 'auto' };
  try { prov = { ...prov, ...(readSettings().providers || {}) }; } catch (_) {}
  return {
    claude: applyProviderOverride(auto.claude, prov.claude),
    pi: applyProviderOverride(auto.pi, prov.pi),
  };
}

export { configuredProviders };
