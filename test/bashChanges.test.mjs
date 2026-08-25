/*
 * Bash file-change capture (hook.cjs) + merge into the Ship changes (changes.js).
 *
 * End-to-end on a throwaway git repo: simulate PreToolUse(Bash), mutate files "as the command
 * would", simulate PostToolUse(Bash), then check that:
 *   - only files actually changed BY the command are recorded (a pre-existing dirty file left
 *     untouched is not), as git blob SHAs;
 *   - buildFileChanges(transcript, sessionId) merges them as full-file edit ops alongside the
 *     transcript's Edit/Write ops, resolved back to content via `git cat-file`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const HOOK = path.join(import.meta.dirname, '..', 'hook.cjs');
const SESSION = 'test-bash-sess';

let base, repo, dataDir, changes;

function git(args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', ...opts });
}
function runHook(payload) {
  execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    env: { ...process.env, HOOKED_DATA_DIR: dataDir, TMUX_PANE: '' },
  });
}
function hookPayload(event, toolUseId = 'tu1') {
  return { hook_event_name: event, tool_name: 'Bash', session_id: SESSION, tool_use_id: toolUseId, cwd: repo };
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-bash-'));
  repo = path.join(base, 'repo');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  execFileSync('git', ['init', repo]);
  fs.writeFileSync(path.join(repo, 'config.json'), '{"version": 1}\n');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'committed\n');
  git(['add', '.']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init']);
  // pre-existing dirt, NOT touched by the command → must not be reported
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty before the command\n');

  // changes.js reads HOOKED_DIR from config.js at import time → set env before the dynamic import
  process.env.HOOKED_DATA_DIR = dataDir;
  changes = await import('../server/changes.js');
});
afterAll(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) {} });

describe('hook.cjs bash capture', () => {
  it('records only the files the command changed, as blob SHAs', () => {
    runHook(hookPayload('PreToolUse'));
    // "the bash command": modifies a clean tracked file + creates a new file
    fs.writeFileSync(path.join(repo, 'config.json'), '{"version": 2}\n');
    fs.writeFileSync(path.join(repo, 'new.json'), '{"fresh": true}\n');
    runHook(hookPayload('PostToolUse'));

    const lines = fs.readFileSync(path.join(dataDir, 'bash-changes', SESSION + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const byName = new Map(lines.map((l) => [path.basename(l.file), l]));

    expect(byName.has('dirty.txt')).toBe(false); // dirty before AND unchanged by the command
    const cfg = byName.get('config.json');
    expect(cfg.old).toMatch(/^[0-9a-f]{40,64}$/); // was clean → old = blob at pre-HEAD
    expect(cfg.new).toMatch(/^[0-9a-f]{40,64}$/);
    const fresh = byName.get('new.json');
    expect(fresh.old).toBeNull(); // did not exist before the command
    expect(fresh.new).toMatch(/^[0-9a-f]{40,64}$/);
    // pre snapshot consumed
    expect(fs.readdirSync(path.join(dataDir, 'bash-pre'))).toEqual([]);
  });

  it('a command that changes nothing records nothing', () => {
    runHook(hookPayload('PreToolUse', 'tu2'));
    runHook(hookPayload('PostToolUse', 'tu2'));
    const lines = fs.readFileSync(path.join(dataDir, 'bash-changes', SESSION + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    expect(lines.length).toBe(2); // still only the two entries from the first command
  });
});

describe('buildFileChanges merge', () => {
  it('merges bash ops (resolved content) with transcript ops', () => {
    // transcript: one regular Edit on an html file, reconstructible (disk = final state)
    const html = path.join(repo, 'page.html');
    fs.writeFileSync(html, '<h1>after</h1>\n');
    const transcript = path.join(base, 'sess.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'assistant', timestamp: '2026-08-20T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: html, old_string: '<h1>before</h1>', new_string: '<h1>after</h1>' } }] },
    }) + '\n');

    const out = changes.buildFileChanges(transcript, SESSION);
    const names = out.map((c) => c.name).sort();
    expect(names).toEqual(['config.json', 'new.json', 'page.html']);

    const cfg = out.find((c) => c.name === 'config.json');
    expect(cfg.tool).toBe('Bash');
    expect(cfg.rawOps[0].bash).toBe(true);
    expect(cfg.rawOps[0].old).toBe('{"version": 1}\n');
    expect(cfg.rawOps[0].new).toBe('{"version": 2}\n');
    expect(cfg.rawOps[0].ts).toBeTruthy(); // per-prompt filter needs a timestamp
    // reconstruction works: disk == final content → net original→final
    expect(cfg.original).toBe('{"version": 1}\n');

    const fresh = out.find((c) => c.name === 'new.json');
    expect(fresh.rawOps[0].old).toBe(''); // created by the command
    expect(fresh.rawOps[0].new).toBe('{"fresh": true}\n');
  });

  it('buildFileChangeFull also sees bash-changed files', () => {
    const transcript = path.join(base, 'sess.jsonl');
    // hook.cjs stores paths under the git toplevel, which is symlink-resolved (macOS /var → /private/var)
    const full = changes.buildFileChangeFull(transcript, path.join(fs.realpathSync(repo), 'config.json'), SESSION);
    expect(full).toBeTruthy();
    expect(full.ops[0].new).toBe('{"version": 2}\n');
  });

  it('without a sessionId (subagent transcript), bash ops are not merged', () => {
    const transcript = path.join(base, 'sess.jsonl');
    const out = changes.buildFileChanges(transcript);
    expect(out.map((c) => c.name)).toEqual(['page.html']);
  });
});
