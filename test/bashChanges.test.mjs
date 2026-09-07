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

describe('blob resolution & caching', () => {
  it('a blob that no longer resolves (gc\'d) is skipped, and the memo sees the new line', () => {
    const transcript = path.join(base, 'sess.jsonl');
    const before = changes.buildFileChanges(transcript, SESSION).map((c) => c.name);
    const jsonl = path.join(dataDir, 'bash-changes', SESSION + '.jsonl');
    const root = fs.realpathSync(repo);
    // well-formed SHA, absent from the object database → `cat-file --batch` reports it missing
    fs.appendFileSync(jsonl, JSON.stringify({
      file: path.join(root, 'ghost.txt'), root, old: null,
      new: 'f'.repeat(40), ts: '2026-08-21T10:00:00.000Z',
    }) + '\n');
    // …and a resolvable one, to prove the appended line IS read (memo invalidated by the write)
    const sha = git(['hash-object', '-w', '--stdin'], { input: 'real\n' }).trim();
    fs.appendFileSync(jsonl, JSON.stringify({
      file: path.join(root, 'real.txt'), root, old: null, new: sha, ts: '2026-08-21T10:01:00.000Z',
    }) + '\n');

    const after = changes.buildFileChanges(transcript, SESSION);
    const names = after.map((c) => c.name);
    expect(names).not.toContain('ghost.txt');        // unresolvable blob → op dropped, no fake diff
    expect(names).toContain('real.txt');             // resolvable one merged
    expect(before).not.toContain('real.txt');        // …and it really is new since the first call
    expect(after.find((c) => c.name === 'real.txt').rawOps[0].new).toBe('real\n');
  });
});

describe('orphan sweep (subagent bash)', () => {
  it('a PreToolUse without PostToolUse is swept at the turn boundary (Stop)', () => {
    // subagent Bash calls fire PreToolUse but no PostToolUse → the snapshot stays orphaned
    runHook(hookPayload('PreToolUse', 'tu-orphan'));
    fs.writeFileSync(path.join(repo, 'orphan.txt'), 'made by subagent\n');
    runHook({ hook_event_name: 'Stop', session_id: SESSION, cwd: repo });

    const lines = fs.readFileSync(path.join(dataDir, 'bash-changes', SESSION + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const orphan = lines.find((l) => path.basename(l.file) === 'orphan.txt');
    expect(orphan).toBeTruthy();
    expect(orphan.old).toBeNull();
    expect(orphan.new).toMatch(/^[0-9a-f]{40,64}$/);
    expect(fs.readdirSync(path.join(dataDir, 'bash-pre'))).toEqual([]); // all snapshots consumed
  });

  it('chained sweep: a stale orphan from an old turn does not mask a newer deletion', () => {
    // stale orphan left over from an old turn (file does not exist yet at that point)
    runHook(hookPayload('PreToolUse', 'tu-stale'));
    // the file is then created by a normal pre/post pair (recorded on its own)
    runHook(hookPayload('PreToolUse', 'tu-create'));
    fs.writeFileSync(path.join(repo, 'ephemeral.txt'), 'hi\n');
    runHook(hookPayload('PostToolUse', 'tu-create'));
    // a subagent deletes it: PreToolUse fires, PostToolUse never does
    runHook(hookPayload('PreToolUse', 'tu-del'));
    fs.rmSync(path.join(repo, 'ephemeral.txt'));
    runHook({ hook_event_name: 'Stop', session_id: SESSION, cwd: repo });

    const lines = fs.readFileSync(path.join(dataDir, 'bash-changes', SESSION + '.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l))
      .filter((l) => path.basename(l.file) === 'ephemeral.txt');
    // creation (pre/post pair) then deletion (sweep, via the tu-del snapshot despite tu-stale)
    expect(lines.length).toBe(2);
    expect(lines[0].old).toBeNull();
    expect(lines[0].new).toMatch(/^[0-9a-f]{40,64}$/);
    expect(lines[1].old).toBe(lines[0].new);
    expect(lines[1].new).toBeNull();
    expect(fs.readdirSync(path.join(dataDir, 'bash-pre'))).toEqual([]);
  });
});
