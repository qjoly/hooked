/*
 * Override explicite des providers (server/providers.js + réglage `providers` de
 * server/settings.js) : 'auto' = détection machine, 'on' = forcé actif, 'off' = forcé inactif.
 *
 * Environnement rendu déterministe AVANT l'import des modules : HOOKED_PI_BIN et
 * PI_CODING_AGENT_DIR pointent vers des chemins inexistants → la détection auto de pi
 * vaut false quoi qu'il arrive sur la machine de test.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-providers-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_PI_BIN = '/nonexistent/hooked-test-pi-bin';
process.env.PI_CODING_AGENT_DIR = '/nonexistent/hooked-test-pi-agent';

let applyProviderOverride, configuredProviders, readSettings, writeSettings, piBinaryAvailable;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ applyProviderOverride, configuredProviders } = await import('../server/providers.js'));
  ({ readSettings, writeSettings } = await import('../server/settings.js'));
  ({ piBinaryAvailable } = await import('../server/piAgent.js'));
});

describe('applyProviderOverride (pur)', () => {
  it('auto → résultat de la détection', () => {
    expect(applyProviderOverride(true, 'auto')).toBe(true);
    expect(applyProviderOverride(false, 'auto')).toBe(false);
    expect(applyProviderOverride(true, undefined)).toBe(true);
    expect(applyProviderOverride(false, 'garbage')).toBe(false);
  });
  it('on → forcé actif même sans détection', () => {
    expect(applyProviderOverride(false, 'on')).toBe(true);
    expect(applyProviderOverride(true, 'on')).toBe(true);
  });
  it('off → forcé inactif même si détecté', () => {
    expect(applyProviderOverride(true, 'off')).toBe(false);
    expect(applyProviderOverride(false, 'off')).toBe(false);
  });
});

describe('sanitize du réglage providers (settings.json)', () => {
  it('défaut = auto/auto', () => {
    expect(readSettings().providers).toEqual({ claude: 'auto', pi: 'auto' });
  });
  it('garde on/off, toute valeur inconnue retombe sur auto', () => {
    const s = writeSettings({ providers: { claude: 'off', pi: 'on' } });
    expect(s.providers).toEqual({ claude: 'off', pi: 'on' });
    expect(writeSettings({ providers: { pi: 'yes', claude: 42 } }).providers)
      .toEqual({ claude: 'auto', pi: 'auto' });
  });
});

describe('configuredProviders avec détection auto pi = false (env bidon)', () => {
  it('auto → pi inactif', () => {
    writeSettings({ providers: { pi: 'auto' } });
    expect(configuredProviders().pi).toBe(false);
  });
  it('on → pi forcé actif (utile quand la détection échoue, p.ex. PATH figé sous launchd)', () => {
    writeSettings({ providers: { pi: 'on' } });
    expect(configuredProviders().pi).toBe(true);
  });
  it('off → pi forcé inactif', () => {
    writeSettings({ providers: { pi: 'off' } });
    expect(configuredProviders().pi).toBe(false);
  });
  it('off sur claude masque claude quelle que soit la détection', () => {
    writeSettings({ providers: { claude: 'off', pi: 'auto' } });
    expect(configuredProviders().claude).toBe(false);
  });
  it('le réglage est relu à chaque appel (pas de cache sur le setting)', () => {
    writeSettings({ providers: { pi: 'on' } });
    expect(configuredProviders().pi).toBe(true);
    writeSettings({ providers: { pi: 'off' } });
    expect(configuredProviders().pi).toBe(false);
  });
});

describe('piBinaryAvailable (binaire bidon)', () => {
  it('faux quand HOOKED_PI_BIN pointe vers un chemin inexistant', () => {
    expect(piBinaryAvailable()).toBe(false);
  });
});
