/*
 * Threads de revue (server/reviewThreads.js) — le store serveur de la conversation GitHub-style
 * ancrée dans la diff. Cycle complet : commentaire pending → envoi du lot → réponse de Claude →
 * archivage → restauration. Plus les gardes : auteurs bornés, id de session sans traversal.
 *
 * Le point de contrat qui compte ici : ARCHIVER EST LA DÉCISION DU RELECTEUR. Une réponse de
 * Claude ne sort JAMAIS un thread des archives (avant ce changement, Claude était même invité à
 * clore lui-même chaque thread traité) ; une réponse de l'utilisateur, elle, le désarchive.
 * Et 'resolved', l'ancien nom de l'état, doit être relu comme 'archived' — sinon une revue déjà
 * traitée reviendrait tout entière dans la diff.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TMP = path.join(os.tmpdir(), 'hooked-reviewthreads-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let store;
const SID = 'session-abc';
const anchor = { file: '/repo/a.js', opIndex: 'full:0', name: 'a.js', side: 'new', start: 3, end: 5, snippet: 'const x = 1;', text: 'why not const?' };

beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  store = await import('../server/reviewThreads.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('reviewThreads — cycle de vie', () => {
  let tid;
  it('crée un thread pending depuis un commentaire', () => {
    const t = store.addThread(SID, anchor);
    tid = t.id;
    expect(t).toMatchObject({ file: anchor.file, side: 'new', start: 3, end: 5, status: 'open', sent: false });
    expect(t.messages).toEqual([expect.objectContaining({ author: 'user', text: 'why not const?' })]);
    expect(store.listThreads(SID)).toHaveLength(1);
  });

  it('marque le lot envoyé', () => {
    expect(store.markThreadsSent(SID, [tid])).toBe(1);
    expect(store.listThreads(SID)[0].sent).toBe(true);
    expect(store.markThreadsSent(SID, [tid])).toBe(0); // déjà envoyé : idempotent
  });

  it('supprime aussi un thread déjà envoyé', () => {
    // La liste de commentaires du panneau Ship / Branch propose une corbeille sur TOUS les
    // threads : le store ne doit pas refuser les envoyés (l'UI confirme avant d'appeler).
    const gone = store.addThread(SID, { ...anchor, text: 'sent then deleted' });
    store.markThreadsSent(SID, [gone.id]);
    expect(store.deleteThread(SID, gone.id)).toBe(true);
    expect(store.listThreads(SID).some((x) => x.id === gone.id)).toBe(false);
    expect(store.listThreads(SID)).toHaveLength(1); // le thread du cas nominal est intact
  });

  it('Claude répond dans le thread', () => {
    const t = store.replyThread(SID, tid, 'claude', 'switched to const');
    expect(t.messages).toHaveLength(2);
    expect(t.messages[1]).toMatchObject({ author: 'claude', text: 'switched to const' });
  });

  it('archive, et une réponse user DÉSARCHIVE le thread', () => {
    expect(store.archiveThread(SID, tid).status).toBe('archived');
    const t = store.replyThread(SID, tid, 'user', 'actually, one more thing');
    expect(t.status).toBe('open');
  });

  it("une réponse de Claude ne désarchive PAS : ranger est la décision du relecteur", () => {
    expect(store.archiveThread(SID, tid).status).toBe('archived');
    expect(store.replyThread(SID, tid, 'claude', 'done').status).toBe('archived');
    expect(store.archiveThread(SID, tid, false).status).toBe('open'); // restauration explicite
  });

  it('supprime un thread encore pending', () => {
    const t2 = store.addThread(SID, { ...anchor, text: 'typo here' });
    expect(store.deleteThread(SID, t2.id)).toBe(true);
    expect(store.listThreads(SID).some((x) => x.id === t2.id)).toBe(false);
  });
});

describe('reviewThreads — editing a pending comment', () => {
  it('rewrites the opening message and keeps the anchor', () => {
    const t = store.addThread(SID, { ...anchor, text: 'first draft' });
    const e = store.editThread(SID, t.id, 'second draft');
    expect(e.messages).toEqual([expect.objectContaining({ author: 'user', text: 'second draft' })]);
    expect(e).toMatchObject({ side: 'new', start: 3, end: 5, snippet: anchor.snippet, sent: false });
    // persisted, not just returned
    expect(store.listThreads(SID).find((x) => x.id === t.id).messages[0].text).toBe('second draft');
  });

  it('refuses once the thread is sent — the text is already in Claude context', () => {
    const t = store.addThread(SID, { ...anchor, text: 'shipped' });
    store.markThreadsSent(SID, [t.id]);
    expect(store.editThread(SID, t.id, 'too late')).toBe(null);
    expect(store.listThreads(SID).find((x) => x.id === t.id).messages[0].text).toBe('shipped');
  });

  it('refuses empty text and unknown threads', () => {
    const t = store.addThread(SID, { ...anchor, text: 'keep me' });
    expect(store.editThread(SID, t.id, '   ')).toBe(null);
    expect(store.editThread(SID, 'nope', 'x')).toBe(null);
    expect(store.listThreads(SID).find((x) => x.id === t.id).messages[0].text).toBe('keep me');
  });
});

describe('reviewThreads — gardes', () => {
  it('borne les auteurs à user/claude et exige un texte', () => {
    const t = store.addThread(SID, { ...anchor, text: 'guard' });
    expect(store.replyThread(SID, t.id, 'attacker', 'x')).toBe(null);
    expect(store.replyThread(SID, t.id, 'user', '   ')).toBe(null);
  });

  it('refuse un commentaire invalide (texte vide, ligne absente)', () => {
    expect(store.addThread(SID, { ...anchor, text: '' })).toBe(null);
    expect(store.addThread(SID, { ...anchor, start: 0 })).toBe(null);
  });

  // A cut key never matches its section again (the front requires a `:<index>` or `:*` tail), so
  // the thread turned "unreachable". Real case: a worktree path + branch + commit range, 225 chars.
  const BRANCH_KEY = 'br:/Users/cchaslerie/Documents/Lucca/CC.Master/.claude/worktrees/precious-crunching-hearth:master:fix/environment-renaming-dns-verification:@15d92d88e555f04bc14b70366043b643ec6b5949..39414400614c34683df37d3e197bb40678ca6967:0';

  it('stores a branch section key longer than 200 chars intact', () => {
    expect(BRANCH_KEY.length).toBeGreaterThan(200);
    const t = store.addThread(SID, { ...anchor, opIndex: BRANCH_KEY, text: 'long key' });
    expect(t.opIndex).toBe(BRANCH_KEY);
    expect(store.listThreads(SID).find((x) => x.id === t.id).opIndex).toBe(BRANCH_KEY);
  });

  it('rejects a section key past the limit rather than cutting it', () => {
    const before = store.listThreads(SID).length;
    expect(store.addThread(SID, { ...anchor, opIndex: 'br:' + 'x'.repeat(1000) + ':0', text: 'too long' })).toBe(null);
    expect(store.listThreads(SID)).toHaveLength(before);
  });

  it('refuse un id de session menaçant (traversal) sans toucher au disque', () => {
    expect(store.addThread('../evil', anchor)).toBe(null);
    expect(store.listThreads('../evil')).toEqual([]);
  });

  it('un thread inconnu répond null/false partout', () => {
    expect(store.replyThread(SID, 'nope', 'user', 'x')).toBe(null);
    expect(store.archiveThread(SID, 'nope')).toBe(null);
    expect(store.deleteThread(SID, 'nope')).toBe(false);
  });

  it("relit l'ancien état 'resolved' comme 'archived'", () => {
    // Fichier écrit par la version d'avant : sans normalisation à la lecture, ces threads
    // reviendraient « open » dans la diff — une revue entière à re-ranger à la main.
    const legacy = 'session-legacy';
    fs.writeFileSync(
      path.join(TMP, 'reviews', legacy + '.json'),
      JSON.stringify({ threads: [{ id: 'old-1', file: '/repo/a.js', side: 'new', start: 1, end: 1, status: 'resolved', sent: true, messages: [{ author: 'user', text: 'x' }] }] }),
    );
    expect(store.listThreads(legacy)[0].status).toBe('archived');
  });
});

// "Review with Claude": Claude opens the threads itself. It only gives a path and line numbers;
// the store reads the snippet (reanchor() needs the exact lines, and a model cannot be trusted to
// copy them byte for byte) — through symbols.readSlice, so only files of the session's repositories
// are read, at the revision the diff shows — and files the thread under the scope the review was
// asked on.
describe('reviewThreads — threads opened by Claude', () => {
  const CSID = 'session-claude';
  const PROJECT = path.join(TMP, 'project');
  const FILE = path.join(PROJECT, 'src', 'b.js');
  const src = ['line 1', 'line 2', 'line 3', 'line 4', 'line 5'].join('\n');
  const GIT = ['-c', 'user.email=t@test', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];
  const git = (...args) => execFileSync('git', [...GIT, ...args], { cwd: PROJECT });

  beforeAll(() => {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, src);
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  it('files a thread under the default working-tree scope when no review was started', async () => {
    const { thread } = await store.addClaudeThread('session-no-review', { file: FILE, start: 2, text: 'x' }, PROJECT);
    expect(thread.opIndex).toBe('vcs:wt:*');
  });

  it('opens a sent thread, authored by Claude, anchored on the disk lines of the started scope', async () => {
    expect(store.startReview(CSID, 'vcs:wt:*')).toMatchObject({ scope: 'vcs:wt:*', rev: null });
    const { thread } = await store.addClaudeThread(CSID, { file: FILE, start: 2, end: 3, text: 'off by one' }, PROJECT);
    expect(thread).toMatchObject({
      file: FILE, name: 'b.js', opIndex: 'vcs:wt:*', side: 'new', start: 2, end: 3,
      snippet: 'line 2\nline 3', status: 'open', sent: true,
    });
    expect(thread.messages).toEqual([expect.objectContaining({ author: 'claude', text: 'off by one' })]);
    expect(store.listThreads(CSID).map((t) => t.id)).toContain(thread.id);
  });

  it('resolves a relative path against the session project', async () => {
    const { thread } = await store.addClaudeThread(CSID, { file: 'src/b.js', start: 5, text: 'last line' }, PROJECT);
    expect(thread).toMatchObject({ file: FILE, start: 5, end: 5, snippet: 'line 5' });
  });

  it('clamps an end past the end of the file', async () => {
    const { thread } = await store.addClaudeThread(CSID, { file: FILE, start: 4, end: 99, text: 'tail' }, PROJECT);
    expect(thread).toMatchObject({ start: 4, end: 5, snippet: 'line 4\nline 5' });
  });

  it('keeps the started scope when other threads are written', async () => {
    store.startReview(CSID, 'br:/repo:main:feat:*');
    store.addThread(CSID, { ...anchor, text: 'a user comment in between' });
    const { thread } = await store.addClaudeThread(CSID, { file: FILE, start: 1, text: 'still scoped' }, PROJECT);
    expect(thread.opIndex).toBe('br:/repo:main:feat:*');
  });

  it('reads the lines at the revision the diff shows, not on disk', async () => {
    // A branch review: the new side is `git show <tip>:<path>`, whatever the working tree holds.
    fs.writeFileSync(FILE, 'uncommitted 1\nuncommitted 2');
    try {
      store.startReview('session-rev', 'br:/repo:main:feat:*', 'HEAD');
      const { thread } = await store.addClaudeThread('session-rev', { file: FILE, start: 3, text: 'x' }, PROJECT);
      expect(thread).toMatchObject({ start: 3, end: 3, snippet: 'line 3' });
    } finally {
      fs.writeFileSync(FILE, src);
    }
  });

  it('falls back to the disk when the revision no longer resolves', async () => {
    store.startReview('session-gone', 'br:/repo:main:gone:*', 'gone-branch');
    const { thread } = await store.addClaudeThread('session-gone', { file: FILE, start: 2, text: 'x' }, PROJECT);
    expect(thread.snippet).toBe('line 2');
  });

  it('refuses a file outside the session repositories — nothing of it is stored', async () => {
    const outside = path.join(TMP, 'secret.txt');
    fs.writeFileSync(outside, 'token=abc');
    const { error } = await store.addClaudeThread(CSID, { file: outside, start: 1, text: 'x' }, PROJECT);
    expect(error).toMatch(/outside the session's repositories/);
    expect(JSON.stringify(store.listThreads(CSID))).not.toContain('token=abc');
  });

  it('keeps no snippet rather than a line cut short (it could never re-anchor)', async () => {
    const wide = path.join(PROJECT, 'wide.txt');
    fs.writeFileSync(wide, 'x'.repeat(5000) + '\nshort');
    const { thread } = await store.addClaudeThread(CSID, { file: wide, start: 1, text: 'minified' }, PROJECT);
    expect(thread).toMatchObject({ start: 1, end: 1, snippet: '' });
  });

  it('explains a refusal, so the model can fix its call', async () => {
    const err = async (sid, input, cwd = PROJECT) => (await store.addClaudeThread(sid, input, cwd)).error;
    expect(await err(CSID, { file: FILE, start: 9, text: 'x' })).toMatch(/past the end.*5 lines/);
    expect(await err(CSID, { file: 'nope.js', start: 1, text: 'x' })).toMatch(/cannot read/);
    expect(await err(CSID, { file: 'src/b.js', start: 1, text: 'x' }, null)).toMatch(/project/);
    expect(await err(CSID, { file: FILE, start: 1, text: '  ' })).toMatch(/text/);
    expect(await err(CSID, { file: FILE, start: 0, text: 'x' })).toMatch(/line/);
    expect(await err('../evil', { file: FILE, start: 1, text: 'x' })).toBeTruthy();
  });

  it('refuses to start a review without a scope', () => {
    expect(store.startReview(CSID, '')).toBe(null);
    expect(store.startReview('../evil', 'vcs:wt:*')).toBe(null);
  });

  it('keeps a long scope and revision intact, and rejects them past the limit', () => {
    const scope = 'br:/' + 'deep/'.repeat(80) + 'wt:master:feat:*';
    const rev = 'feature/' + 'n'.repeat(300);
    expect(store.startReview('session-long', scope, rev)).toMatchObject({ scope, rev });
    expect(store.startReview('session-long', 'br:' + 'x'.repeat(1000) + ':*')).toBe(null);
    expect(store.startReview('session-long', scope, 'x'.repeat(1001))).toBe(null);
  });
});
