/*
 * SendUserFile : classification des fichiers (toolSendFiles), rattachement sur les `parts` de la
 * conversation (buildConversation), et service sécurisé par liste blanche (readUserFile).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as lib from '../server/index.js';

describe('toolSendFiles', () => {
  it('renvoie null pour un autre outil', () => {
    expect(lib.toolSendFiles('Read', { files: ['/a.png'] }, '/cwd')).toBeNull();
    expect(lib.toolSendFiles('SendUserFile', {}, '/cwd')).toBeNull();
    expect(lib.toolSendFiles('SendUserFile', { files: [] }, '/cwd')).toBeNull();
  });
  it('classe les images vs les autres fichiers', () => {
    const r = lib.toolSendFiles('SendUserFile', { files: ['/x/a.PNG', '/x/b.md', '/x/c.pdf'], caption: 'hi' }, '/cwd');
    expect(r.caption).toBe('hi');
    expect(r.files.map((f) => f.kind)).toEqual(['image', 'file', 'file']);
    expect(r.files[0].name).toBe('a.PNG');
  });
  it('display:attach force le mode fichier même pour une image', () => {
    const r = lib.toolSendFiles('SendUserFile', { files: ['/x/a.png'], display: 'attach' }, '/cwd');
    expect(r.files[0].kind).toBe('file');
  });
  it('résout les chemins relatifs contre le cwd', () => {
    const r = lib.toolSendFiles('SendUserFile', { files: ['sub/a.png', '/abs/b.png'] }, '/work');
    expect(r.files[0].path).toBe('/work/sub/a.png');
    expect(r.files[1].path).toBe('/abs/b.png');
  });
});

describe('buildConversation — SendUserFile part', () => {
  let dir, fp;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huf-conv-'));
    fp = path.join(dir, 't.jsonl');
    const line = {
      type: 'assistant', timestamp: '2026-08-05T10:00:00Z', uuid: 'u1', cwd: '/work',
      message: { content: [
        { type: 'text', text: 'here you go' },
        { type: 'tool_use', id: 'tu1', name: 'SendUserFile', input: { files: ['out.png', '/abs/report.md'], caption: 'the chart' } },
      ] },
    };
    fs.writeFileSync(fp, JSON.stringify(line) + '\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('attache `send` sur la part de l\'outil (chemins résolus)', () => {
    const msgs = lib.buildConversation(fp);
    const part = msgs[0].parts.find((p) => p.type === 'tool' && p.tool.name === 'SendUserFile');
    expect(part.send.caption).toBe('the chart');
    expect(part.send.files[0]).toMatchObject({ path: '/work/out.png', name: 'out.png', kind: 'image' });
    expect(part.send.files[1]).toMatchObject({ path: '/abs/report.md', kind: 'file' });
  });
});

describe('readUserFile — allowlist', () => {
  let root, projDir, sent, notSent;
  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'huf-serve-'));
    // fichier réellement envoyé + un fichier voisin jamais envoyé
    sent = path.join(root, 'sent.png');
    notSent = path.join(root, 'secret.png');
    fs.writeFileSync(sent, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(notSent, Buffer.from([0x00]));
    // projets/<projectDir>/<sessionId>.jsonl
    projDir = path.join(root, 'projects', '-proj');
    fs.mkdirSync(projDir, { recursive: true });
    const line = {
      type: 'assistant', cwd: root,
      message: { content: [
        { type: 'tool_use', id: 'tu1', name: 'SendUserFile', input: { files: ['sent.png'] } },
      ] },
    };
    fs.writeFileSync(path.join(projDir, 'sess-1.jsonl'), JSON.stringify(line) + '\n');
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const pdir = () => path.join(root, 'projects');

  it('sert un fichier présent dans la liste blanche du transcript', () => {
    const r = lib.readUserFile('sess-1', '', sent, pdir());
    expect(r).not.toBeNull();
    expect(r.contentType).toBe('image/png');
    expect(r.attachment).toBe(false);
    expect(r.name).toBe('sent.png');
  });
  it('refuse un fichier hors liste blanche (jamais envoyé)', () => {
    expect(lib.readUserFile('sess-1', '', notSent, pdir())).toBeNull();
  });
  it('refuse une session inconnue', () => {
    expect(lib.readUserFile('nope', '', sent, pdir())).toBeNull();
  });
});
