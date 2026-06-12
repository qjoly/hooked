<script>
  import { onMount, tick, untrack } from 'svelte';
  import { ui, data, loadSessions } from '../lib/state.svelte.js';
  import { getSession, kill } from '../lib/api.js';
  import { STATE_LABEL, fmtCost, fmtTokens, ago, shortModel, prLabel } from '../lib/format.js';
  import ChatBubble from './ChatBubble.svelte';
  import Question from './Question.svelte';
  import Composer from './Composer.svelte';
  import Changes from './Changes.svelte';
  import Subagents from './Subagents.svelte';

  let { id } = $props();
  let s = $state(null);          // détail de session
  let tab = $state('chat');
  let body;                      // ref .pane-body (conteneur scrollable)
  let lastActivity = null;
  let stopping = $state(false);
  let attachCopied = $state(false);

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
    await tick();
    if (body) body.scrollTop = (isRefresh && !wasAtBottom && prevScroll != null) ? prevScroll : body.scrollHeight;
  }

  onMount(() => load(false));

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
      {#if s.tmuxPane}
        <span class="ro-tag live">↩ réponse possible</span>
        <button class="stop-btn" disabled={stopping} onclick={stop}>{stopping ? '⏳ arrêt…' : '⏹ Stopper'}</button>
        {#if s.tmuxAttach}
          <button class="attach-btn" title={s.tmuxAttach} onclick={copyAttach}>{attachCopied ? '✓ copié' : '⧉ Copier attach'}</button>
        {/if}
      {:else}
        <span class="ro-tag">lecture seule</span>
        <button class="resume-btn" onclick={resume}>▶ Reprendre dans tmux</button>
      {/if}
      <span class="badge s-badge" style="margin-left:auto">{STATE_LABEL[s.state] || s.state}</span>
    </div>
    <h2 style="margin:0">{s.title}</h2>
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
      <div><div class="v">{s.assistantTurns}</div><div class="l">tours</div></div>
      <div><div class="v">{s.userPrompts}</div><div class="l">prompts</div></div>
      <div><div class="v">{fmtTokens(s.usage.output)}</div><div class="l">tokens out</div></div>
      <div><div class="v">{fmtTokens(s.usage.cacheRead)}</div><div class="l">cache lu</div></div>
      <div><div class="v">{shortModel(s.model)}</div><div class="l">modèle</div></div>
      {#if s.effort}<div><div class="v">{s.effort}</div><div class="l">effort</div></div>{/if}
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
        {:else}
          <div class="pane-empty">Conversation vide.</div>
        {/if}
      </div>
      {#if s.pendingQuestion}<Question {id} pq={s.pendingQuestion} />{/if}
      {#if s.tmuxPane}<Composer {id} />{/if}
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
