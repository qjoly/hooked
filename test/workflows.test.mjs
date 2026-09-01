/*
 * buildWorkflows — runs de l'outil `Workflow` d'une session.
 *
 * Fixtures écrites dans un tmpdir reproduisant l'arborescence réelle de Claude Code :
 *   <proj>/<session>.jsonl                                   transcript principal
 *   <proj>/<session>/workflows/<runId>.json                  enregistrement final (fin de run)
 *   <proj>/<session>/workflows/scripts/<nom>-<runId>.js      script (meta.phases)
 *   <proj>/<session>/subagents/workflows/<runId>/            journal + transcripts d'agents (live)
 *
 * On couvre les deux régimes — reconstruction LIVE depuis le dossier d'exécution, et lecture de
 * l'ENREGISTREMENT FINAL qui fait autorité — plus la clôture par <task-notification>.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkflows, parseScriptPhases } from '../server/workflows.js';

const SESSION = '00000000-0000-4000-8000-000000000000';
const RUN = 'wf_deadbeef-001';

// Racine de fixture jetable ; renvoie { fp, dirs } où fp est le transcript principal.
let n = 0;
function scaffold(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hooked-wf-${name}-${n++}-`));
  const proj = path.join(root, 'projects', '-proj');
  const base = path.join(proj, SESSION);
  fs.mkdirSync(path.join(base, 'workflows', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(base, 'subagents', 'workflows', RUN), { recursive: true });
  return {
    fp: path.join(proj, `${SESSION}.jsonl`),
    record: path.join(base, 'workflows', `${RUN}.json`),
    scripts: path.join(base, 'workflows', 'scripts'),
    run: path.join(base, 'subagents', 'workflows', RUN),
  };
}

const write = (fp, lines) => fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

// tool_use Workflow + son tool_result apparié : l'ancre qui ouvre un run (status async_launched).
const launch = (scriptName = `demo-${RUN}.js`) => [
  { type: 'assistant', timestamp: '2026-09-01T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Workflow', input: { script: '…' } }] } },
  {
    type: 'user',
    timestamp: '2026-09-01T10:00:01.000Z',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'Workflow launched in background.' }] },
    toolUseResult: {
      status: 'async_launched', taskId: 'wtask01', taskType: 'local_workflow',
      workflowName: 'demo-flow', runId: RUN, summary: 'Une démo',
      transcriptDir: '/ignored/by/design', scriptPath: `/ignored/${scriptName}`,
    },
  },
];

// <task-notification> terminale (un des trois porteurs — ici queue-operation).
const notification = (status = 'completed') => ({
  type: 'queue-operation', operation: 'enqueue',
  content: `<task-notification>\n<task-id>wtask01</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>${status}</status>\n<summary>Dynamic workflow "Une démo" ${status}</summary>\n</task-notification>`,
});

// un tour d'agent : prompt + une réponse assistant portant usage et un tool_use.
const agentTranscript = (prompt, { ctx = 1000, out = 50, tool = 'Read', detail = '/x.ts' } = {}) => [
  { type: 'user', timestamp: '2026-09-01T10:00:02.000Z', isSidechain: true, message: { role: 'user', content: prompt } },
  {
    type: 'assistant', timestamp: '2026-09-01T10:01:02.000Z', isSidechain: true,
    message: {
      id: 'msg1', role: 'assistant', model: 'claude-opus-5',
      usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: out },
      content: [{ type: 'tool_use', id: 'a1', name: tool, input: { file_path: detail } }],
    },
  },
];

describe('parseScriptPhases', () => {
  it('lit les phases du meta sans évaluer le script', () => {
    const src = `export const meta = {\n  name: 'x',\n  description: 'y',\n  phases: [\n    { title: 'Scan', detail: 'grep logs' },\n    { title: 'Fix' },\n  ],\n}\nphase('Scan')\n`;
    expect(parseScriptPhases(src)).toEqual([
      { index: 1, title: 'Scan', detail: 'grep logs' },
      { index: 2, title: 'Fix', detail: null },
    ]);
  });

  it("ne se fait pas clore par un ] à l'intérieur d'une chaîne", () => {
    const src = `export const meta = { name: 'x', description: 'y', phases: [{ title: 'Cap', detail: 'top-N [capped]' }, { title: 'Then' }] }`;
    expect(parseScriptPhases(src).map((p) => p.title)).toEqual(['Cap', 'Then']);
  });

  it('renvoie [] sur un script sans meta / sans phases', () => {
    expect(parseScriptPhases('const x = 1')).toEqual([]);
    expect(parseScriptPhases(`export const meta = { name: 'x', description: 'y' }`)).toEqual([]);
    expect(parseScriptPhases(null)).toEqual([]);
  });
});

describe('buildWorkflows — run EN COURS (pas encore d\'enregistrement final)', () => {
  it('reconstruit agents, états et compteurs depuis le dossier d\'exécution', () => {
    const d = scaffold('live');
    write(d.fp, launch());
    fs.writeFileSync(path.join(d.scripts, `demo-${RUN}.js`),
      `export const meta = { name: 'demo-flow', description: 'Une démo', phases: [{ title: 'Explore' }, { title: 'Judge' }] }`);
    // deux agents démarrés, un seul a rendu son résultat
    write(path.join(d.run, 'journal.jsonl'), [
      { type: 'started', key: 'v2:aaa', agentId: 'aaa' },
      { type: 'started', key: 'v2:bbb', agentId: 'bbb' },
      { type: 'result', key: 'v2:aaa', agentId: 'aaa', result: { ok: true } },
    ]);
    write(path.join(d.run, 'agent-aaa.jsonl'), agentTranscript('Contexte commun.\nLENS: perf', { ctx: 5000 }));
    write(path.join(d.run, 'agent-bbb.jsonl'), agentTranscript('Contexte commun.\nLENS: sécurité', { ctx: 3000, tool: 'Grep', detail: 'foo' }));

    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.runId).toBe(RUN);
    expect(w.name).toBe('demo-flow');
    expect(w.summary).toBe('Une démo');
    expect(w.status).toBe('running');
    expect(w.live).toBe(true);
    expect(w.agentCount).toBe(2);
    expect(w.runningCount).toBe(1);
    expect(w.doneCount).toBe(1);
    // le compteur de tokens est le CONTEXTE DE POINTE (ce que le TUI affiche), pas l'usage cumulé
    expect(w.agents.map((a) => a.tokens)).toEqual([5000, 3000]);
    expect(w.totalTokens).toBe(8000);
    expect(w.agents.map((a) => a.state)).toEqual(['done', 'running']);
    expect(w.agents.map((a) => a.model)).toEqual(['opus-5', 'opus-5']);
    expect(w.agents[1].lastTool).toBe('Grep');
    // les phases déclarées sont connues, mais l'attribution agent→phase n'existe pas en live
    expect(w.phases.map((p) => p.title)).toEqual(['Explore', 'Judge']);
    expect(w.phases.every((p) => p.agents.length === 0)).toBe(true);
    expect(w.unphased).toHaveLength(2);
  });

  it("compte les tokens de sortie sur la DERNIÈRE ligne d'un message, pas la première", () => {
    // Un même message.id apparaît sur plusieurs lignes au fil du streaming ; les premières
    // portent un output_tokens de remplissage. Garder la première (réflexe anti-double-comptage)
    // sous-compte le coût d'un facteur ~7 sur un agent réel.
    const d = scaffold('lastwins');
    write(d.fp, launch());
    write(path.join(d.run, 'journal.jsonl'), [{ type: 'started', key: 'v2:aaa', agentId: 'aaa' }]);
    const usage = (out) => ({ input_tokens: 10, cache_read_input_tokens: 990, cache_creation_input_tokens: 0, output_tokens: out });
    write(path.join(d.run, 'agent-aaa.jsonl'), [
      { type: 'user', timestamp: '2026-09-01T10:00:02.000Z', message: { role: 'user', content: 'go' } },
      // même id, trois lignes : 1 (placeholder) → 2 (placeholder) → 900 (le vrai total)
      { type: 'assistant', timestamp: '2026-09-01T10:00:03.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', usage: usage(1), content: [] } },
      { type: 'assistant', timestamp: '2026-09-01T10:00:04.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', usage: usage(2), content: [] } },
      { type: 'assistant', timestamp: '2026-09-01T10:00:05.000Z', message: { id: 'm1', role: 'assistant', model: 'claude-opus-5', usage: usage(900), content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } },
    ]);
    const [w] = buildWorkflows(d.fp);
    // opus : 900 tok de sortie à 25 $/Mtok = 0,0225 $, + l'entrée (10 à 5 $/Mtok) + cache read
    // (990 à 0,5 $/Mtok). Le point du test : 900, jamais 1 ni 903.
    expect(w.cost).toBeCloseTo(900 * 25e-6 + 10 * 5e-6 + 990 * 0.5e-6, 9);
    expect(w.agents[0].tokens).toBe(1000);   // contexte de pointe, inchangé
    expect(w.agents[0].toolCalls).toBe(1);   // les tool_use ne se répètent pas : addition franche
  });

  it('étiquette les agents par la ligne qui les DISTINGUE (préambule commun retiré)', () => {
    const d = scaffold('hint');
    write(d.fp, launch());
    write(path.join(d.run, 'journal.jsonl'), [
      { type: 'started', key: 'v2:aaa', agentId: 'aaa' },
      { type: 'started', key: 'v2:bbb', agentId: 'bbb' },
    ]);
    const preamble = 'Repository: /home/x\nRègles: lecture seule\n';
    write(path.join(d.run, 'agent-aaa.jsonl'), agentTranscript(`${preamble}LENS: perf`));
    write(path.join(d.run, 'agent-bbb.jsonl'), agentTranscript(`${preamble}LENS: sécurité`));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.agents.map((a) => a.hint)).toEqual(['LENS: perf', 'LENS: sécurité']);
  });

  it('un agent seul garde la première ligne de son prompt (pas de préfixe à retirer)', () => {
    const d = scaffold('solo');
    write(d.fp, launch());
    write(path.join(d.run, 'journal.jsonl'), [{ type: 'started', key: 'v2:aaa', agentId: 'aaa' }]);
    write(path.join(d.run, 'agent-aaa.jsonl'), agentTranscript('\nAudite le module de paiement.'));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.agents[0].hint).toBe('Audite le module de paiement.');
  });

  it('une notification terminale clôt le run même sans enregistrement final (kill)', () => {
    const d = scaffold('killed');
    write(d.fp, [...launch(), notification('killed')]);
    write(path.join(d.run, 'journal.jsonl'), [{ type: 'started', key: 'v2:aaa', agentId: 'aaa' }]);
    write(path.join(d.run, 'agent-aaa.jsonl'), agentTranscript('x'));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.status).toBe('killed');
    expect(w.live).toBe(true);
  });

  it("clôt aussi sur `stopped` — l'arrêt depuis l'UI / TaskStop n'écrit AUCUN record", () => {
    // Régression : le vocabulaire terminal local avait divergé de celui de background.js et
    // ignorait `stopped`. Or c'est précisément le cas où la notification est le SEUL signal
    // existant (rien n'est écrit dans workflows/<runId>.json), donc le run restait « en cours »
    // pour toujours, avec une durée qui grandissait à chaque poll.
    const d = scaffold('stopped');
    write(d.fp, [...launch(), notification('stopped')]);
    write(path.join(d.run, 'journal.jsonl'), [{ type: 'started', key: 'v2:aaa', agentId: 'aaa' }]);
    write(path.join(d.run, 'agent-aaa.jsonl'), agentTranscript('x'));
    const [w] = buildWorkflows(d.fp);
    expect(w.status).toBe('stopped');
  });

  it('accepte la notification portée par un message user à contenu STRING', () => {
    // Le porteur le plus fourni des trois. Il était filtré par un test `Array.isArray` et
    // disparaissait en silence : le run restait « running » malgré une complétion annoncée.
    const d = scaffold('carrier');
    write(d.fp, [...launch(), {
      type: 'user', promptSource: 'system',
      message: { role: 'user', content: `<task-notification>\n<task-id>wtask01</task-id>\n<tool-use-id>tu1</tool-use-id>\n<status>completed</status>\n</task-notification>` },
    }]);
    expect(buildWorkflows(d.fp)[0].status).toBe('completed');
  });

  it("fige la durée d'un run terminé sans record (sinon elle grandit à chaque poll)", () => {
    const d = scaffold('frozen');
    write(d.fp, [...launch(), {
      type: 'queue-operation', operation: 'enqueue',
      timestamp: '2026-09-01T10:05:01.000Z',   // lancé à 10:00:01 → 5 min pile
      content: `<task-notification>\n<tool-use-id>tu1</tool-use-id>\n<status>killed</status>\n</task-notification>`,
    }]);
    const [w] = buildWorkflows(d.fp);
    expect(w.status).toBe('killed');
    expect(w.durationMs).toBe(300000);
  });

  it("retrouve le record écrit sous une session SŒUR (run repris ailleurs)", () => {
    // `resumeFromRunId` depuis une autre session du même projet : le dossier d'exécution reste
    // sous la session d'origine, l'enregistrement final atterrit sous la session qui a repris.
    const d = scaffold('sibling');
    write(d.fp, launch());
    fs.rmSync(d.record, { force: true });
    const sibling = path.join(path.dirname(d.fp), 'aaaaaaaa-0000-4000-8000-000000000000', 'workflows');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, `${RUN}.json`),
      JSON.stringify({ runId: RUN, status: 'killed', phases: [], workflowProgress: [] }));
    const [w] = buildWorkflows(d.fp);
    expect(w.status).toBe('killed');
    expect(w.live).toBe(false);
  });

  it('un run sans dossier d\'exécution ni script ne casse pas (agents vides)', () => {
    const d = scaffold('bare');
    write(d.fp, launch());
    fs.rmSync(d.run, { recursive: true });
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.agents).toEqual([]);
    expect(w.status).toBe('running');
  });
});

describe('buildWorkflows — enregistrement final (fait autorité)', () => {
  const record = {
    runId: RUN, status: 'completed', workflowName: 'demo-flow', summary: 'Une démo',
    startTime: 1788000000000, durationMs: 120000, totalTokens: 90000, totalToolCalls: 12,
    defaultModel: 'claude-opus-5', logs: ['step one'],
    phases: [{ title: 'Explore', detail: '2 agents' }, { title: 'Judge', detail: null }],
    workflowProgress: [
      { type: 'workflow_phase', index: 1, title: 'Explore' },
      { type: 'workflow_agent', index: 1, label: 'explore:a', phaseIndex: 1, phaseTitle: 'Explore', agentId: 'aaa', model: 'claude-opus-5', state: 'done', tokens: 50000, toolCalls: 7, durationMs: 60000, startedAt: 1788000001000, lastToolName: 'StructuredOutput', lastToolSummary: 'a…', promptPreview: 'p1', resultPreview: 'r1' },
      { type: 'workflow_agent', index: 2, label: 'judge', phaseIndex: 2, phaseTitle: 'Judge', agentId: 'bbb', model: 'claude-opus-5', state: 'done', tokens: 40000, toolCalls: 5, durationMs: 40000, startedAt: 1788000002000, promptPreview: 'p2', resultPreview: 'r2' },
    ],
  };

  it('transpose workflowProgress en phases peuplées, sans lire les transcripts d\'agents', () => {
    const d = scaffold('rec');
    write(d.fp, [...launch(), notification()]);
    fs.writeFileSync(d.record, JSON.stringify(record));
    // le dossier d'exécution existe mais ne doit PAS être consulté : journal volontairement absurde
    write(path.join(d.run, 'journal.jsonl'), [{ type: 'started', key: 'v2:zzz', agentId: 'zzz' }]);

    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.live).toBe(false);
    expect(w.status).toBe('completed');
    expect(w.durationMs).toBe(120000);
    expect(w.totalTokens).toBe(90000);
    expect(w.totalToolCalls).toBe(12);
    expect(w.model).toBe('opus-5');
    expect(w.logs).toEqual(['step one']);
    expect(w.agents.map((a) => a.label)).toEqual(['explore:a', 'judge']);
    expect(w.phases.map((p) => [p.title, p.agents.map((a) => a.label)]))
      .toEqual([['Explore', ['explore:a']], ['Judge', ['judge']]]);
    expect(w.unphased).toEqual([]);
    expect(w.agents[0].resultPreview).toBe('r1');
  });

  it("préserve les états d'agent d'un run TUÉ (progress / start), sans les rabattre sur done", () => {
    // Relevé sur les enregistrements réels : un agent porte `done`, `progress`, `start` ou
    // `error`. `progress`/`start` n'apparaissent que sur un run tué — l'agent a été interrompu
    // en vol. Les afficher comme terminés mentirait ; doneCount ne compte donc que les `done`.
    const d = scaffold('states');
    write(d.fp, [...launch(), notification('killed')]);
    fs.writeFileSync(d.record, JSON.stringify({
      runId: RUN, status: 'killed', phases: [{ title: 'Explore' }],
      workflowProgress: [
        { type: 'workflow_agent', index: 1, label: 'a', phaseTitle: 'Explore', agentId: 'aaa', state: 'done' },
        { type: 'workflow_agent', index: 2, label: 'b', phaseTitle: 'Explore', agentId: 'bbb', state: 'progress' },
        { type: 'workflow_agent', index: 3, label: 'c', phaseTitle: 'Explore', agentId: 'ccc', state: 'start' },
        { type: 'workflow_agent', index: 4, label: 'd', phaseTitle: 'Explore', agentId: 'ddd', state: 'error' },
      ],
    }));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.status).toBe('killed');
    expect(w.agents.map((a) => a.state)).toEqual(['done', 'progress', 'start', 'error']);
    expect(w.doneCount).toBe(1);
    expect(w.runningCount).toBe(0);   // ni `progress` ni `start` ne sont « en cours » : le run est mort
    expect(w.agentCount).toBe(4);
  });

  it('ajoute une phase mentionnée par un agent mais absente de meta.phases', () => {
    const d = scaffold('extra');
    write(d.fp, launch());
    const rec = JSON.parse(JSON.stringify(record));
    rec.phases = [{ title: 'Explore' }];   // 'Judge' n'est déclarée que par l'agent
    fs.writeFileSync(d.record, JSON.stringify(rec));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.phases.map((p) => p.title)).toEqual(['Explore', 'Judge']);
    expect(w.unphased).toEqual([]);
  });
});

describe('buildWorkflows — cadrage', () => {
  it('ignore un tool_use Workflow sans lancement asynchrone (invocation refusée)', () => {
    const d = scaffold('refused');
    write(d.fp, [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Workflow', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'refusé' }] } },
    ]);
    expect(buildWorkflows(d.fp, SESSION)).toEqual([]);
  });

  it('renvoie [] sur une session sans workflow', () => {
    const d = scaffold('none');
    write(d.fp, [{ type: 'user', message: { content: 'salut' } }]);
    expect(buildWorkflows(d.fp, SESSION)).toEqual([]);
  });

  it('les chemins sont dérivés du transcript, pas de ceux enregistrés dans le tool_result', () => {
    // transcriptDir/scriptPath du tool_result pointent ailleurs (cf. launch()) : le run est
    // néanmoins résolu, parce qu'on part de <proj>/<session>.jsonl. Un ~/.claude relogé — ou un
    // HOOKED_PROJECTS_DIR de test comme ici — reste donc lisible.
    const d = scaffold('paths');
    write(d.fp, launch());
    fs.writeFileSync(d.record, JSON.stringify({ runId: RUN, status: 'completed', workflowProgress: [], phases: [] }));
    const [w] = buildWorkflows(d.fp, SESSION);
    expect(w.live).toBe(false);
    expect(w.transcriptDir).toBe('/ignored/by/design'); // conservé pour information seulement
  });

  it('le plus récent d\'abord quand la session enchaîne plusieurs runs', () => {
    const d = scaffold('many');
    const second = launch().map((l) => JSON.parse(JSON.stringify(l)));
    second[0].message.content[0].id = 'tu2';
    second[1].message.content[0].tool_use_id = 'tu2';
    second[1].toolUseResult = { ...second[1].toolUseResult, runId: 'wf_deadbeef-002', workflowName: 'second-flow', taskId: 'wtask02' };
    write(d.fp, [...launch(), ...second]);
    expect(buildWorkflows(d.fp, SESSION).map((w) => w.name)).toEqual(['second-flow', 'demo-flow']);
  });
});
