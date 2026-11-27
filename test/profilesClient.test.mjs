/*
 * Client-side profile helpers (src/lib/profiles.js): picker options and a session's model key.
 */
import { describe, it, expect } from 'vitest';
import { isCompatible, profileModelGroups, sessionModelKey } from '../src/lib/profiles.js';

describe('isCompatible', () => {
  it('is true only for a compatible profile', () => {
    expect(isCompatible({ kind: 'compatible' })).toBe(true);
    expect(isCompatible({ kind: 'anthropic' })).toBe(false);
    expect(isCompatible(null)).toBe(false);
    expect(isCompatible(undefined)).toBe(false);
  });
});

describe('profileModelGroups', () => {
  const models = [{ id: 'qwen/a', label: 'Qwen A' }, { id: 'qwen/b' }];

  it('makes one unlabelled group of [id, label] pairs, label defaulting to the id', () => {
    expect(profileModelGroups(models)).toEqual([{ label: '', opts: [['qwen/a', 'Qwen A'], ['qwen/b', 'qwen/b']] }]);
  });

  it('keeps the current model listed, first, when the list lacks it', () => {
    const g = profileModelGroups(models, 'qwen/gone');
    expect(g[0].opts[0]).toEqual(['qwen/gone', 'qwen/gone']);
    expect(g[0].opts).toHaveLength(3);
  });

  it('does not duplicate a current model that is in the list', () => {
    expect(profileModelGroups(models, 'qwen/a')[0].opts).toHaveLength(2);
  });

  it('still offers the current model while the list is empty or not loaded', () => {
    expect(profileModelGroups([], 'qwen/a')).toEqual([{ label: '', opts: [['qwen/a', 'qwen/a']] }]);
    expect(profileModelGroups(undefined, 'qwen/a')[0].opts).toHaveLength(1);
  });

  it('has no group at all with nothing to show', () => {
    expect(profileModelGroups([], '')).toEqual([]);
    expect(profileModelGroups(null)).toEqual([]);
  });
});

describe('sessionModelKey', () => {
  it('is the family alias or version for a Claude session, from the transcript\'s id', () => {
    expect(sessionModelKey({ model: 'claude-opus-4-8-20251101' })).toBe('claude-opus-4-8');
    expect(sessionModelKey({ model: 'claude-sonnet-5', profile: null })).toBe('claude-sonnet-5');
  });

  it('prefers the persisted launch model', () => {
    expect(sessionModelKey({ launchModel: 'opus', model: 'claude-sonnet-4-6' })).toBe('opus');
  });

  it('uses the model of a compatible server as it is, where the alias would be empty', () => {
    const profile = { id: 'lm', kind: 'compatible' };
    expect(sessionModelKey({ profile, model: 'qwen/qwen3-coder-30b' })).toBe('qwen/qwen3-coder-30b');
    expect(sessionModelKey({ profile, launchModel: 'qwen/qwen3.8-27b', model: 'qwen/qwen3-coder-30b' })).toBe('qwen/qwen3.8-27b');
  });

  it('does the same for a profile that was removed (kind unknown)', () => {
    expect(sessionModelKey({ profile: { id: 'gone', kind: null, missing: true }, model: 'qwen/x' })).toBe('qwen/x');
  });

  it('keeps the alias for a session on an anthropic profile', () => {
    expect(sessionModelKey({ profile: { id: 'work', kind: 'anthropic' }, model: 'claude-opus-4-7' })).toBe('claude-opus-4-7');
  });

  it('is empty with nothing known', () => {
    expect(sessionModelKey(null)).toBe('');
    expect(sessionModelKey({})).toBe('');
  });
});
