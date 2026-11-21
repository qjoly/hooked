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
