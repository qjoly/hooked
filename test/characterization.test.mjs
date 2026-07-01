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
import * as lib from '../server/index.js'; // agrégateur des nouveaux modules (ESM)

const require = createRequire(import.meta.url);
const DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJ = path.join(DIR, 'fixtures', 'projects');
const CODE = path.join(DIR, 'fixtures', 'code');

const legacy = require('./reference/legacy-server.cjs'); // copie figée CommonJS — inchangée

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
  // `parts` (rendu inline style claude-cli) et `forkUuid` (point de coupe pour le fork) sont
  // des ajouts récents absents de la baseline figée → on les retire avant comparaison.
  const stripParts = (msgs) => msgs.map(({ parts, forkUuid, ...rest }) => rest);
  it('identique (alpha, non-sidechain)', () => {
    expect(stripParts(lib.buildConversation(FILES.alpha))).toEqual(legacy.buildConversation(FILES.alpha));
  });
  it('identique (agent, sidechain inclus)', () => {
    expect(stripParts(lib.buildConversation(FILES.agent, true))).toEqual(legacy.buildConversation(FILES.agent, true));
  });
  it('le sidechain est exclu par défaut', () => {
    const msgs = lib.buildConversation(FILES.alpha);
    expect(msgs.some((m) => m.text && m.text.includes('sidechain'))).toBe(false);
  });
  it('expose parts dans l\'ordre (texte + tool inline, sans doublon)', () => {
    const msgs = lib.buildConversation(FILES.alpha);
    const a1 = msgs.find((m) => m.role === 'assistant' && m.text && m.text.startsWith('Je lance les tests'));
    expect(a1.parts[0]).toEqual({ type: 'text', text: 'Je lance les tests.' });
    expect(a1.parts[1].type).toBe('tool');
    expect(a1.parts[1].tool.name).toBe('Bash');
    // doublon de texte de la ligne 5 du fixture : présent une seule fois
    const dups = a1.parts.filter((p) => p.type === 'text' && p.text === 'Je lance les tests.');
    expect(dups.length).toBe(1);
    // tool noms attendus, dans l'ordre du transcript (cohérent avec la dedup name+detail
    // déjà appliquée à m.tools : les deux AskUserQuestion sans détail sont collapsées)
    const toolNames = a1.parts.filter((p) => p.type === 'tool').map((p) => p.tool.name);
    expect(toolNames).toEqual(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'AskUserQuestion', 'Agent']);
    // dernier bloc texte = réponse finale (style claude-cli)
    const lastText = [...a1.parts].reverse().find((p) => p.type === 'text');
    expect(lastText.text).toContain('PR ouverte');
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

describe('eventSessionMeta — sessions vues dans les hooks', () => {
  it('agrège cwd / transcript / timestamps / ended par session', () => {
    const m = lib.eventSessionMeta();
    expect(m.get('sess-alpha')).toEqual({
      cwd: '/Users/test/proj-alpha', transcript: null,
      firstTs: '2026-06-11T09:00:00.000Z', lastTs: '2026-06-11T09:01:00.000Z', ended: false,
      firstPrompt: null,
    });
    // sess-beta : seul évènement Stop → non terminé (SessionEnd absent)
    expect(m.get('sess-beta')).toEqual({
      cwd: null, transcript: null,
      firstTs: '2026-06-09T14:00:00.000Z', lastTs: '2026-06-09T14:00:00.000Z', ended: false,
      firstPrompt: null,
    });
  });
});

describe('buildSessions — sessions live-only (avant transcript)', () => {
  it('ne ressuscite pas les sessions anciennes/avec transcript déjà scanné', () => {
    // fixtures : sess-alpha/beta ont un transcript ET des évènements vieux de plusieurs jours
    // → aucune session synthétique ne doit être ajoutée (dédup + garde-fou de récence).
    const ids = lib.buildSessions().map((s) => s.id).sort();
    expect(ids).toEqual(['sess-alpha', 'sess-beta']);
    expect(lib.buildSessions().some((s) => s.title === '(nouvelle session)')).toBe(false);
  });
  it('synthétise une session récente sans transcript, titrée par le prompt (50 car.)', () => {
    // sess-fresh : SessionStart + UserPromptSubmit, sans transcript → session live-only.
    const PROMPT = "Corrige le bug d'affichage de la sidebar quand on lance une nouvelle session please";
    const now = Date.parse('2026-06-11T10:05:00.000Z'); // < 30 min après le dernier évènement
    const fresh = lib.eventOnlySessions(new Set(['sess-alpha', 'sess-beta']), now)
      .find((s) => s.id === 'sess-fresh');
    expect(fresh).toBeTruthy();
    expect(fresh.title).toBe(PROMPT.slice(0, 50));
    expect(fresh.firstPrompt).toBe(PROMPT);
    expect(fresh.projectName).toBe('proj-fresh');
  });
  it('exclut une session sans transcript trop ancienne (> 30 min)', () => {
    const now = Date.parse('2026-06-11T12:00:00.000Z'); // ~2 h après → hors fenêtre
    const ids = lib.eventOnlySessions(new Set(), now).map((s) => s.id);
    expect(ids).not.toContain('sess-fresh');
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

// N.B. sémantique volontairement DIVERGENTE du legacy (fix « attente vs working ») → on pin
// explicitement le comportement attendu au lieu de comparer à la copie figée.
describe('liveStateFor — attente vs working', () => {
  const OLD = '2020-01-01T00:00:00Z';           // > 5 min (et > 30 min) → bascule 'idle'
  const NOW = new Date().toISOString();
  const cases = [
    [{ event: 'SessionEnd', ts: OLD }, { state: 'ended', tool: null }],
    [{ event: 'Stop', ts: OLD }, { state: 'waiting', tool: null }],
    // un sous-agent qui s'arrête ≠ l'agent principal a fini → surtout pas 'waiting'
    [{ event: 'SubagentStop', ts: OLD }, { state: 'idle', tool: null }],
    [{ event: 'SubagentStop', ts: NOW }, { state: 'working', tool: null }],
    [{ event: 'Notification', ts: OLD, message: 'needs your permission' }, { state: 'attention', tool: null }],
    [{ event: 'Notification', ts: OLD, message: 'hello' }, { state: 'waiting', tool: null }],
    [{ event: 'PreToolUse', ts: OLD, tool: 'Bash' }, { state: 'idle', tool: 'Bash' }],
    [{ event: 'PreToolUse', ts: NOW, tool: 'Bash' }, { state: 'working', tool: 'Bash' }],
    // plan / question : Claude attend une action de l'utilisateur → attention, sans péremption d'âge
    [{ event: 'PreToolUse', ts: OLD, tool: 'ExitPlanMode' }, { state: 'attention', tool: 'ExitPlanMode' }],
    [{ event: 'PreToolUse', ts: OLD, tool: 'AskUserQuestion' }, { state: 'attention', tool: 'AskUserQuestion' }],
    [{ event: 'UserPromptSubmit', ts: OLD }, { state: 'idle', tool: null }],
    [{ event: 'Weird', ts: OLD, tool: 'X' }, { state: 'idle', tool: 'X' }],
    [null, null],
  ];
  for (const [i, [ev, want]] of cases.entries()) {
    it(`cas#${i} ${ev ? ev.event + (ev.tool ? '/' + ev.tool : '') : 'null'}`, () => {
      expect(lib.liveStateFor(ev)).toEqual(want);
    });
  }
});

describe('livePlanForSession — plan ExitPlanMode en attente', () => {
  const fs = require('node:fs'), os = require('node:os');
  const mk = (name, evs) => {
    const fp = path.join(os.tmpdir(), `hooked-plan-${name}.jsonl`);
    fs.writeFileSync(fp, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
    return fp;
  };
  it('remonte le plan tant qu\'il est en attente', () => {
    const fp = mk('pending', [{ session_id: 's1', event: 'PreToolUse', tool: 'ExitPlanMode', ts: '2020-01-01T00:00:00Z', plan: '# Plan\n- étape' }]);
    expect(lib.livePlanForSession('s1', fp)?.plan).toBe('# Plan\n- étape');
  });
  it('disparaît une fois le plan résolu (PostToolUse ExitPlanMode)', () => {
    const fp = mk('resolved', [
      { session_id: 's1', event: 'PreToolUse', tool: 'ExitPlanMode', ts: '2020-01-01T00:00:00Z', plan: '# Plan' },
      { session_id: 's1', event: 'PostToolUse', tool: 'ExitPlanMode', ts: '2020-01-01T00:01:00Z' },
    ]);
    expect(lib.livePlanForSession('s1', fp)).toBe(null);
  });
  it('ignore un ExitPlanMode sans champ plan (event antérieur au hook)', () => {
    const fp = mk('noplan', [{ session_id: 's1', event: 'PreToolUse', tool: 'ExitPlanMode', ts: '2020-01-01T00:00:00Z' }]);
    expect(lib.livePlanForSession('s1', fp)).toBe(null);
  });
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

  // Nouveau système Claude Code ≥ 2.1.x : TaskCreate / TaskUpdate (remplace TodoWrite).
  const TASK_FP = path.join(DIR, 'fixtures', 'tasks.jsonl');
  it('reconstruit la liste depuis TaskCreate (id séquentiel) + TaskUpdate', () => {
    const t = lib.latestTodos(TASK_FP);
    expect(t).not.toBeNull();
    expect(t.ts).toBe('2026-06-17T09:04:00Z'); // dernier évènement Task*
    // c4 (id 4) a été supprimé via status:"deleted" ; u4 cible un id inconnu → ignoré.
    expect(t.todos.map((x) => x.content)).toEqual(['Lire le code', 'Écrire le module', 'Ajouter les tests']);
    expect(t.todos.map((x) => x.status)).toEqual(['completed', 'in_progress', 'pending']);
    expect(t.todos[1].activeForm).toBe('Écriture du module');
    expect(t.todos[0].description).toBe('Parcourir les modules'); // description capturée pour l'affichage
  });
  it('todoSummary fonctionne aussi sur les tâches reconstruites', () => {
    const sum = lib.todoSummary(lib.latestTodos(TASK_FP));
    expect(sum).toEqual({ total: 3, done: 1, current: 'Écriture du module' });
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
  it('reconnaît le mode même quand des sous-agents ajoutent des lignes en dessous', () => {
    const screen = footer('  ⏸ plan mode on (shift+tab to cycle)') + [
      '',
      '● main',
      '○ Explore  Verify latest prod version maintenance',
      '[hooked Re…] Ajouter feature de détection de méthode de versions',
    ].join('\n');
    expect(lib.parsePaneMode(screen)).toBe('plan');
  });
});

describe('parsePlanPrompt — menu d\'approbation ExitPlanMode', () => {
  const MENU = [
    '   Claude has written up a plan and is ready to execute. Would you like to proceed?',
    '',
    '   ❯ 1. Yes, and use auto mode',
    '     2. Yes, manually approve edits',
    '     3. No, refine with Ultraplan on Claude Code on the web',
    '     4. Tell Claude what to change',
    '        shift+tab to approve with this feedback',
  ].join('\n');
  it('parse les options numérotées et repère le curseur', () => {
    const opts = lib.parsePlanPrompt(MENU);
    expect(opts.map((o) => o.num)).toEqual([1, 2, 3, 4]);
    expect(opts.find((o) => o.cursor).num).toBe(1);
    expect(opts[3].label).toBe('Tell Claude what to change');
  });
  it('renvoie null hors du menu d\'approbation (pas de header « proceed »)', () => {
    expect(lib.parsePlanPrompt('some text\n1. foo\n2. bar')).toBe(null);
  });
});

describe('parseSpinner — verbe d\'activité (« thinking ») du footer TUI', () => {
  it('extrait le gérondif d\'une vraie ligne spinner (capturée en live)', () => {
    expect(lib.parseSpinner('✶ Accomplishing… (3m 25s · ↓ 11.3k tokens)')).toBe('Accomplishing');
  });
  it('marche pour tous les glyphes animés observés', () => {
    for (const g of ['✻', '✽', '✶', '✢', '✳', '·']) {
      expect(lib.parseSpinner(`${g} Clauding… (2s · ↓ 40 tokens)`)).toBe('Clauding');
    }
  });
  it('gère l\'ellipsis en trois points « ... » et un gérondif multi-mots', () => {
    expect(lib.parseSpinner('✻ Herding cats... (12s)')).toBe('Herding cats');
  });
  it('trouve la ligne spinner au milieu d\'un écran complet', () => {
    const screen = ['some transcript text', '', '✽ Gibberishing… (8s · ↓ 1.2k tokens)', '', '❯ '].join('\n');
    expect(lib.parseSpinner(screen)).toBe('Gibberishing');
  });
  it('null sur de la prose qui cite « …/Cogitating…/… » (pas la forme « mot… ( »)', () => {
    const prose = '  ▎ Le TUI affiche « esc to interrupt » dès qu\'il traite, indépendamment du verbe animé (Testing…/Cogitating…/…)';
    expect(lib.parseSpinner(prose)).toBe(null);
  });
  it('null sur la boîte de saisie seule — session en attente (le « ❯ » n\'est pas un glyphe spinner)', () => {
    const idle = '❯ Rédige un… test (foo)\n────\n  ⏵⏵ auto mode on (shift+tab to cycle)';
    expect(lib.parseSpinner(idle)).toBe(null);
  });
  it('ignore une sortie d\'outil « ⎿ Running tests… (12s) » (préfixe non-spinner)', () => {
    expect(lib.parseSpinner('  ⎿  Running tests… (12s)')).toBe(null);
  });
  it('prend le spinner du footer (dernier match), pas une ligne plus haut', () => {
    const screen = [
      '· Something in transcript… (aside)',   // ligne haute qui ressemble au motif
      '  ⎿ tool output',
      '✻ Percolating… (5s · ↓ 300 tokens)',   // vrai spinner, en bas
      '❯ ',
    ].join('\n');
    expect(lib.parseSpinner(screen)).toBe('Percolating');
  });
});
