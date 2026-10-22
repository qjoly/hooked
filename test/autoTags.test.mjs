import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

process.env.HOOKED_DATA_DIR = path.join(os.tmpdir(), 'hooked-autotags-test-' + process.pid);
const { parseSuggestion, vocabulary } = await import('../server/autoTags.js');

const envelope = (text) => JSON.stringify([{ type: 'system' }, { type: 'result', result: text }]);

describe('parseSuggestion', () => {
  it('normalizes, dedups, drops status tags and caps at 3', () => {
    const out = parseSuggestion(envelope('```json\n{"tags": ["#Bug", "bug", "Auth Flow", "pr-approved", 4, "infra", "docs"]}\n```'));
    expect(out).toEqual(['bug', 'auth-flow', 'infra']);
  });
  it('returns nothing on unparseable output', () => {
    expect(parseSuggestion('zsh: command not found')).toEqual([]);
  });
});

describe('vocabulary', () => {
  it('ranks by usage and excludes PR status tags', () => {
    expect(vocabulary({ a: ['bug', 'pr-approved'], b: ['bug', 'feature'] })).toEqual(['bug', 'feature']);
  });
});
