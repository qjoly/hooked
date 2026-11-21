/*
 * Provider vibe, phase M1 : driver ACP (server/vibeAgent.js).
 * - tests unitaires du mapping (modes, elicitation) ;
 * - test d'intégration contre un faux serveur ACP (test/fixtures/fake-acp.cjs) :
 *   initialize → session/new → set_config_option/set_mode → prompt → request_permission
 *   → réponse du "dashboard" → fin de tour.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vibeModeFor, vibeOptions, elicitationContent, questionsFromSchema, vibeStart } from '../server/index.js';

const FAKE = path.join(import.meta.dirname, 'fixtures', 'fake-acp.cjs');

describe('vibeAgent — mapping', () => {
  it('vibeModeFor : modes hooked → agents Vibe', () => {
    expect(vibeModeFor('default')).toBe('ask');
    expect(vibeModeFor('acceptEdits')).toBe('accept-edits');
    expect(vibeModeFor('auto')).toBe('auto-approve');
    expect(vibeModeFor('bypassPermissions')).toBe('auto-approve');
    expect(vibeModeFor('plan')).toBe('ask'); // pas d'équivalent plan côté Vibe (documenté)
    expect(vibeModeFor('???')).toBe('ask');
  });

  it('questionsFromSchema reconstruit les questions hooked depuis une elicitation ACP', () => {
    const schema = {
      properties: {
        q0: { type: 'string', title: 'Moteur', description: 'Quel moteur ?', one_of: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }] },
        q1: { type: 'array', title: 'Extras', description: 'Lesquels ?', items: { any_of: [{ const: 'x', title: 'x' }] } },
      },
      required: ['q0', 'q1'],
    };
    const qs = questionsFromSchema(schema);
    expect(qs).toHaveLength(2);
    expect(qs[0]).toMatchObject({ question: 'Quel moteur ?', header: 'Moteur', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] });
    expect(qs[1]).toMatchObject({ multiSelect: true, options: [{ label: 'x' }] });
  });

  it('elicitationContent : selections hooked → content ACP {q0: label, q1: [labels]}', () => {
    const questions = [
      { question: 'Q0', options: [{ label: 'A' }, { label: 'B' }] },
      { question: 'Q1', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }] },
      { question: 'Q2', options: [{ label: 'C' }] },
    ];
    const content = elicitationContent(questions, [
      { indices: [1] },
      { multi: true, indices: [0, 1] },
      { other: 'réponse libre' },
    ]);
    expect(content).toEqual({ q0: 'B', q1: ['x', 'y'], q2: 'réponse libre' });
  });

  it('vibeOptions lit les alias modèles depuis un config.toml (env HOOKED_VIBE_CONFIG)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cfg-'));
    const fp = path.join(dir, 'config.toml');
    fs.writeFileSync(fp, 'active_model = "medium"\n\n[[models]]\nname = "mistral-large-4"\nalias = "large"\n\n[[models]]\nname = "mistral-medium-3.5"\nalias = "medium"\nthinking = "high"\n');
    process.env.HOOKED_VIBE_CONFIG = fp;
    try {
      const o = vibeOptions();
      expect(o.activeModel).toBe('medium');
      expect(o.models.map((m) => m.alias)).toEqual(['large', 'medium']);
      expect(o.modes.map((m) => m.id)).toEqual(['default', 'acceptEdits', 'auto']);
      expect(o.thinkingLevels).toContain('high');
    } finally {
      delete process.env.HOOKED_VIBE_CONFIG;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('vibeAgent — intégration faux serveur ACP', () => {
  it('start → new → options → prompt → request_permission → réponse → fin de tour', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-acp-'));
    const log = path.join(dir, 'acp.log');
    process.env.FAKE_ACP_LOG = log;
    process.env.HOOKED_VIBE_ACP_BIN = process.execPath; // on spawne node fake-acp.cjs via args
    try {
      const st = { id: null, cwd: dir, provider: 'vibe', busy: false, sdkState: 'idle', pendingAsk: null, sawMsg: false, activity: null, lastProse: null, lastMsgAt: 0, ended: false, stream: null };
      let doneSt = null;
      const streams = []; // snapshots du tampon live poussés via ctx.emit
      const ctx = {
        setLive: () => {},
        persistLaunch: () => {},
        emit: (s) => { streams.push(s.stream ? { ...s.stream } : null); },
        done: (s) => { doneSt = s; },
        failStartup: (s) => { throw new Error('failStartup: ' + s.error); },
      };
      // vibeStart spawne ACP_BIN sans args — on passe par une astuce : HOOKED_VIBE_ACP_BIN = node
      // et le script en arg ? Non : on monkey-patche via un wrapper shell.
      // → plus simple : on appelle vibeStart avec ACP_BIN pointant sur un wrapper exécutable.
      const wrapper = path.join(dir, 'vibe-acp');
      fs.writeFileSync(wrapper, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(FAKE)}\n`);
      fs.chmodSync(wrapper, 0o755);
      process.env.HOOKED_VIBE_ACP_BIN = wrapper;

      await vibeStart(st, { prompt: 'salut', model: 'medium', effort: 'high', permissionMode: 'default', env: process.env }, ctx);
      expect(doneSt).toBe(st);
      expect(st.id).toBe('fake-sess-1');
      expect(st.provider).toBe('vibe');

      // le prompt a été envoyé ; le faux serveur a émis request_permission → pendingAsk
      await new Promise((r) => setTimeout(r, 300));
      expect(st.pendingAsk).toBeTruthy();
      expect(st.pendingAsk.kind).toBe('permission');
      expect(st.pendingAsk.toolName).toContain('bash');
      expect(st.sdkState).toBe('requires_action');

      // le dashboard répond « allow » → le faux serveur reçoit outcome allow_once
      st.pendingAsk.resolve({ behavior: 'allow' });
      st.pendingAsk = null;
      await new Promise((r) => setTimeout(r, 300));

      const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const inMsgs = lines.filter((l) => l.dir === 'in');
      expect(inMsgs.map((m) => m.method)).toEqual(expect.arrayContaining(['initialize', 'session/new', 'session/set_config_option', 'session/set_mode', 'session/prompt']));
      const permReply = inMsgs.find((m) => m.id === 900 && m.result);
      expect(permReply.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
      const promptReply = lines.find((l) => l.dir === 'out' && l.id !== undefined && l.result && l.result.stop_reason);
      expect(promptReply.result.stop_reason).toBe('end_turn');
      // notification tool_call reçue → activity
      expect(st.activity).toBeTruthy();
      // le chunk 'done!' a alimenté le tampon live, puis usage_update (fin de tour) l'a vidé :
      // la preview ne doit pas rester affichée à côté de la bulle du transcript
      expect(streams.some((s) => s && s.text === 'done!')).toBe(true);
      expect(streams[streams.length - 1]).toBeNull();
      expect(st.stream).toBeNull();
      st.acp.close();
    } finally {
      delete process.env.FAKE_ACP_LOG;
      delete process.env.HOOKED_VIBE_ACP_BIN;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 15000);
});
