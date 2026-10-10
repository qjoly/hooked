import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseTranscript } from '../server/transcript.js';

let T;
beforeAll(() => { T = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-prlinks-')); });
afterAll(() => { fs.rmSync(T, { recursive: true, force: true }); });

function write(name, lines) {
  const fp = path.join(T, `${name}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return fp;
}

const prLink = (n, repo = 'acme/hooked') => ({
  type: 'pr-link', prNumber: n, prUrl: `https://github.com/${repo}/pull/${n}`, prRepository: repo,
  timestamp: `2026-09-18T10:0${n}:00.000Z`,
});

describe('prLinks', () => {
  it('lists the PRs journalised by Claude Code, most recent first', () => {
    const s = parseTranscript(write('ok', [
      { type: 'user', cwd: '/repo/hooked', message: { role: 'user', content: 'open a PR' } },
      prLink(1), prLink(2),
    ]), 'sess-ok');
    expect(s.prLinks).toEqual([
      'https://github.com/acme/hooked/pull/2',
      'https://github.com/acme/hooked/pull/1',
    ]);
  });

  it('ignores PR URLs merely quoted in the transcript', () => {
    const s = parseTranscript(write('quoted', [
      // contenu de skill injecté dans le contexte
      { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'see https://github.com/cli/cli/pull/10942' }] } },
      // prose de Claude citant un ticket amont
      { type: 'assistant', message: { id: 'm1', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'upstream fix: https://github.com/angular/angular-cli/pull/31358' }] } },
    ]), 'sess-quoted');
    expect(s.prLinks).toEqual([]);
  });

  it('keeps issue links but not those from injected content', () => {
    const s = parseTranscript(write('issues', [
      { type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'https://github.com/cli/cli/issues/1' }] } },
      { type: 'user', message: { role: 'user', content: 'fix https://github.com/acme/hooked/issues/7' } },
    ]), 'sess-issues');
    expect(s.issueLinks).toEqual(['https://github.com/acme/hooked/issues/7']);
  });
});
