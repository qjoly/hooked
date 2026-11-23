/*
 * Règles de visibilité des providers (src/lib/providers.js) : les badges cc/pi des sessions
 * et le sélecteur de provider de la modale « nouvelle session » ne s'affichent que quand les
 * DEUX providers (claude + pi) sont installés — avec un seul, une pillule n'apprendrait rien.
 */
import { describe, it, expect } from 'vitest';
import { providersBoth, effectiveProvider } from '../src/lib/providers.js';

describe('providersBoth', () => {
  it('vrai seulement quand claude ET pi sont installés', () => {
    expect(providersBoth({ claude: true, pi: true })).toBe(true);
    expect(providersBoth({ claude: true, pi: false })).toBe(false);
    expect(providersBoth({ claude: false, pi: true })).toBe(false);
    expect(providersBoth({ claude: false, pi: false })).toBe(false);
    expect(providersBoth(null)).toBe(false);
    expect(providersBoth(undefined)).toBe(false);
    expect(providersBoth({})).toBe(false);
  });
});

describe('effectiveProvider (nouvelle session)', () => {
  it('les deux installés → le choix de l’utilisateur est respecté', () => {
    const both = { claude: true, pi: true };
    expect(effectiveProvider(both, 'claude')).toBe('claude');
    expect(effectiveProvider(both, 'pi')).toBe('pi');
  });
  it('un seul installé → on fixe le provider dessus, sélecteur caché', () => {
    expect(effectiveProvider({ claude: true, pi: false }, 'pi')).toBe('claude');
    expect(effectiveProvider({ claude: false, pi: true }, 'claude')).toBe('pi');
    expect(effectiveProvider({ claude: false, pi: false }, 'pi')).toBe('claude');
    expect(effectiveProvider(null, 'pi')).toBe('claude');
  });
});

// ── Provider registry on the client (any number of providers) ─────────────────────────────────
import { multiProvider, providerInfo, can, enabledProviderIds, setProviderList, providerBadgeStyle } from '../src/lib/providers.js';
import { agentName, resumeCommand } from '../src/lib/format.js';

describe('multiProvider', () => {
  it('true as soon as two providers are enabled, whichever they are', () => {
    expect(multiProvider({ claude: true, pi: false })).toBe(false);
    expect(multiProvider({ claude: false, pi: true, gemini: true })).toBe(true);
    expect(multiProvider({ claude: true, gemini: true })).toBe(true);
    expect(multiProvider(null)).toBe(false);
  });
  it('effectiveProvider keeps a custom provider when it is enabled', () => {
    expect(effectiveProvider({ claude: true, gemini: true }, 'gemini')).toBe('gemini');
    expect(effectiveProvider({ claude: false, pi: false, gemini: true }, 'pi')).toBe('gemini');
  });
});

describe('provider descriptors', () => {
  const LIST = [
    { id: 'claude', engine: 'claude', label: 'Claude', short: 'cc', color: null, capabilities: { plan: true } },
    { id: 'gemini', engine: 'acp', label: 'Gemini', short: 'gm', color: '#4285f4', capabilities: { plan: false, permissions: true } },
  ];
  it('fall back to the built-ins before the list arrives, and derive a label from an unknown id', () => {
    expect(providerInfo('claude', []).label).toBe('Claude');
    expect(providerInfo('pi', []).label).toBe('Pi');
    expect(providerInfo('my-agent', []).label).toBe('My Agent');
    expect(can('claude', 'plan', [])).toBe(true);
    expect(can('pi', 'plan', [])).toBe(false);
  });
  it('read labels, capabilities and badge colours from the server list', () => {
    expect(providerInfo('gemini', LIST).label).toBe('Gemini');
    expect(can('gemini', 'permissions', LIST)).toBe(true);
    expect(can('gemini', 'plan', LIST)).toBe(false);
    expect(providerBadgeStyle('gemini', LIST)).toBe('--prov:#4285f4');
    expect(providerBadgeStyle('claude', LIST)).toBe('');
    expect(enabledProviderIds({ gemini: true, claude: true, off: false }, LIST)).toEqual(['claude', 'gemini']);
  });
  it('name the agent and its resume command per provider', () => {
    setProviderList(LIST);
    expect(agentName('gemini')).toBe('Gemini');
    expect(agentName(undefined)).toBe('Claude');
    expect(resumeCommand({ id: 'x', provider: 'gemini' })).toBe(''); // resumed through hooked only
    expect(resumeCommand({ id: 'x', provider: 'pi' })).toBe('pi --session-id x');
    expect(resumeCommand({ id: 'x' })).toBe('claude --resume=x');
    setProviderList([]);
  });
});

describe('usesClaudeAccount', () => {
  it('follows the claude provider or the account capability of an enabled provider', async () => {
    const { usesClaudeAccount } = await import('../src/lib/providers.js');
    const list = [
      { id: 'claude', engine: 'claude', capabilities: { account: true } },
      { id: 'pi', engine: 'pi', capabilities: {} },
      { id: 'claude-bridge', engine: 'pi', capabilities: { account: true } },
    ];
    expect(usesClaudeAccount({ claude: true, pi: false }, list)).toBe(true);
    // the claude provider off, Claude through pi on: the account is still in use
    expect(usesClaudeAccount({ claude: false, pi: true, 'claude-bridge': true }, list)).toBe(true);
    expect(usesClaudeAccount({ claude: false, pi: true, 'claude-bridge': false }, list)).toBe(false);
    expect(usesClaudeAccount(null, list)).toBe(false);
  });
});
