/*
 * Screenshots of a session (server/screenshots.js): the list comes from the transcript's own
 * Read/Write tool_use calls on image paths (plus its sub-agents'), and that same list is the
 * allowlist gating /api/screenshot — a path never read by the session must not be served.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildScreenshots, readScreenshot } from '../server/screenshots.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex'); // en-tête PNG suffisant : on ne décode pas
let root, projects, shots, sessionFile;
const SESSION = 'sess-1';

const toolUse = (name, file, extra = {}) => JSON.stringify({
  type: 'assistant', timestamp: '2026-09-09T10:00:00.000Z', cwd: shots, ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name, input: { file_path: file } }] },
});

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-shots-'));
  projects = path.join(root, 'projects', 'proj');
  shots = path.join(root, 'shots');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(shots, { recursive: true });
  for (const f of ['a.png', 'b.jpg', 'secret.png', 'gone.png']) fs.writeFileSync(path.join(shots, f), PNG);
  fs.writeFileSync(path.join(shots, 'notes.md'), 'x');

  sessionFile = path.join(projects, SESSION + '.jsonl');
  fs.writeFileSync(sessionFile, [
    toolUse('Read', path.join(shots, 'a.png')),
    toolUse('Write', 'b.jpg'),                          // relatif → résolu contre cwd
    toolUse('Read', path.join(shots, 'notes.md')),       // pas une image
    toolUse('Bash', path.join(shots, 'secret.png')),     // pas Read/Write → hors liste
    toolUse('Read', path.join(shots, 'missing.png')),    // absent du disque
    '',
  ].join('\n'));

  // sub-agent de la session : ses captures comptent aussi (agent-browser lancé en sous-agent)
  const subdir = path.join(projects, SESSION, 'subagents');
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'agent-x.jsonl'), toolUse('Read', path.join(shots, 'gone.png')) + '\n');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('buildScreenshots', () => {
  it('lists images read or written by the session and its sub-agents, and nothing else', () => {
    const names = buildScreenshots(sessionFile, SESSION).map((s) => s.name).sort();
    expect(names).toEqual(['a.png', 'b.jpg', 'gone.png']);
  });
});

describe('readScreenshot', () => {
  it('serves an image of the session with its content type', () => {
    const r = readScreenshot(SESSION, path.join(shots, 'a.png'), path.dirname(projects));
    expect(r && r.contentType).toBe('image/png');
    expect(r.buffer.equals(PNG)).toBe(true);
  });

  it('refuses a path the session never read (no arbitrary file read)', () => {
    expect(readScreenshot(SESSION, path.join(shots, 'secret.png'), path.dirname(projects))).toBe(null);
  });

  it('refuses a path traversal towards an allowlisted-looking name', () => {
    const sneaky = path.join(shots, 'sub', '..', 'secret.png');
    expect(readScreenshot(SESSION, sneaky, path.dirname(projects))).toBe(null);
  });

  it('refuses an unknown session', () => {
    expect(readScreenshot('nope', path.join(shots, 'a.png'), path.dirname(projects))).toBe(null);
  });
});
