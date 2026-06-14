<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { ui, data, loadSessions, openModal } from '../lib/state.svelte.js';
  import { getSession, kill, setMode, setModelEffort } from '../lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, fmtDuration, ago, shortModel, prLabel, PERMISSION_MODES, modeLabel, modeMeta, modelAlias } from '../lib/format.js';
  import ModelEffort from './ModelEffort.svelte';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Composer from './Composer.svelte';
  import Changes from './Changes.svelte';
  import Subagents from './Subagents.svelte';
  import Todos from './Todos.svelte';

  let { id } = $props();
  let s = $state(null);          // détail de session
  let tab = $state('chat');
  let body;                      // ref .pane-body (conteneur scrollable)
  let composer;                  // ref Composer (pour déclencher interruption + édition via Échap)
  let lastActivity = null;
  let stopping = $state(false);
  let attachCopied = $state(false);
  // changement de mode de permission (Normal / Auto-edits / Plan) via Maj+Tab dans le pane.
  let modeBusy = $state(false);
  let modeStatus = $state('');
  let modeOverride = $state(null);  // mode visé en optimiste, tant que les hooks ne le reflètent pas

  // mode affiché : choix optimiste sinon mode réel remonté par les hooks (défaut : Normal).
  const modeView = $derived(modeOverride || (s && s.permissionMode) || 'default');
  // messages envoyés en attente d'apparaître dans le transcript (file d'attente, comme le CLI).
  let queued = $state([]);
  let forceBottom = false;          // force le scroll en bas au prochain rendu (envoi d'un message)

  const events = $derived(s ? (s.events || []).slice().reverse() : []);

  // indicateur 5 h compact pour la ligne de stats : valeur réelle (statusline) sinon estimation.
  const stat5h = $derived.by(() => {
    if (!s) return null;
    const rl = s.rateLimit && s.rateLimit.fiveHour;
    if (rl && rl.pct != null) {
      return { pct: rl.pct, est: false, title: 'Rate limit de session 5 h (réel)' + (rl.resetInMin != null ? ` — réinitialise dans ${fmtDuration(rl.resetInMin)}` : '') };
    }
    if (s.usage5h) {
      const u = s.usage5h;
      return { pct: u.pct, est: true, title: `Estimation 5 h : ${fmtCost(u.cost)} / ${fmtCost(u.budget)}` + (u.resetInMin != null ? ` — réinitialise dans ${fmtDuration(u.resetInMin)}` : '') };
    }
    return null;
  });

  async function load(isRefresh) {
    let prevScroll = null, wasAtBottom = false;
    if (isRefresh && body) {
      prevScroll = body.scrollTop;
      wasAtBottom = (body.scrollHeight - body.scrollTop - body.clientHeight) < 60;
    }
    let d;
    try { d = await getSession(id); } catch (_) { return; }
    if (ui.currentSessionId !== id) return;
    s = d;
    lastActivity = d.lastActivity || null;
    // les hooks reflètent enfin le mode visé → on lâche le choix optimiste.
    if (modeOverride && d.permissionMode === modeOverride) modeOverride = null;
    // un message en file disparaît dès qu'il apparaît comme bulle user dans le transcript.
    if (queued.length) {
      const userTexts = new Set((d.messages || []).filter((m) => m.role === 'user').map((m) => (m.text || '').trim()));
      queued = queued.filter((q) => !userTexts.has(q.text.trim()));
    }
    await tick();
    const keepPos = isRefresh && !wasAtBottom && !forceBottom && prevScroll != null;
    forceBottom = false;
    if (body) body.scrollTop = keepPos ? prevScroll : body.scrollHeight;
  }

  // appelé par le Composer juste après un envoi réussi : affiche le message en file et scroll en bas.
  async function onSent(t) {
    queued = [...queued, { text: t, ts: new Date().toISOString() }];
    forceBottom = true;
    await tick();
    if (body) body.scrollTop = body.scrollHeight;
  }

  onMount(() => load(false));

  // Échap dans la vue chat (hors textarea — le composer gère lui-même quand il a le focus) :
  // interrompt Claude et recharge le dernier prompt pour l'éditer, comme dans le CLI claude-code.
  function onWindowKey(e) {
    if (e.key !== 'Escape' || tab !== 'chat' || ui.modal) return;
    if (e.target && e.target.id === 'reply-text') return; // déjà géré par le composer focalisé
    if (!composer) return;
    e.preventDefault();
    composer.interruptEdit();
  }
  onMount(() => { window.addEventListener('keydown', onWindowKey); });
  onDestroy(() => { window.removeEventListener('keydown', onWindowKey); });

  // live : sur chaque tick, refetch ciblé (question (dis)paraît, ou chat actif qui bouge)
  $effect(() => {
    ui.tick; // dépendance
    untrack(() => {
      const sess = data.sessions.find((x) => x.id === id);
      if (!sess || !s) return;
      const cardShown = !!s.pendingQuestion;
      const qChanged = (sess.hasQuestion && !cardShown) || (!sess.hasQuestion && cardShown);
      const activityChanged = sess.lastActivity && sess.lastActivity !== lastActivity;
      if (qChanged || (tab === 'chat' && (sess.state === 'working' || activityChanged))) load(true);
    });
  });

  function resume() {
    ui.modal = { type: 'resume', data: { id: s.id, project: s.project, projectName: s.projectName, title: s.title, model: s.launchModel || modelAlias(s.model), effort: s.effort } };
  }

  // changement à chaud du modèle / de l'effort d'une session live (envoie /model et /effort
  // dans le TUI). État local synchronisé sur les vraies valeurs tant qu'on n'édite pas.
  let editModel = $state('');
  let editEffort = $state('');
  let meBusy = $state(false);
  let meStatus = $state('');
  $effect(() => {
    if (!s || meBusy) return;
    // launchModel (persisté, reflète notre dernier /model) prioritaire ; sinon modèle du transcript.
    const m = s.launchModel || modelAlias(s.model) || 'opus';
    const e = s.effort || 'high';
    untrack(() => { editModel = m; editEffort = e; });
  });
  async function applyModelEffort() {
    if (meBusy) return;
    meBusy = true;
    meStatus = '…';
    const res = await setModelEffort(s.id, editModel, editEffort).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      meStatus = '✓ ' + editModel + ' · ' + editEffort;
      setTimeout(() => { meStatus = ''; }, 2500);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      meStatus = '✗ ' + (res.data.error || 'échec');
      setTimeout(() => { meStatus = ''; }, 3500);
    }
    meBusy = false;
  }
  async function stop() {
    if (!confirm('Stopper cette session ? Le pane tmux où tourne Claude sera fermé.')) return;
    stopping = true;
    const res = await kill(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { setTimeout(() => { loadSessions(); ui.tick++; }, 800); }
    else { stopping = false; alert('✗ ' + (res.data.error || 'échec')); }
  }
  async function switchMode(target) {
    if (modeBusy || modeView === target) return;
    modeBusy = true;
    modeStatus = '…';
    const res = await setMode(s.id, target).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      modeOverride = res.data.mode || target;  // mode réellement atteint, vérifié côté serveur
      modeStatus = '✓ ' + modeLabel(modeOverride);
      setTimeout(() => { modeStatus = ''; }, 2000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      modeStatus = '✗ ' + (res.data.error || 'échec');
      setTimeout(() => { modeStatus = ''; }, 3000);
    }
    modeBusy = false;
  }
  async function copyAttach() {
    try { await navigator.clipboard.writeText(s.tmuxAttach); attachCopied = true; setTimeout(() => (attachCopied = false), 1500); } catch (_) {}
  }
</script>

{#if s}
  <div class="pane-head s-{s.state}">
    <div class="card-top" style="cursor:default;margin-bottom:6px">
      <button class="pane-back" onclick={() => (ui.currentSessionId = null)} title="Retour à la liste">←</button>
      <span class="proj">{s.projectName || '?'}</span>
      {#if s.gitBranch}<span class="branch">{s.gitBranch}</span>{/if}
      {#if s.tmuxAlive}
        <span class="ro-tag live">↩ réponse possible</span>
        <button class="stop-btn" disabled={stopping} onclick={stop}>{stopping ? '⏳ arrêt…' : '⏹ Stopper'}</button>
        {#if s.tmuxAttach}
          <button class="attach-btn" title={s.tmuxAttach} onclick={copyAttach}>{attachCopied ? '✓ copié' : '⧉ Copier attach'}</button>
        {/if}
      {:else if s.tmuxPane}
        <span class="ro-tag">⛔ tmux fermé · un message relance</span>
        <button class="resume-btn" onclick={resume}>▶ Reprendre dans tmux</button>
      {:else}
        <span class="ro-tag">lecture seule</span>
        <button class="resume-btn" onclick={resume}>▶ Reprendre dans tmux</button>
      {/if}
      <span class="badge s-badge" style="margin-left:auto">{STATE_LABEL[s.state] || s.state}</span>
    </div>
    <h2 style="margin:6px 0 0">{s.title}</h2>
    {#if s.tmuxAlive}
      {@const cur = modeMeta(modeView)}
      <div class="head-toolbar">
        <div class="tb-group" title="Mode de permission de Claude (Maj+Tab dans la session)">
          {#if !PERMISSION_MODES.some((m) => m.key === modeView)}
            <span class="mode-now mode-{modeView}" title={cur.title}><span class="mode-ico">{cur.icon}</span>{cur.label}</span>
          {/if}
          {#each PERMISSION_MODES as m}
            <button class="mode-chip" class:active={modeView === m.key} disabled={modeBusy}
                    onclick={() => switchMode(m.key)} title={m.title}>
              <span class="mode-ico">{m.icon}</span>{m.label}
            </button>
          {/each}
          {#if modeStatus}<span class="mode-status">{modeStatus}</span>{/if}
        </div>
        <span class="tb-sep"></span>
        <div class="tb-group" title="Modèle et effort de la session — applique /model et /effort dans le TUI">
          <ModelEffort compact bind:model={editModel} bind:effort={editEffort} onchange={applyModelEffort} disabled={meBusy} />
          {#if meStatus}<span class="mode-status">{meStatus}</span>{/if}
        </div>
      </div>
    {/if}
    <div class="head-stats" onclick={() => openModal('cost')} title="Voir le détail du coût estimé">
      <span><b>{fmtCost(s.cost)}</b>{#if s.subagentCost > 0} <span class="hs-sub">(dont {fmtCost(s.subagentCost)} agents)</span>{/if}</span>
      <span class="hs-dot">·</span><span>{s.userPrompts} prompts</span>
      <span class="hs-dot">·</span><span>{fmtTokens(s.usage.output)} out</span>
      <span class="hs-dot">·</span><span>{fmtTokens(s.usage.cacheRead)} cache</span>
      {#if !s.tmuxAlive && s.model}<span class="hs-dot">·</span><span>{shortModel(s.model)}</span>{/if}
      {#if stat5h && stat5h.pct != null}
        <span class="hs-dot">·</span>
        <span class="hs-5h" class:warn={stat5h.pct >= 75} class:full={stat5h.pct >= 95} title={stat5h.title}>⏳ {stat5h.pct}%{#if stat5h.est} est.{/if}</span>
      {/if}
      {#if s.prLinks && s.prLinks.length}
        {#each s.prLinks as l}
          <span class="hs-dot">·</span>
          <a class="hs-pr" href={l} target="_blank" rel="noopener" title={l} onclick={(e) => e.stopPropagation()}>🔗 {prLabel(l)}</a>
        {/each}
      {/if}
      <span class="hs-more">›</span>
    </div>
    <div class="subtabs">
      <button class="subtab" class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>💬 Conversation <span class="count">{(s.messages || []).length}</span></button>
      <button class="subtab" class:active={tab === 'changes'} onclick={() => (tab = 'changes')}>📝 Fichiers <span class="count">{(s.changes || []).length}</span></button>
      {#if (s.todos || []).length}
        <button class="subtab" class:active={tab === 'todos'} onclick={() => (tab = 'todos')}>✅ Tâches <span class="count">{(s.todos || []).length}</span></button>
      {/if}
      <button class="subtab" class:active={tab === 'subagents'} onclick={() => (tab = 'subagents')}>🤖 Sous-agents <span class="count">{(s.subagents || []).length}</span></button>
      <button class="subtab" class:active={tab === 'activity'} onclick={() => (tab = 'activity')}>🪝 Activité <span class="count">{events.length}</span></button>
    </div>
  </div>

  <div class="pane-body" bind:this={body}>
    <div class="pane" class:active={tab === 'chat'}>
      <div class="chat">
        {#if (s.messages || []).length}
          {#each s.messages as m, i (m.ts + ':' + i)}<ChatBubble {m} />{/each}
        {:else if !queued.length}
          <div class="pane-empty">Conversation vide.</div>
        {/if}
        {#each queued as q (q.ts)}
          <div class="bubble user queued">
            <div class="who">🧑 Toi <span class="t">⏳ en file d'attente</span></div>
            <div class="md">{q.text}</div>
          </div>
        {/each}
      </div>
      {#if s.pendingQuestion}<Question {id} pq={s.pendingQuestion} />{/if}
      {#if s.tmuxPane}
        <Composer bind:this={composer} {id} alive={s.tmuxAlive} project={s.project}
                  resumeModel={s.launchModel} resumeEffort={s.effort} lastPrompt={s.lastPrompt || ''} {onSent} />
      {/if}
    </div>

    <div class="pane" class:active={tab === 'changes'}>
      <div class="changes"><Changes changes={s.changes || []} /></div>
    </div>

    <div class="pane" class:active={tab === 'subagents'}>
      <div class="changes"><Subagents subagents={s.subagents || []} session={id} /></div>
    </div>

    <div class="pane" class:active={tab === 'todos'}>
      <Todos todos={s.todos || []} />
    </div>

    <div class="pane" class:active={tab === 'activity'}>
      <div class="timeline">
        {#if events.length}
          {#each events as e, i (e.ts + ':' + i)}
            <div class="ev">
              <b>{e.event}</b>{#if e.tool} <span class="tool">{e.tool}</span>{/if}{#if e.message} — {e.message.slice(0, 90)}{/if}<span class="t">{ago(e.ts)}</span>
            </div>
          {/each}
        {:else}
          <div class="empty">Pas d'évènement de hook.</div>
        {/if}
      </div>
    </div>
  </div>
{/if}
