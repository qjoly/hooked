/*
 * Règles de visibilité des providers (src/lib/providers.js) : les badges cc/vibe des sessions
 * et le sélecteur de provider de la modale « nouvelle session » ne s'affichent que quand les
 * DEUX providers (claude + vibe) sont installés — avec un seul, une pillule n'apprendrait rien.
 */
import { describe, it, expect } from 'vitest';
import { providersBoth, effectiveProvider } from '../src/lib/providers.js';

describe('providersBoth', () => {
  it('vrai seulement quand claude ET vibe sont installés', () => {
    expect(providersBoth({ claude: true, vibe: true })).toBe(true);
    expect(providersBoth({ claude: true, vibe: false })).toBe(false);
    expect(providersBoth({ claude: false, vibe: true })).toBe(false);
    expect(providersBoth({ claude: false, vibe: false })).toBe(false);
    expect(providersBoth(null)).toBe(false);
    expect(providersBoth(undefined)).toBe(false);
    expect(providersBoth({})).toBe(false);
  });
});

describe('effectiveProvider (nouvelle session)', () => {
  it('les deux installés → le choix de l’utilisateur est respecté', () => {
    const both = { claude: true, vibe: true };
    expect(effectiveProvider(both, 'claude')).toBe('claude');
    expect(effectiveProvider(both, 'vibe')).toBe('vibe');
  });
  it('un seul installé → on fixe le provider dessus, sélecteur caché', () => {
    expect(effectiveProvider({ claude: true, vibe: false }, 'vibe')).toBe('claude');
    expect(effectiveProvider({ claude: false, vibe: true }, 'claude')).toBe('vibe');
    expect(effectiveProvider({ claude: false, vibe: false }, 'vibe')).toBe('claude');
    expect(effectiveProvider(null, 'vibe')).toBe('claude');
  });
});
