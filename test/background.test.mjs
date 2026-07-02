/*
 * Tests du détecteur de jobs de fond (server/background.js) + du relabel d'état
 * `waiting → background` (withBackgroundState, server/stats.js).
 *
 * Module NEUF, hors comparaison différentielle figée (legacy-server.cjs) → aucune baseline
 * à toucher. Fixture dédiée hors fixtures/projects/ (sinon scanSessions changerait).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBackgroundJobs, activeBackgroundJobs, withBackgroundState } from '../server/index.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FP = path.join(DIR, 'fixtures', 'background.jsonl');

// écrit un transcript jsonl jetable (pour les cas positionnels du wakeup).
const mkTranscript = (name, lines) => {
  const fp = path.join(os.tmpdir(), `hooked-bg-${name}.jsonl`);
  fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return fp;
};
const wake = (prompt) => ({ type: 'assistant', timestamp: '2026-06-20T10:00:00Z', message: { content: [{ type: 'tool_use', id: 'w1', name: 'ScheduleWakeup', input: { prompt } }] } });
const userLine = (content) => ({ type: 'user', promptSource: 'system', isMeta: true, message: { role: 'user', content } });

describe('buildBackgroundJobs — cycle de vie des jobs de fond', () => {
  const { jobs, active } = buildBackgroundJobs(FP);
  const byId = Object.fromEntries(jobs.filter((j) => j.taskId).map((j) => [j.taskId, j]));

  it('distingue les jobs actifs des jobs terminés', () => {
    // actifs : bash bg_active_1 + monitor mon_active_1 + wakeup « Resume the deploy check »
    expect(active.length).toBe(3);
    const kinds = active.map((j) => j.kind).sort();
    expect(kinds).toEqual(['bash', 'monitor', 'wakeup']);
    expect(active.find((j) => j.kind === 'wakeup').prompt).toBe('Resume the deploy check');
  });

  it('Bash bg : « completed (exit code 0) » clôt le job avec son code de sortie', () => {
    expect(byId.bg_active_1.done).toBe(false);
    expect(byId.bg_done_1.done).toBe(true);
    expect(byId.bg_done_1.doneReason).toBe('completed');
    expect(byId.bg_done_1.exitCode).toBe(0);
  });

  it('Monitor : <status>completed</status> (+ EXIT rc=0) clôt le job ; un TaskStop clôt (stopped)', () => {
    expect(byId.mon_active_1.done).toBe(false);
    expect(byId.mon_done_1.done).toBe(true);
    expect(byId.mon_done_1.doneReason).toBe('completed'); // statut terminal prioritaire sur le repli EXIT rc
    expect(byId.mon_done_1.exitCode).toBe(0);             // code lu depuis « EXIT rc=0 »
    expect(byId.mon_stopped_1.doneReason).toBe('stopped');
  });

  it('ScheduleWakeup : seul le DERNIER est suivi ; en attente s\'il est en fin de transcript', () => {
    // « Continue the second task » a été remplacé par « Resume the deploy check » (dernier, rien après)
    const wk = jobs.filter((j) => j.kind === 'wakeup');
    expect(wk.length).toBe(1);
    expect(wk[0].prompt).toBe('Resume the deploy check');
    expect(wk[0].done).toBe(false);
  });

  it('activeBackgroundJobs = raccourci sur .active ; fichier absent → []', () => {
    expect(activeBackgroundJobs(FP).length).toBe(3);
    expect(activeBackgroundJobs(path.join(DIR, 'fixtures', 'nope.jsonl'))).toEqual([]);
    expect(activeBackgroundJobs(null)).toEqual([]);
  });
});

describe('ScheduleWakeup — modèle positionnel (rien après ⇒ en attente)', () => {
  it('en attente quand le wakeup est la dernière activité', () => {
    const fp = mkTranscript('wake-pending', [wake('Resume X')]);
    const { active } = buildBackgroundJobs(fp);
    expect(active.length).toBe(1);
    expect(active[0].kind).toBe('wakeup');
  });
  it('déclenché (done) dès qu\'une reprise suit le wakeup', () => {
    const fp = mkTranscript('wake-fired', [
      wake('Resume X'),
      userLine('Resume X'),                                   // le déclenchement ré-injecte un prompt
      { type: 'assistant', message: { content: [{ type: 'text', text: 'back to work' }] } },
    ]);
    const { jobs, active } = buildBackgroundJobs(fp);
    expect(active.filter((j) => j.kind === 'wakeup').length).toBe(0);
    expect(jobs.find((j) => j.kind === 'wakeup').doneReason).toBe('fired');
  });
  it('robuste au promptSource variable : un message humain après le wakeup le consomme aussi', () => {
    const fp = mkTranscript('wake-human', [wake('Resume X'), { type: 'user', message: { role: 'user', content: 'never mind, do this instead' } }]);
    expect(buildBackgroundJobs(fp).active.filter((j) => j.kind === 'wakeup').length).toBe(0);
  });
});

describe('withBackgroundState — relabel waiting → background', () => {
  it('ne relabel QUE waiting, pane vivant, avec ≥ 1 job actif', () => {
    expect(withBackgroundState('waiting', true, 1)).toBe('background');
    expect(withBackgroundState('waiting', true, 0)).toBe('waiting');   // pas de job actif
    expect(withBackgroundState('waiting', false, 2)).toBe('waiting');  // pane mort → job mort aussi
  });
  it('ne touche jamais working / attention / idle / ended', () => {
    for (const st of ['working', 'attention', 'idle', 'ended', 'past']) {
      expect(withBackgroundState(st, true, 3)).toBe(st);
    }
  });
  it("'working' prime sur 'background' : job de fond + pane génuinement actif → working", () => {
    // Cas du bug : Stop capté (→ waiting), puis un wakeup/veilleur ré-invoque la session qui se
    // remet à mouliner (vrai spinner footer, busy===true) avant tout nouveau hook → travaille.
    expect(withBackgroundState('waiting', true, 1, true)).toBe('working');
    // pane inactif (boîte de saisie seule, busy===false) → tourne bien juste en fond.
    expect(withBackgroundState('waiting', true, 1, false)).toBe('background');
    // pane injoignable (busy===null) → on ne promeut pas ; comportement historique = background.
    expect(withBackgroundState('waiting', true, 1, null)).toBe('background');
    // signal busy absent (appel legacy sans 4e arg) → background, rétro-compatible.
    expect(withBackgroundState('waiting', true, 1)).toBe('background');
  });
  it("pane mort ne devient jamais working, même avec busy truthy résiduel", () => {
    // alive faux ⇒ on n'entre pas dans la branche : reste waiting (cf. fix dead-pane 1f98901).
    expect(withBackgroundState('waiting', false, 2, true)).toBe('waiting');
  });
});
