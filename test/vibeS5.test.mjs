/*
 * S5 — helpers provider-aware du front (src/lib/format.js) : agentName / stateLabel.
 * Un libellé « Claude is working » sur une session vibe serait un résidu de la migration ;
 * ces helpers sont le point unique derrière tous les labels d'état du dashboard.
 */
import { describe, it, expect } from 'vitest';
import { agentName, stateLabel, STATE_LABEL } from '../src/lib/format.js';

describe('agentName (S5)', () => {
  it('Claude par défaut (non-régression : provider absent ou claude)', () => {
    expect(agentName(undefined)).toBe('Claude');
    expect(agentName(null)).toBe('Claude');
    expect(agentName('claude')).toBe('Claude');
  });
  it('Vibe pour une session vibe', () => {
    expect(agentName('vibe')).toBe('Vibe');
  });
});

describe('stateLabel (S5)', () => {
  it('« working » nomme l’agent selon le provider', () => {
    expect(stateLabel('working', 'claude')).toBe('Claude is working');
    expect(stateLabel('working', 'vibe')).toBe('Vibe is working');
    expect(stateLabel('working', undefined)).toBe('Claude is working'); // défaut non-régression
  });
  it('les autres états restent neutres et identiques au STATE_LABEL historique', () => {
    for (const st of ['waiting', 'attention', 'background', 'idle', 'ended', 'past']) {
      expect(stateLabel(st, 'vibe')).toBe(STATE_LABEL[st]);
      expect(stateLabel(st, 'claude')).toBe(STATE_LABEL[st]);
    }
  });
  it('état inconnu : repli sur la valeur brute', () => {
    expect(stateLabel('weird', 'vibe')).toBe('weird');
  });
});
