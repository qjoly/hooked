/*
 * Tests de caractérisation — filet anti-régression de la réécriture.
 *
 * Stratégie : test DIFFÉRENTIEL. On compare, sur les mêmes fixtures, la sortie de
 * la copie figée de l'ancien server.js (test/reference/legacy-server.cjs) à celle
 * des nouveaux modules (server/*). Toute divergence = régression.
 *
 * + quelques assertions CONCRÈTES (valeurs attendues) pour documenter le comportement
 *   voulu et détecter un éventuel bug partagé par les deux implémentations.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(DIR, 'fixtures', 'projects');
const CODE = path.join(DIR, 'fixtures', 'code');

const legacy = require('./reference/legacy-server.cjs');
const lib = require('../server/index.js'); // agrégateur des nouveaux modules

const FILES = {
  alpha: path.join(PROJ, '-Users-test-proj-alpha', 'sess-alpha.jsonl'),
  beta: path.join(PROJ, '-Users-test-proj-beta', 'sess-beta.jsonl'),
  agent: path.join(PROJ, '-Users-test-proj-alpha', 'sess-alpha', 'subagents', 'agent-aaa.jsonl'),
};

const mapToEntries = (m) => [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));

describe('pricing — priceFor', () => {
  const models = [
    'claude-opus-4-8', 'claude-opus-4-1', 'claude-opus-4-20250514', 'claude-opus-4-5',
    'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-3-5-haiku', 'claude-fable-5',
    'mythos-5', 'unknown-model', '', null, undefined,
  ];
  for (const m of models) {
    it(`identique pour "${m}"`, () => {
      expect(lib.priceFor(m)).toEqual(legacy.priceFor(m));
    });
  }
  it('tiers concrets attendus', () => {
    expect(lib.priceFor('claude-opus-4-8')).toEqual({ in: 5, out: 25 });
    expect(lib.priceFor('claude-opus-4-1')).toEqual({ in: 15, out: 75 });
    expect(lib.priceFor('claude-sonnet-4-6')).toEqual({ in: 3, out: 15 });
    expect(lib.priceFor('claude-fable-5')).toEqual({ in: 10, out: 50 });
  });
});

describe('pricing — costForUsage', () => {
  const usages = [
    { input_tokens: 100, output_tokens: 50 },
    { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 200, cache_read_input_tokens: 1000 },
    { input_tokens: 100, output_tokens: 50, cache_creation: { ephemeral_1h_input_tokens: 50, ephemeral_5m_input_tokens: 150 } },
    {},
  ];
  for (const [i, u] of usages.entries()) {
    for (const model of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5']) {
      it(`identique usage#${i} / ${model}`, () => {
        expect(lib.costForUsage(u, model)).toEqual(legacy.costForUsage(u, model));
      });
    }
  }
});

describe('parseTranscript', () => {
  for (const [name, fp] of Object.entries(FILES)) {
    it(`identique pour ${name}`, () => {
      expect(lib.parseTranscript(fp, name)).toEqual(legacy.parseTranscript(fp, name));
    });
  }
  it('valeurs concrètes attendues (sess-alpha)', () => {
    const s = lib.parseTranscript(FILES.alpha, 'sess-alpha');
    expect(s.title).toBe('Refactor alpha');
    expect(s.projectName).toBe('proj-alpha');
    expect(s.gitBranch).toBe('main');
    expect(s.userPrompts).toBe(2);          // prompt simple + /deploy (caveat & tool_result ignorés)
    expect(s.assistantTurns).toBe(7);        // dédup du message dupliqué (msg-1 compté une fois)
    expect(s.model).toBe('claude-opus-4-8');
    expect(s.subagents).toBe(1);
    expect(s.tools).toEqual({ Bash: 1, Write: 1, Edit: 1, MultiEdit: 1, NotebookEdit: 1, AskUserQuestion: 2, Agent: 1 });
    expect(s.prLinks).toEqual(['https://github.com/acme/repo/pull/7', 'https://github.com/acme/repo/pull/42']);
    expect(s.pendingQuestion).not.toBeNull();
    expect(s.pendingQuestion.questions[0].header).toBe('Deploy');
    expect(Object.keys(s.byDay).sort()).toEqual(['2026-06-10', '2026-06-11']);
    expect(s.subagentCost).toBeGreaterThan(0);
  });
});

describe('buildConversation', () => {
  it('identique (alpha, non-sidechain)', () => {
    expect(lib.buildConversation(FILES.alpha)).toEqual(legacy.buildConversation(FILES.alpha));
  });
  it('identique (agent, sidechain inclus)', () => {
    expect(lib.buildConversation(FILES.agent, true)).toEqual(legacy.buildConversation(FILES.agent, true));
  });
  it('le sidechain est exclu par défaut', () => {
    const msgs = lib.buildConversation(FILES.alpha);
    expect(msgs.some((m) => m.text && m.text.includes('sidechain'))).toBe(false);
  });
});

describe('buildFileChanges', () => {
  it('identique (alpha)', () => {
    expect(lib.buildFileChanges(FILES.alpha)).toEqual(legacy.buildFileChanges(FILES.alpha));
  });
  it('détecte Write/Edit/MultiEdit/NotebookEdit', () => {
    const ch = lib.buildFileChanges(FILES.alpha);
    const byName = Object.fromEntries(ch.map((c) => [c.name, c]));
    expect(byName['app.js'].ops.some((o) => o.kind === 'write')).toBe(true);
    expect(byName['app.js'].ops.some((o) => o.kind === 'edit')).toBe(true);
    expect(byName['util.js'].ops.filter((o) => o.kind === 'edit').length).toBe(2); // MultiEdit
    expect(byName['nb.ipynb'].ops[0].kind).toBe('notebook');
  });
});

describe('buildSubagents', () => {
  it('identique (alpha)', () => {
    expect(lib.buildSubagents(FILES.alpha)).toEqual(legacy.buildSubagents(FILES.alpha));
  });
  it('apparie consigne + résultat + métadonnées', () => {
    const sa = lib.buildSubagents(FILES.alpha);
    expect(sa.length).toBe(1);
    expect(sa[0].type).toBe('Explore');
    expect(sa[0].agentId).toBe('aaa');
    expect(sa[0].result).toContain('Trouvé 3 usages');
    expect(sa[0].cost).toBeGreaterThan(0);
  });
});

describe('files — fuzzyScore / matchFiles', () => {
  const list = lib.listFilesUnder(CODE);
  it('listFilesUnder identique + ignore node_modules/.git', () => {
    expect(new Set(lib.listFilesUnder(CODE))).toEqual(new Set(legacy.listFilesUnder(CODE)));
    expect(list.some((f) => f.includes('node_modules'))).toBe(false);
    expect(list.some((f) => f.includes('.git'))).toBe(false);
  });
  for (const q of ['srvjs', 'util', 'app', 'readme', '', 'zzz']) {
    it(`matchFiles identique pour "${q}"`, () => {
      expect(lib.matchFiles(list, q)).toEqual(legacy.matchFiles(list, q));
    });
  }
  it('fuzzy: "srvjs" trouve src/server.js en tête', () => {
    expect(lib.matchFiles(list, 'srvjs')[0]).toBe('src/server.js');
  });
});

describe('scanSessions', () => {
  it('identique', () => {
    expect(lib.scanSessions()).toEqual(legacy.scanSessions());
  });
  it('exclut les sous-agents (agent-*.jsonl) et les non-.jsonl', () => {
    const ids = lib.scanSessions().map((s) => s.id).sort();
    expect(ids).toEqual(['sess-alpha', 'sess-beta']);
  });
});

describe('buildStats', () => {
  for (const range of [0, 7, 30]) {
    it(`identique pour range=${range}`, () => {
      expect(lib.buildStats(range)).toEqual(legacy.buildStats(range));
    });
  }
  it('totaux concrets (range=all)', () => {
    const st = lib.buildStats(0);
    expect(st.totals.sessions).toBe(2);
    expect(st.totals.prompts).toBe(3); // 2 (alpha) + 1 (beta)
    expect(st.byTool.Bash).toBe(1);
    expect(Object.keys(st.byProject).sort()).toEqual(['proj-alpha', 'proj-beta']);
  });
});

describe('events live', () => {
  it('readEvents identique', () => {
    expect(lib.readEvents()).toEqual(legacy.readEvents());
  });
  it('lastEventBySession identique', () => {
    expect(mapToEntries(lib.lastEventBySession())).toEqual(mapToEntries(legacy.lastEventBySession()));
  });
  it('paneForSession identique', () => {
    expect(lib.paneForSession('sess-alpha')).toEqual(legacy.paneForSession('sess-alpha'));
    expect(lib.paneForSession('sess-alpha')).toBe('%1');
  });
  it('liveQuestionForSession identique + détecte la question live', () => {
    expect(lib.liveQuestionForSession('sess-alpha')).toEqual(legacy.liveQuestionForSession('sess-alpha'));
    expect(lib.liveQuestionForSession('sess-alpha').questions[0].header).toBe('L');
  });
  it('launchConfigByTmux identique (dernier write gagne)', () => {
    expect(mapToEntries(lib.launchConfigByTmux())).toEqual(mapToEntries(legacy.launchConfigByTmux()));
    expect(lib.launchConfigByTmux().get('hooked-proj-alpha-abc12')).toEqual({ model: 'opus', effort: 'max' });
  });
});

describe('liveStateFor', () => {
  const cases = [
    { event: 'SessionEnd', ts: '2020-01-01T00:00:00Z' },
    { event: 'Stop', ts: '2020-01-01T00:00:00Z' },
    { event: 'SubagentStop', ts: '2020-01-01T00:00:00Z' },
    { event: 'Notification', ts: '2020-01-01T00:00:00Z', message: 'needs your permission' },
    { event: 'Notification', ts: '2020-01-01T00:00:00Z', message: 'hello' },
    { event: 'PreToolUse', ts: '2020-01-01T00:00:00Z', tool: 'Bash' },   // vieux → idle
    { event: 'PreToolUse', ts: new Date().toISOString(), tool: 'Bash' }, // récent → working
    { event: 'UserPromptSubmit', ts: '2020-01-01T00:00:00Z' },
    { event: 'Weird', ts: '2020-01-01T00:00:00Z', tool: 'X' },
    null,
  ];
  for (const [i, ev] of cases.entries()) {
    it(`identique cas#${i}`, () => {
      expect(lib.liveStateFor(ev)).toEqual(legacy.liveStateFor(ev));
    });
  }
});

describe('todos — latestTodos / todoSummary', () => {
  const TODO_FP = path.join(DIR, 'fixtures', 'todos.jsonl');
  it('retient le DERNIER appel TodoWrite (la liste réécrite fait foi)', () => {
    const t = lib.latestTodos(TODO_FP);
    expect(t).not.toBeNull();
    expect(t.ts).toBe('2026-06-12T10:05:00Z');
    expect(t.todos.map((x) => x.status)).toEqual(['completed', 'completed', 'in_progress']);
    expect(t.todos[2].content).toBe('Ajouter les tests');
    expect(t.todos[2].activeForm).toBe('Ajout des tests');
  });
  it('todoSummary : compteurs + libellé (activeForm) de la tâche en cours', () => {
    const sum = lib.todoSummary(lib.latestTodos(TODO_FP));
    expect(sum).toEqual({ total: 3, done: 2, current: 'Ajout des tests' });
  });
  it('null quand TodoWrite n\'a jamais servi', () => {
    expect(lib.latestTodos(FILES.alpha)).toBeNull();
    expect(lib.todoSummary(null)).toBeNull();
  });
  it('current vaut null quand aucune tâche en cours', () => {
    const sum = lib.todoSummary({ todos: [{ content: 'x', status: 'completed', activeForm: 'X' }] });
    expect(sum).toEqual({ total: 1, done: 1, current: null });
  });
});

describe('agentTranscriptPath', () => {
  it('identique + localise le sous-agent rattaché', () => {
    expect(lib.agentTranscriptPath('sess-alpha', 'aaa')).toEqual(legacy.agentTranscriptPath('sess-alpha', 'aaa'));
    expect(lib.agentTranscriptPath('sess-alpha', 'aaa')).toBe(FILES.agent);
  });
  it('rejette les ids invalides', () => {
    expect(lib.agentTranscriptPath('sess-alpha', '../etc')).toBeNull();
    expect(lib.agentTranscriptPath('sess-alpha', 'inconnu')).toBeNull();
  });
});

describe('images — saveImage', () => {
  // 1×1 PNG transparent
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  it('écrit le fichier décodé et renvoie son chemin', () => new Promise((done) => {
    lib.saveImage(PNG, (err, info) => {
      expect(err).toBeNull();
      expect(info.path.startsWith(lib.IMAGES_DIR)).toBe(true);
      expect(info.name.endsWith('.png')).toBe(true);
      const fs = require('fs');
      expect(fs.existsSync(info.path)).toBe(true);
      fs.unlinkSync(info.path); // nettoyage
      done();
    });
  }));
  it('rejette un data-URL non-image / type non supporté', () => new Promise((done) => {
    lib.saveImage('data:text/plain;base64,aGVsbG8=', (err, info) => {
      expect(err).toBeTruthy();
      expect(err.code).toBe(400);
      expect(info).toBeUndefined();
      done();
    });
  }));
});

describe('mode de permission — parsePaneMode (footer TUI réel)', () => {
  // footers capturés sur un vrai TUI Claude Code (dernière ligne non vide de l'écran).
  const footer = (modeLine) => [
    'précédente réponse de Claude…',
    '──── branche ──',
    '❯ ',
    '────',
    '  🤖 Opus 4.8 (1M context) 🔥 high | 🧠 ↓158k | 📊 16%',
    '  📁 hooked | 🌳 no worktree | 🌿 HEAD ~14',
    ...(modeLine ? [modeLine] : []),
  ].join('\n');

  it('reconnaît chaque mode depuis sa ligne de footer', () => {
    expect(lib.parsePaneMode(footer('  ⏵⏵ auto mode on (shift+tab to cycle)'))).toBe('auto');
    expect(lib.parsePaneMode(footer('  ⏵⏵ accept edits on (shift+tab to cycle)'))).toBe('acceptEdits');
    expect(lib.parsePaneMode(footer('  ⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(lib.parsePaneMode(footer('  ⏵⏵ bypass permissions on (shift+tab to cycle)'))).toBe('bypassPermissions');
  });
  it('renvoie default en mode normal (pas de ligne d\'indicateur)', () => {
    expect(lib.parsePaneMode(footer(null))).toBe('default');
  });
  it('ignore le texte de la conversation qui cite les libellés (seule la dernière ligne compte)', () => {
    const screen = 'je te disais ⏸ plan mode on (shift+tab to cycle) dans mon message\n' + footer('  ⏵⏵ auto mode on (shift+tab to cycle)');
    expect(lib.parsePaneMode(screen)).toBe('auto');
  });
});
