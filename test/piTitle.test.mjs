/*
 * Session title suggested by a small Mistral model for new pi sessions: output cleanup.
 */
import { describe, it, expect } from 'vitest';
import { cleanTitle } from '../server/piCli.js';

describe('cleanTitle', () => {
  it('keeps a clean title as is', () => {
    expect(cleanTitle('Sidebar refresh after pi session end')).toBe('Sidebar refresh after pi session end');
  });

  it('strips quotes, labels, markdown and the trailing period', () => {
    expect(cleanTitle('"Dark mode toggle."')).toBe('Dark mode toggle');
    expect(cleanTitle('Titre : « Pod OOMKill argocd »')).toBe('Pod OOMKill argocd');
    expect(cleanTitle('**Fix the login flow**')).toBe('Fix the login flow');
  });

  it('keeps only the first non-empty line and capitalizes it', () => {
    expect(cleanTitle('\n  corriger le rafraîchissement\nExplanation: ...')).toBe('Corriger le rafraîchissement');
  });

  it('caps the length on a word boundary', () => {
    const t = cleanTitle('word '.repeat(40));
    expect(t.length).toBeLessThanOrEqual(80);
    expect(t.endsWith('…')).toBe(true);
    expect(t).not.toMatch(/\s…$/);
  });

  it('returns an empty string for nothing usable', () => {
    expect(cleanTitle('')).toBe('');
    expect(cleanTitle('  "" ')).toBe('');
    expect(cleanTitle(null)).toBe('');
  });
});
