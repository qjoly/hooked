<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { ui, data, loadSessions } from '../lib/state.svelte.js';
  import { getSession, kill } from '../lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, fmtDuration, ago, shortModel, prLabel } from '../lib/format.js';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Composer from './Composer.svelte';
  import Changes from './Changes.svelte';
  import Subagents from './Subagents.svelte';

  let { id } = $props();
  let s = $state(null);          // détail de session
  let tab = $state('chat');
  let body;                      // ref .pane-body (conteneur scrollable)
  let composer;                  // ref Composer (pour déclencher interruption + édition via Échap)
  let lastActivity = null;
  let stopping = $state(false);
  let attachCopied = $state(false);
  // messages envoyés en attente d'apparaître dans le transcript (file d'attente, comme le CLI).
  let queued = $state([]);
  let forceBottom = false;          // force le scroll en bas au prochain rendu (envoi d'un message)

  const events = $derived(s ? (s.events || []).slice().reverse() : []);

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
    ui.modal = { type: 'resume', data: { id: s.id, project: s.project, projectName: s.projectName, title: s.title } };
  }
  async function stop() {
    if (!confirm('Stopper cette session ? Le pane tmux où tourne Claude sera fermé.')) return;
    stopping = true;
    const res = await kill(s.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) { setTimeout(() => { loadSessions(); ui.tick++; }, 800); }
    else { stopping = false; alert('✗ ' + (res.data.error || 'échec')); }
  }
  async function copyAttach() {
    try { await navigator.clipboard.writeText(s.tmuxAttach); attachCopied = true; setTimeout(() => (attachCopied = false), 1500); } catch (_) {}
  }
</script>

{#if s}
  <div class="pane-head s-{s.state}">
    <div class="card-top" style="cursor:default;margin-bottom:6px">
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
    <h2 style="margin:0">{s.title}</h2>
    <div class="head-meta">
      {#if s.rateLimit && s.rateLimit.fiveHour && s.rateLimit.fiveHour.pct != null}
        {@const rl = s.rateLimit.fiveHour}
        <div class="usage-bar" class:warn={rl.pct >= 70} class:full={rl.pct >= 90}
             title="Rate limit de la session de 5 h (compte) — valeur réelle remontée par la statusline Claude Code">
          <div class="usage-top"><span class="usage-label">⏳ Session 5 h</span><span class="usage-pct">{rl.pct}%</span></div>
          <div class="usage-track"><div class="usage-fill" style="width:{rl.pct}%"></div></div>
          {#if rl.resetInMin != null}<div class="usage-sub">réinitialise dans {fmtDuration(rl.resetInMin)}</div>{/if}
        </div>
      {:else if s.usage5h}
        {@const u = s.usage5h}
        <div class="usage-bar" class:warn={u.pct >= 75} class:full={u.pct >= 95}
             title={`Estimation (pas de statusline) : ${fmtCost(u.cost)} de coût sur un budget de ${fmtCost(u.budget)} sur 5 h. Ajustable via HOOKED_SESSION_BUDGET.`}>
          <div class="usage-top"><span class="usage-label">⏳ Session 5 h <span class="usage-est">(est.)</span></span><span class="usage-pct">{u.pct}%</span></div>
          <div class="usage-track"><div class="usage-fill" style="width:{u.pct}%"></div></div>
          <div class="usage-sub">{fmtCost(u.cost)} · {fmtTokens(u.output)} tk{#if u.resetInMin != null} · réinitialise dans {fmtDuration(u.resetInMin)}{/if}</div>
        </div>
      {/if}
    </div>
    {#if s.prLinks && s.prLinks.length}
      <div class="pr-links">
        {#each s.prLinks as l}
          <a class="pr-link" href={l} target="_blank" rel="noopener" title={l}><span class="pr-ico">🔗</span>{prLabel(l)}</a>
        {/each}
      </div>
    {/if}
    <div class="detail-grid" style="margin:14px 0 0">
      <div><div class="v">{fmtCost(s.cost)}</div><div class="l">coût estimé</div></div>
      {#if s.subagentCost > 0}<div><div class="v">{fmtCost(s.subagentCost)}</div><div class="l">dont sous-agents</div></div>{/if}
      <div><div class="v">{s.userPrompts}</div><div class="l">prompts</div></div>
      <div><div class="v">{fmtTokens(s.usage.output)}</div><div class="l">tokens out</div></div>
      <div><div class="v">{fmtTokens(s.usage.cacheRead)}</div><div class="l">cache lu</div></div>
      <div><div class="v">{shortModel(s.model)}</div><div class="l">modèle</div></div>
    </div>
    <div class="subtabs">
      <button class="subtab" class:active={tab === 'chat'} onclick={() => (tab = 'chat')}>💬 Conversation <span class="count">{(s.messages || []).length}</span></button>
      <button class="subtab" class:active={tab === 'changes'} onclick={() => (tab = 'changes')}>📝 Fichiers <span class="count">{(s.changes || []).length}</span></button>
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
