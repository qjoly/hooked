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
