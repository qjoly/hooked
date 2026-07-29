/*
 * Daily digests (server/digests.js). Builds throwaway transcript fixtures under a temp
 * HOOKED_PROJECTS_DIR, then exercises the deterministic per-day aggregation, persistence, and the
 * generate() orchestration with the `claude -p` call stubbed via HOOKED_DIGEST_STUB.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-digests-test-' + process.pid);
const PROJECTS = path.join(TMP, 'projects');
const DATA = path.join(TMP, 'data');
process.env.HOOKED_PROJECTS_DIR = PROJECTS;
process.env.HOOKED_DATA_DIR = DATA;

// Local-time timestamps (no trailing Z) → the local calendar day is fixed regardless of the test
// machine's timezone, so the digest day boundaries are deterministic.
const jl = (obj) => JSON.stringify(obj);
function writeSession(project, id, lines) {
  const dir = path.join(PROJECTS, project);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), lines.map(jl).join('\n') + '\n');
}

let mod;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(PROJECTS, { recursive: true });

  writeSession('projA', 'sessA', [
    { type: 'user', timestamp: '2026-07-22T09:00:00.000', cwd: '/repo/projA', gitBranch: 'feat/digest',
      message: { role: 'user', content: 'Add the daily digest feature' } },
    { type: 'assistant', timestamp: '2026-07-22T09:01:00.000',
      message: { role: 'assistant', model: 'claude-opus-4-8',
        content: [
          { type: 'text', text: 'On it. See https://github.com/LuccaSA/hooked/pull/42' },
          { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/repo/projA/x.js' } },
        ],
        usage: { input_tokens: 100, output_tokens: 50 } } },
    { type: 'assistant', timestamp: '2026-07-22T09:02:00.000',
      message: { role: 'assistant', model: 'claude-opus-4-8',
        content: [{ type: 'tool_use', id: 'tuq', name: 'AskUserQuestion', input: { questions: [{ question: 'Which model?', header: 'Model' }] } }],
        usage: { input_tokens: 10, output_tokens: 5 } } },
  ]);

  writeSession('projB', 'sessB', [
    { type: 'user', timestamp: '2026-07-20T14:00:00.000', cwd: '/repo/projB',
      message: { role: 'user', content: 'Unrelated older work' } },
    { type: 'assistant', timestamp: '2026-07-20T14:01:00.000',
      message: { role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 20, output_tokens: 10 } } },
  ]);

  mod = await import('../server/digests.js');
});

describe('collectSessionsForDay', () => {
  it('returns only sessions active on the given local day', () => {
    const s22 = mod.collectSessionsForDay('2026-07-22');
    expect(s22.map((s) => s.id)).toEqual(['sessA']);
    const s20 = mod.collectSessionsForDay('2026-07-20');
    expect(s20.map((s) => s.id)).toEqual(['sessB']);
    expect(mod.collectSessionsForDay('2026-07-21')).toEqual([]);
  });

  it('captures prompts, tools, PR links and pending questions for the day', () => {
    const [a] = mod.collectSessionsForDay('2026-07-22');
    expect(a.prompts).toContain('Add the daily digest feature');
    expect(a.tools.Edit).toBe(1);
    expect(a.tools.AskUserQuestion).toBe(1);
    expect(a.prLinks).toContain('https://github.com/LuccaSA/hooked/pull/42');
    expect(a.pendingQuestion).toContain('Which model?');
    expect(a.link).toBe('/session/sessA');
    expect(a.projectName).toBe('projA');
    expect(a.gitBranch).toBe('feat/digest');
  });
});

describe('buildBrief / buildPrompt', () => {
  it('includes the session title, id and prompt in the brief', () => {
    const sessions = mod.collectSessionsForDay('2026-07-22');
    const prompt = mod.buildPrompt('2026-07-22', sessions, false);
    expect(prompt).toContain('sessA');
    expect(prompt).toContain('Add the daily digest feature');
    expect(prompt).toContain('OPEN QUESTION');
  });
});

describe('parseModelJson', () => {
  it('extracts JSON from the claude -p envelope', () => {
    const env = JSON.stringify({ type: 'result', result: '```json\n{"summary":"hi"}\n```' });
    expect(mod.parseModelJson(env)).toEqual({ summary: 'hi' });
  });
  it('returns null on unparseable output', () => {
    expect(mod.parseModelJson('not json at all')).toBeNull();
  });
  it('unwraps the envelope even when a login-shell preamble pollutes stdout', () => {
    // The regression: shell noise before the envelope made JSON.parse(stdout) fail, so the old
    // parser grabbed the whole envelope object (no summary/highlights) instead of `.result`.
    const env = JSON.stringify({ type: 'result', result: '{"summary":"real","highlights":["h"]}' });
    const polluted = 'zoxide: detected a possible configuration issue.\n\n' + env;
    expect(mod.parseModelJson(polluted)).toEqual({ summary: 'real', highlights: ['h'] });
  });
});

describe('generateDigest (claude stubbed) + persistence', () => {
  it('merges the LLM enrichment onto the deterministic sessions and persists', async () => {
    process.env.HOOKED_DIGEST_STUB = JSON.stringify({
      summary: 'Built the digest feature.',
      highlights: ['Added Digest tab'],
      perSession: [{ id: 'sessA', accomplished: 'Wrote server/digests.js', pending: 'Open PR review' }],
      blockers: [],
    });
    const d = await mod.generateDigest('2026-07-22');
    expect(d.status).toBe('done');
    expect(d.summary).toBe('Built the digest feature.');
    expect(d.sessions[0].accomplished).toBe('Wrote server/digests.js');
    expect(d.sessions[0].pending).toBe('Open PR review');
    expect(d.pending.some((p) => p.text === 'Which model?')).toBe(true);
    expect(d.totals.sessions).toBe(1);

    // round-trips through disk
    expect(mod.readDigest('2026-07-22').summary).toBe('Built the digest feature.');
    expect(mod.listDigests().map((x) => x.date)).toContain('2026-07-22');
    delete process.env.HOOKED_DIGEST_STUB;
  });

  it('takes the LLM status/statusKind when valid, and validates the kind against the enum', async () => {
    process.env.HOOKED_DIGEST_STUB = JSON.stringify({
      summary: 's', highlights: [],
      perSession: [{ id: 'sessA', accomplished: 'a', pending: 'p', status: 'PR #42 opened, not merged', statusKind: 'in-review' }],
      blockers: [],
    });
    const d = await mod.generateDigest('2026-07-22');
    expect(d.sessions[0].status).toBe('PR #42 opened, not merged');
    expect(d.sessions[0].statusKind).toBe('in-review');

    // An invalid statusKind is dropped, then backfilled by the deterministic fallback.
    process.env.HOOKED_DIGEST_STUB = JSON.stringify({
      summary: 's', highlights: [],
      perSession: [{ id: 'sessA', accomplished: 'a', pending: 'p', status: 'weird', statusKind: 'bogus' }],
      blockers: [],
    });
    const d2 = await mod.generateDigest('2026-07-22');
    expect(d2.sessions[0].status).toBe('weird');           // free-text status kept
    expect(['question', 'in-review', 'in-progress', 'done']).toContain(d2.sessions[0].statusKind);
    delete process.env.HOOKED_DIGEST_STUB;
  });

  it('falls back to a deterministic status when the model omits it (sessA has an open question → question)', async () => {
    process.env.HOOKED_DIGEST_STUB = JSON.stringify({
      summary: 's', highlights: [],
      perSession: [{ id: 'sessA', accomplished: 'a', pending: '' }],   // no status/statusKind
      blockers: [],
    });
    const d = await mod.generateDigest('2026-07-22');
    expect(d.sessions[0].statusKind).toBe('question');     // sessA has a pending AskUserQuestion
    expect(d.sessions[0].status).toBe('Awaiting your answer');
    delete process.env.HOOKED_DIGEST_STUB;
  });

  it('produces an empty digest for a day with no activity, without calling claude', async () => {
    const d = await mod.generateDigest('2026-07-21');
    expect(d.status).toBe('done');
    expect(d.sessions).toEqual([]);
    expect(d.summary).toMatch(/no claude code activity/i);
  });
});

describe('isValidDate / yesterdayLocal', () => {
  it('validates the date shape', () => {
    expect(mod.isValidDate('2026-07-22')).toBe(true);
    expect(mod.isValidDate('nope')).toBe(false);
    expect(mod.isValidDate('2026-7-2')).toBe(false);
  });
  it('yesterdayLocal is a YYYY-MM-DD string', () => {
    expect(mod.yesterdayLocal()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
