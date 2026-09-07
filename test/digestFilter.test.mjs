/*
 * buildSessions must hide our own `claude -p` daily-digest generation runs — they get recorded as
 * ordinary transcripts but are infra, not sessions the user drives. Detected by the fixed opening
 * of their first prompt (DIGEST_PROMPT_PREFIX). Real sessions on the same day stay visible.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-digest-filter-test-' + process.pid);
const PROJECTS = path.join(TMP, 'projects');
const DATA = path.join(TMP, 'data');
process.env.HOOKED_PROJECTS_DIR = PROJECTS;
process.env.HOOKED_DATA_DIR = DATA;

const jl = (obj) => JSON.stringify(obj);
function writeSession(project, id, lines) {
  const dir = path.join(PROJECTS, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map(jl).join('\n') + '\n');
}

let lib;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });

  writeSession('projA', 'sessReal', [
    { type: 'user', timestamp: '2026-07-22T09:00:00.000', cwd: '/repo/projA',
      message: { role: 'user', content: 'Fix the login bug' } },
    { type: 'assistant', timestamp: '2026-07-22T09:01:00.000',
      message: { role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);

  writeSession('projA', 'sessDigest', [
    { type: 'user', timestamp: '2026-07-22T23:59:00.000', cwd: '/repo/projA',
      message: { role: 'user', content: 'You are writing a concise daily engineering digest for 2026-07-22, based on the data below.' } },
    { type: 'assistant', timestamp: '2026-07-22T23:59:10.000',
      message: { role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'text', text: '{"summary":"..."}' }], usage: { input_tokens: 500, output_tokens: 200 } } },
  ]);

  lib = await import('../server/index.js');
});

describe('buildSessions — daily-digest generation runs', () => {
  it('lists real sessions but hides the digest run', () => {
    const ids = lib.buildSessions().map((s) => s.id).sort();
    expect(ids).toContain('sessReal');
    expect(ids).not.toContain('sessDigest');
  });

  it('still scans the digest run at the raw transcript level (only the list hides it)', () => {
    const ids = lib.scanSessions().map((s) => s.id).sort();
    expect(ids).toEqual(['sessDigest', 'sessReal']);
  });
});
