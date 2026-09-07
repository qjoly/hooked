/*
 * Auto-approbation des permissions d'outil (server/agent.js → handleToolPermission / setAutoApprove).
 *
 * Pourquoi ces tests existent : `canUseTool` n'est consulté que pour les appels que Claude Code a
 * décidé d'ESCALADER (une règle `ask` de l'utilisateur, ou le classifieur du mode `auto` qui juge
 * l'appel risqué). Sans auto-approbation, chacun de ces appels plante la session sur une carte à
 * valider à la main — c'est exactement le symptôme « je dois accepter toutes les commandes une à
 * une ». Le garde tient en une ligne dans handleToolPermission, et il a DÉJÀ été perdu une fois lors
 * d'un refactor de cette fonction : d'où un test dessus plutôt qu'une relecture attentive.
 *
 * L'invariant central : auto-approve ne doit JAMAIS avaler un hand-off. AskUserQuestion et
 * ExitPlanMode sont ce qu'on veut voir arriver dans l'UI ; les auto-approuver reviendrait à ce que
 * Claude se réponde à lui-même. C'est aussi ce qui distingue ce drapeau de
 * `permissionMode: 'bypassPermissions'`, qui tranche EN AMONT du callback.
 */
import { describe, it, expect } from 'vitest';
import { handleToolPermission, alwaysAllowRules } from '../server/agent.js';

// Entrée de registre minimale : handleToolPermission ne lit que `autoApprove` et écrit `pendingAsk`.
const entry = (autoApprove) => ({ autoApprove, pendingAsk: null, sdkState: 'running', busy: true });
const ctx = (extra = {}) => ({ toolUseID: 'toolu_1', ...extra });

describe('handleToolPermission — auto-approve ON', () => {
  it('laisse passer un outil ordinaire sans rien demander', async () => {
    const st = entry(true);
    await expect(handleToolPermission(st, 'Bash', { command: 'kubectl get pods' }, ctx()))
      .resolves.toEqual({ behavior: 'allow' });
    expect(st.pendingAsk).toBe(null); // aucune carte posée → la session ne bloque pas
  });

  it('intercepte QUAND MÊME AskUserQuestion', async () => {
    const st = entry(true);
    const questions = [{ question: 'Which colour?', header: 'C', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }];
    handleToolPermission(st, 'AskUserQuestion', { questions }, ctx());
    expect(st.pendingAsk).toMatchObject({ kind: 'question' });
    expect(st.pendingAsk.questions).toEqual(questions);
    expect(st.sdkState).toBe('requires_action');
  });

  it('intercepte QUAND MÊME ExitPlanMode', async () => {
    const st = entry(true);
    handleToolPermission(st, 'ExitPlanMode', { plan: '# Plan\n- do a thing' }, ctx());
    expect(st.pendingAsk).toMatchObject({ kind: 'plan', plan: '# Plan\n- do a thing' });
    expect(st.sdkState).toBe('requires_action');
  });
});

describe('handleToolPermission — auto-approve OFF', () => {
  it('pose une carte de permission et ne résout pas tant qu\'on n\'a pas répondu', async () => {
    const st = entry(false);
    let settled = false;
    handleToolPermission(st, 'Bash', { command: 'rm -rf /tmp/x' }, ctx({ title: 'Claude wants to run rm' }))
      .then(() => { settled = true; });
    expect(st.pendingAsk).toMatchObject({ kind: 'permission', toolName: 'Bash' });
    expect(st.sdkState).toBe('requires_action');
    expect(st.busy).toBe(false);
    // la promesse `canUseTool` reste pendante : c'est ELLE qui bloque Claude.
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('remonte le motif de l\'escalade pour que la carte ne dise pas juste « allow? »', () => {
    const st = entry(false);
    handleToolPermission(st, 'Bash', {}, ctx({ decisionReason: 'command not in allow list', matchedAskRule: { source: 'userSettings', toolName: 'Bash' } }));
    expect(st.pendingAsk.reason).toBe('command not in allow list');
    expect(st.pendingAsk.askRule).toEqual({ source: 'userSettings', toolName: 'Bash' });
  });

  it('les 3 options sont dans l\'ordre attendu par l\'aiguillage de /api/reply', () => {
    const st = entry(false);
    handleToolPermission(st, 'Write', {}, ctx());
    expect(st.pendingAsk.questions[0].options.map((o) => o.label)).toEqual(['Allow once', 'Allow always', 'Deny']);
  });
});

describe('alwaysAllowRules — « Allow always » doit vraiment persister quelque chose', () => {
  it('préfère les suggestions du bridge (elles portent le bon ruleContent)', () => {
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'kubectl:*' }], behavior: 'allow', destination: 'session' }];
    expect(alwaysAllowRules('Bash', suggestions)).toBe(suggestions);
  });

  it('se rabat sur une règle de session quand le bridge n\'en fournit aucune', () => {
    // Sans ce repli, renvoyer une liste vide ne persistait RIEN : l'utilisateur cliquait
    // « Allow always » et se faisait redemander à l'appel suivant.
    for (const empty of [undefined, null, []]) {
      expect(alwaysAllowRules('Bash', empty)).toEqual([
        { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
      ]);
    }
  });
});
