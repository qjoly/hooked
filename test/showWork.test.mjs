/*
 * show_image / show_video / show_audio (hooked MCP tools): parsing into a `show` part, the /api/user-file
 * allowlist for their files, and the HOOKED_SHOW_WORK gate on the MCP tool list.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as lib from '../server/index.js';

describe('toolShowWork', () => {
  it('ignores other tools and calls without a path', () => {
    expect(lib.toolShowWork('Read', { path: '/a.png' }, '/w')).toBeNull();
    expect(lib.toolShowWork('mcp__hooked__show_image', {}, '/w')).toBeNull();
  });
  it('resolves paths, keeps only http(s) urls and sanitizes the lists', () => {
    const r = lib.toolShowWork('mcp__hooked__show_video', {
      path: 'after.webm', compare: '/abs/before.webm', title: 'Pricing', url: 'javascript:alert(1)',
      changes: [{ title: 'Toggle', at: 3.2 }, { at: 1 }, 'junk'],
      checks: [{ name: 'billing', ok: true, at: -1 }],
      summary: [1, 2, 3, 4].map((i) => ({ label: 's' + i, ok: true })),
    }, '/work');
    expect(r).toMatchObject({ kind: 'video', path: '/work/after.webm', compare: '/abs/before.webm', title: 'Pricing', url: '' });
    expect(r.changes).toEqual([{ title: 'Toggle', detail: '', at: 3.2 }]);
    expect(r.checks).toEqual([{ name: 'billing', ok: true, at: null }]);
    expect(r.summary).toHaveLength(3);
  });
  it('maps show_audio to the audio kind', () => {
    expect(lib.toolShowWork('mcp__hooked__show_audio', { path: 'take2.mp3' }, '/work'))
      .toMatchObject({ kind: 'audio', path: '/work/take2.mp3', name: 'take2.mp3' });
  });
});

describe('readUserFile — show_* allowlist', () => {
  let root;
  const pdir = () => path.join(root, 'projects');
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hsw-'));
    for (const f of ['after.mp4', 'before.mp4', 'other.mp4', 'take.mp3']) fs.writeFileSync(path.join(root, f), 'x');
    fs.mkdirSync(path.join(pdir(), '-p'), { recursive: true });
    const line = { type: 'assistant', cwd: root, message: { content: [
      { type: 'tool_use', id: 't1', name: 'mcp__hooked__show_video', input: { path: 'after.mp4', compare: path.join(root, 'before.mp4') } },
      { type: 'tool_use', id: 't2', name: 'mcp__hooked__show_audio', input: { path: 'take.mp3' } },
    ] } };
    fs.writeFileSync(path.join(pdir(), '-p', 's1.jsonl'), JSON.stringify(line) + '\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('serves the shown file and its before side, as inline video', () => {
    const r = lib.readUserFile('s1', '', path.join(root, 'after.mp4'), pdir());
    expect(r).toMatchObject({ contentType: 'video/mp4', attachment: false });
    expect(lib.readUserFile('s1', '', path.join(root, 'before.mp4'), pdir())).not.toBeNull();
  });
  it('serves a shown audio file inline', () => {
    expect(lib.readUserFile('s1', '', path.join(root, 'take.mp3'), pdir()))
      .toMatchObject({ contentType: 'audio/mpeg', attachment: false });
  });
  it('refuses a neighbour that was never shown', () => {
    expect(lib.readUserFile('s1', '', path.join(root, 'other.mp4'), pdir())).toBeNull();
  });
});

describe('MCP show tools gate', () => {
  const list = (env) => {
    const out = execFileSync('node', ['mcp/server.cjs'], {
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      env: { ...process.env, ...env },
    }).toString();
    return JSON.parse(out.split('\n')[0]).result.tools.map((t) => t.name);
  };
  it('lists show_image / show_video only with HOOKED_SHOW_WORK=1', () => {
    expect(list({ HOOKED_SHOW_WORK: '1' })).toEqual(expect.arrayContaining(['show_image', 'show_video', 'show_audio']));
    expect(list({ HOOKED_SHOW_WORK: '' })).not.toContain('show_image');
  });
});
