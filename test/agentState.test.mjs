/*
 * State derivation from the Agent SDK message stream (server/agent.js).
 *
 * This is the replacement for everything that used to be screen-scraping tests (parseSpinner,
 * parsePaneMode, conversationBody, paneActiveStep, lastPaneProse): the same five facts about a live
 * session — is it busy, what is it doing, what did it last say, what mode is it in, what did it
 * suggest next — now arrive as structured messages instead of being parsed out of a terminal
 * screenshot. `applyMessage` is the whole derivation and it is pure over (state, message), so it is
 * testable without spawning a session.
 *
 * Message shapes come from the SDK's own types (SDKSystemMessage, SDKStatusMessage,
 * SDKSessionStateChangedMessage, SDKAssistantMessage, SDKResultMessage, SDKPromptSuggestionMessage).
 */
import { describe, it, expect } from 'vitest';
import { applyMessage, makeInputQueue, userMessage, permissionQuestion, parseEnvBlock, isRequestStart } from '../server/agent.js';

const fresh = () => ({ busy: false, sdkState: 'idle', activity: null, lastProse: null, followup: null });

describe('applyMessage — system/init', () => {
  it('picks up model, permission mode, effort and the real cwd', () => {
    const st = fresh();
    // `--worktree` moves the session into a fresh git worktree, so the cwd we asked for is not
    // necessarily the cwd it runs in — init is where we learn the real one.
    expect(applyMessage(st, {
      type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5',
      permissionMode: 'plan', effort: 'xhigh', cwd: '/tmp/wt/feature-x',
    })).toBe(true);
    expect(st.model).toBe('claude-opus-5');
    expect(st.permissionMode).toBe('plan');
    expect(st.effort).toBe('xhigh');
    expect(st.cwd).toBe('/tmp/wt/feature-x');
  });
});

describe('applyMessage — busy (ex-spinner du footer)', () => {
  it('status requesting / compacting → busy, null → idle', () => {
    const st = fresh();
    applyMessage(st, { type: 'system', subtype: 'status', status: 'requesting' });
    expect(st.busy).toBe(true);
    applyMessage(st, { type: 'system', subtype: 'status', status: 'compacting' });
    expect(st.busy).toBe(true);
    applyMessage(st, { type: 'system', subtype: 'status', status: null });
    expect(st.busy).toBe(false);
  });

  it('a status message also refreshes the permission mode', () => {
    const st = fresh();
    applyMessage(st, { type: 'system', subtype: 'status', status: 'requesting', permissionMode: 'acceptEdits' });
    expect(st.permissionMode).toBe('acceptEdits');
  });

  it('session_state_changed is the authoritative running/idle signal', () => {
    const st = fresh();
    applyMessage(st, { type: 'system', subtype: 'session_state_changed', state: 'running' });
    expect(st).toMatchObject({ sdkState: 'running', busy: true });
    applyMessage(st, { type: 'system', subtype: 'session_state_changed', state: 'idle' });
    expect(st).toMatchObject({ sdkState: 'idle', busy: false });
    applyMessage(st, { type: 'system', subtype: 'session_state_changed', state: 'requires_action' });
    expect(st).toMatchObject({ sdkState: 'requires_action', busy: false });
  });
});

describe('applyMessage — assistant blocks', () => {
  it('tool_use sets the current activity (ex-gérondif animé du spinner)', () => {
    const st = fresh();
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Grep' }] } });
    expect(st.activity).toBe('Grep');
  });

  it('text sets lastProse — the lead-in a pending question needs', () => {
    // Tant qu'une AskUserQuestion n'a pas reçu sa réponse, Claude Code n'écrit RIEN du tour dans le
    // transcript : le texte d'introduction n'existe que sur ce flux. C'était la seule raison de
    // scraper le scrollback du pane avec ses bordures de boîte et ses résumés d'activité.
    const st = fresh();
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'text', text: '  Two options here.  ' }] } });
    expect(st.lastProse).toBe('Two options here.');
  });

  it('ignores empty / whitespace-only text and thinking blocks', () => {
    const st = fresh();
    st.lastProse = 'kept';
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'text', text: '   ' }, { type: 'thinking', thinking: 'x' }] } });
    expect(st.lastProse).toBe('kept');
  });

  it('a tool_use_summary is not prose', () => {
    // « Searched for 6 patterns, ran 18 shell commands » : le TUI le collait sous la prose, et
    // l'ancien parser devait le retrancher du bloc à la main.
    const st = fresh();
    st.lastProse = 'real answer';
    expect(applyMessage(st, { type: 'tool_use_summary', summary: 'Searched for 6 patterns' })).toBe(false);
    expect(st.lastProse).toBe('real answer');
  });

  it('caps lastProse so one huge answer cannot bloat the registry', () => {
    const st = fresh();
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(20000) }] } });
    expect(st.lastProse.length).toBe(8000);
  });

  it('tolerates a malformed assistant message', () => {
    // Le retour est `true` même sans bloc exploitable : recevoir un message assistant marque la
    // session « en cours » (cf. markRunning), et c'est bien une nouvelle pour l'UI. Ce qui compte
    // ici est qu'aucune de ces formes ne lève.
    const st = fresh();
    expect(applyMessage(st, { type: 'assistant' })).toBe(true);
    expect(applyMessage(st, { type: 'assistant', message: {} })).toBe(true);
    expect(st.lastProse).toBe(null);
    expect(st.activity).toBe(null);
  });
});

describe('applyMessage — result & suggestion', () => {
  it('result clears busy/activity and records the turn cost', () => {
    const st = { ...fresh(), busy: true, sdkState: 'running', activity: 'Bash' };
    applyMessage(st, { type: 'result', subtype: 'success', total_cost_usd: 0.42, num_turns: 3, is_error: false });
    expect(st).toMatchObject({ busy: false, activity: null, sdkState: 'idle' });
    expect(st.lastResult).toEqual({ costUsd: 0.42, turns: 3, isError: false });
  });

  it('prompt_suggestion carries the follow-up (ex-ghost text DIM de la boîte de saisie)', () => {
    const st = fresh();
    applyMessage(st, { type: 'prompt_suggestion', suggestion: '  Run the tests  ' });
    expect(st.followup).toBe('Run the tests');
    applyMessage(st, { type: 'prompt_suggestion', suggestion: '   ' });
    expect(st.followup).toBe(null);
  });
});

describe('applyMessage — unknown input', () => {
  it('never throws and reports "nothing changed"', () => {
    const st = fresh();
    for (const m of [null, undefined, 'string', 42, {}, { type: 'brand_new_kind' }, { type: 'system', subtype: 'whatever' }]) {
      expect(applyMessage(st, m)).toBe(false);
    }
    expect(st).toEqual(fresh());
  });
});

describe('permissionQuestion — a tool permission rendered as a question', () => {
  it('offers allow-once / allow-always / deny in that order', () => {
    // L'ordre est le contrat de l'aiguillage côté /api/reply (indice 0/1/2 → allow/always/deny) et
    // laisse l'UI web réutiliser son composant Question sans rien connaître des permissions.
    const [q] = permissionQuestion('Bash', { title: 'Claude wants to run npm test' });
    expect(q.multiSelect).toBe(false);
    expect(q.header).toBe('Permission');
    expect(q.options.map((o) => o.label)).toEqual(['Allow once', 'Allow always', 'Deny']);
    expect(q.question).toContain('npm test');
  });

  it('falls back to a title built from the tool name when the bridge gave none', () => {
    const [q] = permissionQuestion('WebFetch', {});
    expect(q.question).toContain('WebFetch');
  });
});

describe('makeInputQueue — the streaming-input side', () => {
  it('delivers buffered messages in order', async () => {
    const q = makeInputQueue();
    expect(q.push(userMessage('one'))).toBe(true);
    q.push(userMessage('two'));
    const it = q[Symbol.asyncIterator]();
    expect((await it.next()).value.message.content[0].text).toBe('one');
    expect((await it.next()).value.message.content[0].text).toBe('two');
  });

  it('wakes a consumer that is already waiting', async () => {
    const q = makeInputQueue();
    const it = q[Symbol.asyncIterator]();
    const pending = it.next();
    q.push(userMessage('late'));
    expect((await pending).value.message.content[0].text).toBe('late');
  });

  it('close() ends the iteration and rejects further pushes', async () => {
    const q = makeInputQueue();
    q.close();
    expect(q.closed).toBe(true);
    expect(q.push(userMessage('nope'))).toBe(false);
    expect(await q[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
  });

  it('close() also releases a consumer blocked on next()', async () => {
    // Sans ça, killSession laisserait le sous-processus attendre une entrée qui ne viendra jamais.
    const q = makeInputQueue();
    const pending = q[Symbol.asyncIterator]().next();
    q.close();
    expect(await pending).toEqual({ value: undefined, done: true });
  });

  it('userMessage builds the SDKUserMessage shape the SDK expects', () => {
    expect(userMessage('hi')).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      parent_tool_use_id: null,
    });
  });
});

describe('parseEnvBlock — env du shell de login', () => {
  // Reproduit ce que `$SHELL -l -i -c 'printf "__HOOKED_ENV__\0"; env -0'` renvoie.
  const block = (vars, noise = '') =>
    noise + '__HOOKED_ENV__\0' + Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\0');

  it('reads the variables that follow the sentinel', () => {
    expect(parseEnvBlock(block({ PATH: '/a:/b', GITHUB_TOKEN: 'tok' })))
      .toEqual({ PATH: '/a:/b', GITHUB_TOKEN: 'tok' });
  });

  it('ignores everything a chatty profile printed before the sentinel', () => {
    // `mise activate`, un message du jour, un warning de plugin… écrivent sur stdout.
    const out = block({ PATH: '/a' }, 'mise: activating\nWelcome!\nNOISE=should-not-be-read\0');
    expect(parseEnvBlock(out)).toEqual({ PATH: '/a' });
  });

  it('keeps multi-line values intact (why we use env -0, not lines)', () => {
    expect(parseEnvBlock(block({ LS_COLORS: 'di=1\nln=2', PATH: '/a' })).LS_COLORS).toBe('di=1\nln=2');
  });

  it('drops the resolver shell own bookkeeping', () => {
    // PWD/OLDPWD décriraient le cwd du shell résolveur, pas celui de la session ; TMUX* et __MISE_*
    // sont l'état de session du résolveur.
    const env = parseEnvBlock(block({
      PATH: '/a', PWD: '/tmp', OLDPWD: '/', SHLVL: '3', _: '/usr/bin/env',
      TMUX: '/x', TMUX_PANE: '%9', MISE_SHELL: 'zsh', __MISE_SESSION: 'abc',
    }));
    expect(env).toEqual({ PATH: '/a' });
  });

  it('rejects malformed entries instead of inventing keys', () => {
    expect(parseEnvBlock(block({ PATH: '/a' }) + '\0no-equals-sign\0=novalue\0BAD KEY=x'))
      .toEqual({ PATH: '/a' });
  });

  it('returns an empty object when the sentinel never appeared', () => {
    // Shell qui a échoué / n'a rien écrit → loginEnv retombe sur l'env de hooked.
    expect(parseEnvBlock('command not found\n')).toEqual({});
    expect(parseEnvBlock('')).toEqual({});
  });
});

describe('applyMessage — « la session travaille » sans session_state_changed', () => {
  // Mesuré sur un tour complet : le CLI n'émet AUCUN `session_state_changed`, et un seul
  // `status: requesting` au début. Se reposer sur le premier laissait donc sdkState à 'idle' en
  // permanence — et refineWithAgent repeignait alors en « waiting » une session en plein travail.
  // D'où la dérivation à partir de tous les signaux d'activité disponibles.
  const running = { sdkState: 'running', busy: true };

  it('un delta de streaming suffit à marquer la session en cours', () => {
    const st = fresh();
    applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } });
    expect(st).toMatchObject(running);
    expect(st.stream.text).toBe('Hel');
  });

  it('un message assistant aussi (le tour n\'est clos que par result)', () => {
    const st = fresh();
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
    expect(st).toMatchObject(running);
  });

  it('status requesting → running, status null → idle', () => {
    const st = fresh();
    applyMessage(st, { type: 'system', subtype: 'status', status: 'requesting' });
    expect(st).toMatchObject(running);
    applyMessage(st, { type: 'system', subtype: 'status', status: null });
    expect(st).toMatchObject({ sdkState: 'idle', busy: false });
  });

  it('une ATTENTE en cours prime : aucun signal d\'activité ne la repeint en working', () => {
    // Sinon un delta en retard effacerait la carte question/permission de l'UI alors que Claude
    // est justement bloqué dessus.
    const st = { ...fresh(), pendingAsk: { kind: 'permission' }, sdkState: 'requires_action' };
    applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } } });
    applyMessage(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'y' }] } });
    applyMessage(st, { type: 'system', subtype: 'status', status: 'requesting' });
    expect(st.sdkState).toBe('requires_action');
    expect(st.busy).toBe(false);
  });

  it('result ferme le tour ET vide le tampon de streaming', () => {
    const st = { ...fresh(), sdkState: 'running', busy: true, stream: { text: 'partial' } };
    applyMessage(st, { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, is_error: false });
    expect(st).toMatchObject({ sdkState: 'idle', busy: false, stream: null });
  });
});

describe('applyMessage — accumulation du streaming', () => {
  it('message_start repart de zéro (un tour = plusieurs messages assistant)', () => {
    const st = { ...fresh(), stream: { text: 'du tour précédent', thinking: '', tool: null, types: {} } };
    applyMessage(st, { type: 'stream_event', event: { type: 'message_start' } });
    expect(st.stream).toEqual({ text: '', thinking: '', tool: null, types: {} });
  });

  it('concatène les text_delta dans l\'ordre', () => {
    const st = fresh();
    for (const t of ['La ', 'mer ', 'est ', 'calme.']) {
      applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } } });
    }
    expect(st.stream.text).toBe('La mer est calme.');
  });

  it('sépare le raisonnement du texte', () => {
    const st = fresh();
    applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } });
    applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ok' } } });
    expect(st.stream).toMatchObject({ thinking: 'hmm', text: 'ok' });
  });

  it('retient le nom de l\'outil dès l\'ouverture du bloc, avant son input complet', () => {
    const st = fresh();
    applyMessage(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Grep' } } });
    expect(st.stream.tool).toBe('Grep');
  });

  it('ignore un delta d\'un type inconnu sans casser', () => {
    const st = fresh();
    expect(applyMessage(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'x' } } })).toBe(true);
    expect(st.stream.text).toBe('');
    expect(applyMessage(st, { type: 'stream_event' })).toBe(false);
  });
});

describe('applyMessage — prompt-cache clock (cf. src/lib/promptCache.js)', () => {
  it('result records what the next request re-sends and which TTL the write got', () => {
    const st = fresh();
    applyMessage(st, {
      type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, is_error: false,
      usage: {
        input_tokens: 32, cache_read_input_tokens: 329_313, cache_creation_input_tokens: 6_234, output_tokens: 3_420,
        cache_creation: { ephemeral_1h_input_tokens: 6_234, ephemeral_5m_input_tokens: 0 },
      },
    });
    expect(st.lastUsage).toEqual({ contextTokens: 338_999, ttl: '1h' });
    // a result without usage (crash, API error) keeps the last known value
    applyMessage(st, { type: 'result', subtype: 'error_during_execution', is_error: true });
    expect(st.lastUsage).toEqual({ contextTokens: 338_999, ttl: '1h' });
  });

  it('isRequestStart: `status requesting` and `message_start` mark the start of an API request', () => {
    expect(isRequestStart({ type: 'system', subtype: 'status', status: 'requesting' })).toBe(true);
    expect(isRequestStart({ type: 'stream_event', event: { type: 'message_start' } })).toBe(true);
    expect(isRequestStart({ type: 'system', subtype: 'status', status: null })).toBe(false);
    expect(isRequestStart({ type: 'stream_event', event: { type: 'content_block_delta' } })).toBe(false);
    expect(isRequestStart({ type: 'assistant' })).toBe(false);
    expect(isRequestStart(null)).toBe(false);
  });
});

describe('applyMessage — compaction', () => {
  it('status compacting shows as the activity, the result clears it', () => {
    const st = fresh();
    applyMessage(st, { type: 'system', subtype: 'status', status: 'compacting' });
    expect(st).toMatchObject({ busy: true, activity: 'Compacting' });
    applyMessage(st, { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 0, is_error: false });
    expect(st).toMatchObject({ busy: false, activity: null });
  });

  it('compact_boundary resets the cache clock: the next request writes a fresh, smaller prefix', () => {
    const st = { ...fresh(), lastRequestAt: 1_000, lastUsage: { contextTokens: 300_000, ttl: '1h' } };
    expect(applyMessage(st, { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 300_000, post_tokens: 9_000 } })).toBe(true);
    expect(st.lastRequestAt).toBe(null);
    expect(st.lastUsage).toBe(null);
  });

  it('the result of our own /compact ends it and keeps the suggestion on screen', () => {
    const st = { ...fresh(), followup: 'Run the linter', autoCompacting: true };
    applyMessage(st, { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 0, is_error: false });
    expect(st).toMatchObject({ autoCompacting: false, followup: 'Run the linter' });
    // a suggestion computed after the compaction does not replace the real one; the next one does
    expect(applyMessage(st, { type: 'prompt_suggestion', suggestion: 'Continue' })).toBe(false);
    expect(st.followup).toBe('Run the linter');
    applyMessage(st, { type: 'prompt_suggestion', suggestion: 'Ship it' });
    expect(st.followup).toBe('Ship it');
  });

  it('a result that is not ours keeps the suggestions flowing', () => {
    const st = { ...fresh(), autoCompacting: false };
    applyMessage(st, { type: 'result', subtype: 'success', total_cost_usd: 0, num_turns: 1, is_error: false });
    expect(applyMessage(st, { type: 'prompt_suggestion', suggestion: 'Ship it' })).toBe(true);
    expect(st.followup).toBe('Ship it');
  });
});
