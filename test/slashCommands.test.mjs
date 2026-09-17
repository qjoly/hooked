/*
 * Merging the sources of the « / » palette (server/commands.js).
 * Both parts under test are PURE: no claude binary, no driven session.
 *   - sdkCommands   : SDK SlashCommand[] → palette shape, internal names filtered out.
 *   - mergeCommands : first occurrence wins (custom > curated/extracted > SDK).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sdkCommands, mergeCommands } from '../server/commands.js';

// The real shape returned by `Query.supportedCommands()`.
const SDK = [
  { name: 'code-review', description: 'Review the current diff…', argumentHint: '[low|medium]' },
  { name: 'simplify', description: 'Review the changed code…' },
  { name: 'heapdump', description: 'Write a heap snapshot' },
  { name: 'add-pr-preview', description: 'Use when asked to add a preview (user)' },
];

describe('sdkCommands', () => {
  it('keeps bundled skills, as built-ins', () => {
    expect(sdkCommands(SDK).find((c) => c.name === 'code-review'))
      .toEqual({ name: 'code-review', description: 'Review the current diff…', group: 'builtin' });
  });
  it('drops internal commands', () => {
    expect(sdkCommands(SDK).map((c) => c.name)).not.toContain('heapdump');
  });
  it('truncates descriptions at 160 characters', () => {
    const [c] = sdkCommands([{ name: 'x', description: 'a'.repeat(400) }]);
    expect(c.description).toHaveLength(160);
  });
  it('tolerates a missing list or nameless entries', () => {
    expect(sdkCommands(null)).toEqual([]);
    expect(sdkCommands([{ description: 'nameless' }, null])).toEqual([]);
  });
});

describe('mergeCommands', () => {
  const custom = [{ name: 'add-pr-preview', description: 'local skill', group: 'custom', source: 'skill' }];
  const builtin = [{ name: 'code-review', description: 'curated', group: 'builtin' }, ...sdkCommands(SDK)];

  it('does not duplicate a skill already found by the on-disk scan', () => {
    const names = mergeCommands(custom, builtin).map((c) => c.name);
    expect(names.filter((n) => n === 'add-pr-preview')).toHaveLength(1);
  });
  it('lets custom win over built-in', () => {
    expect(mergeCommands(custom, builtin)[0]).toMatchObject({ group: 'custom', description: 'local skill' });
  });
  it('lets the curated description win over the SDK one', () => {
    expect(mergeCommands([], builtin).find((c) => c.name === 'code-review').description).toBe('curated');
  });
  it('adds the commands only the SDK knows about', () => {
    expect(mergeCommands([], builtin).map((c) => c.name)).toContain('simplify');
  });
});

/*
 * The persisted SDK list — what keeps /code-review in the palette of the « New session » screen,
 * which has no driven session to ask. HOOKED_DATA_DIR is redirected to a tmpdir, and the module is
 * imported fresh so it reads that path.
 */
describe('rememberSdkCommands / persistedSdkCommands', () => {
  let dir, mod, project;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-cmds-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-proj-'));
    process.env.HOOKED_DATA_DIR = dir;
    vi.resetModules();
    mod = await import('../server/commands.js?' + Date.now());
  });
  afterEach(() => {
    delete process.env.HOOKED_DATA_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('replays the bundled skills once nothing is driven', () => {
    mod.rememberSdkCommands(SDK, project);
    expect(mod.persistedSdkCommands().map((c) => c.name)).toContain('code-review');
  });

  it('drops what the source project contributes: it does not exist in another one', () => {
    const skills = path.join(project, '.claude', 'skills');
    fs.mkdirSync(skills, { recursive: true });
    fs.writeFileSync(path.join(skills, 'add-pr-preview.md'), '---\ndescription: local\n---\nbody\n');

    const kept = mod.rememberSdkCommands(SDK, project).map((c) => c.name);
    expect(kept).toContain('code-review');
    expect(kept).not.toContain('add-pr-preview');
  });

  it('returns nothing when no session ever answered', () => {
    expect(mod.persistedSdkCommands()).toEqual([]);
  });
});
