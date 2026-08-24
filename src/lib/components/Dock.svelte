<script>
  // Context dock (redesign): the always-visible right column of the Converse lens. Replaces
  // the Tasks / Subagents / Sub-sessions / Background / PRs / Issues subtabs: everything is
  // a live card, expandable in place (the full legacy component mounts on expand).
  import Todos from './Todos.svelte';
  import Subagents from './Subagents.svelte';
  import SubSessions from './SubSessions.svelte';
  import Background from './Background.svelte';
  import PrLinks from './PrLinks.svelte';
  import IssueLinks from './IssueLinks.svelte';
  import { fmtCost, prLabel, issueLabel } from '$lib/format.js';
  import { ui } from '$lib/state.svelte.js';

  let { s, id, onship } = $props();

  // drag-resize the dock width (persisted). It's a right panel, so dragging left widens it.
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX, startW = ui.dockWidth;
    const move = (ev) => { ui.dockWidth = Math.max(220, Math.min(520, startW - (ev.clientX - startX))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const todos = $derived(s?.todos || []);
  const todosDone = $derived(todos.filter((t) => t.status === 'completed').length);
  const todoCurrent = $derived(todos.find((t) => t.status === 'in_progress'));
  const changes = $derived(s?.changes || []);
  const subagents = $derived(s?.subagents || []);
  const agentCost = $derived(subagents.reduce((a, x) => a + (x.cost || 0), 0));
  const subSessions = $derived(s?.subSessions || []);
  const jobs = $derived(s?.bgJobs || []);
  const runningJobs = $derived(jobs.filter((j) => (j.status || 'running') === 'running'));
  const prLinks = $derived(s?.prLinks || []);
  const issueLinks = $derived(s?.issueLinks || []);

  // per-file add/del totals when available on change entries; tolerate absent fields.
  const fileList = $derived(changes.slice(0, 4));

  let expanded = $state({}); // cardKey → bool
  const toggle = (k) => { expanded = { ...expanded, [k]: !expanded[k] }; };

  const JOB_ICON = { bash: '⚙️', monitor: '👁', wakeup: '⏰' };
</script>

<aside class="dock" aria-label="Session context" style="width:{ui.dockWidth}px;min-width:{ui.dockWidth}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dock-resize" onpointerdown={startResize} title="Drag to resize"></div>
  <button class="dock-hide" onclick={() => (ui.dockHidden = true)} title="Hide the context panel" aria-label="Hide the context panel">»</button>
  {#if todos.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('todos')}>
        <span class="dh-ico">✅</span> Tasks
        <span class="dh-n">{todosDone}/{todos.length}</span>
        <span class="dh-chev" class:open={expanded.todos}>▾</span>
      </button>
      <div class="dprog"><i style="width:{todos.length ? Math.round((todosDone / todos.length) * 100) : 0}%"></i></div>
      {#if expanded.todos}
        <div class="dfull"><Todos {todos} /></div>
      {:else}
        <div class="db">
          {#if todoCurrent}
            <div class="ditem cur"><span class="dst">▶</span><span class="dtxt">{todoCurrent.activeForm || todoCurrent.content}</span></div>
          {/if}
          {#each todos.filter((t) => t.status === 'pending').slice(0, 3) as t}
            <div class="ditem"><span class="dst">☐</span><span class="dtxt">{t.content}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if changes.length}
    <div class="dcard">
      <button class="dh" onclick={() => onship && onship()} title="Open the Ship lens">
        <span class="dh-ico">📝</span> Changes
        <span class="dh-n">{changes.length} file{changes.length > 1 ? 's' : ''}</span>
        <span class="dh-chev">→</span>
      </button>
      <div class="db">
        {#each fileList as c}
          <div class="dfile">
            <span class="dpath" title={c.file}>{c.name || c.file}</span>
            {#if (c.ops || []).length > 1}<span class="dpm">{c.ops.length} edits</span>{/if}
          </div>
        {/each}
        {#if changes.length > fileList.length}
          <button class="dmore" onclick={() => onship && onship()}>＋ {changes.length - fileList.length} more · open Ship →</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if subagents.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('agents')}>
        <span class="dh-ico">🤖</span> Agents
        <span class="dh-n">{subagents.length}{#if agentCost > 0} · {fmtCost(agentCost)}{/if}</span>
        <span class="dh-chev" class:open={expanded.agents}>▾</span>
      </button>
      {#if expanded.agents}
        <div class="dfull"><Subagents {subagents} session={id} /></div>
      {:else}
        <div class="db">
          {#each subagents.slice(0, 3) as a}
            <div class="ditem"><span class="dst">·</span><span class="dtxt">{a.type || 'agent'}{#if a.description} · {a.description}{/if}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if subSessions.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('subs')}>
        <span class="dh-ico">🔗</span> Sub-sessions
        <span class="dh-n">{subSessions.length}</span>
        <span class="dh-chev" class:open={expanded.subs}>▾</span>
      </button>
      {#if expanded.subs}
        <div class="dfull"><SubSessions {subSessions} /></div>
      {/if}
    </div>
  {/if}

  {#if jobs.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('jobs')}>
        <span class="dh-ico">🌀</span> Background
        <span class="dh-n">{runningJobs.length} running</span>
        <span class="dh-chev" class:open={expanded.jobs}>▾</span>
      </button>
      {#if expanded.jobs}
        <div class="dfull"><Background {jobs} session={id} /></div>
      {:else}
        <div class="db">
          {#each runningJobs.slice(0, 3) as j}
            <div class="ditem"><span class="dst">{JOB_ICON[j.kind] || '🌀'}</span><span class="dtxt mono">{j.label || j.kind}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if prLinks.length || issueLinks.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('links')}>
        <span class="dh-ico">🔗</span> Links
        <span class="dh-n">{prLinks.length + issueLinks.length}</span>
        <span class="dh-chev" class:open={expanded.links}>▾</span>
      </button>
      {#if expanded.links}
        <div class="dfull">
          {#if prLinks.length}<PrLinks {prLinks} />{/if}
          {#if issueLinks.length}<IssueLinks {issueLinks} />{/if}
        </div>
      {:else}
        <div class="db dpills">
          {#each prLinks as l}<a class="dpill pr" href={l} target="_blank" rel="noopener">🔀 {prLabel(l)}</a>{/each}
          {#each issueLinks as l}<a class="dpill" href={l} target="_blank" rel="noopener">🐛 {issueLabel(l)}</a>{/each}
        </div>
      {/if}
    </div>
  {/if}
</aside>

<style>
  /* Side panels sans gap (anti-bulle) : sections affleurantes separees par des filets. */
  .dock {
    position: relative; border-left: 1px solid var(--border); background: var(--bg2);
    overflow-y: auto; display: flex; flex-direction: column; gap: 0; padding: 0;
  }
  /* drag handle on the LEFT edge (right panel → drag left to widen) */
  .dock-resize { position: absolute; top: 0; left: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 3; }
  .dock-resize:hover { background: var(--accent); opacity: .5; }
  .dock-hide {
    position: absolute; top: 8px; right: 8px; z-index: 4; width: 22px; height: 22px; padding: 0;
    display: flex; align-items: center; justify-content: center; border: 1px solid var(--border2);
    background: var(--bg2); color: var(--muted); border-radius: 7px; cursor: pointer; font-size: 12px; line-height: 1;
    opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .dock:hover .dock-hide { opacity: 1; }
  .dock-hide:hover { background: var(--hover); color: var(--text); }
  @media (max-width: 1150px) { .dock { display: none; } }

  .dcard { border: none; border-radius: 0; background: transparent; border-bottom: 1px solid var(--border); overflow: hidden; flex: 0 0 auto; }
  .dh {
    display: flex; align-items: center; gap: 7px; width: 100%; padding: 10px 14px 7px;
    background: none; border: none; font: 600 10px var(--mono); letter-spacing: .09em;
    text-transform: uppercase; color: var(--muted); cursor: pointer; text-align: left;
  }
  .dh:hover { color: var(--text); }
  .dh-ico { display: none; }
  .dh-n { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); font-weight: 600; letter-spacing: 0; text-transform: none; }
  .dh-chev { flex: 0 0 auto; color: var(--muted); font-size: 11px; transition: transform .12s; }
  .dh-chev.open { transform: rotate(180deg); }
  .dprog { height: 2px; background: var(--bg3); margin: 0 14px 6px; border-radius: 0; overflow: hidden; }
  .dprog i { display: block; height: 100%; background: var(--success); border-radius: 0; transition: width .3s; }
  .db { padding: 2px 14px 11px; font-size: 11.5px; }
  .ditem { display: flex; gap: 7px; padding: 2px 0; color: var(--muted); min-width: 0; }
  .ditem.cur { color: var(--text); }
  .ditem.cur .dst { color: var(--working); }
  .dst { flex: 0 0 auto; }
  .dtxt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dtxt.mono { font-family: var(--mono); font-size: 10.5px; }
  .dfile { display: flex; align-items: center; gap: 7px; padding: 2px 0; font-family: var(--mono); font-size: 10.5px; min-width: 0; }
  .dpath { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .dpm { margin-left: auto; flex: 0 0 auto; font-size: 9.5px; color: var(--muted); }
  .dmore {
    display: block; margin-top: 5px; background: none; border: none; padding: 0;
    font: inherit; font-family: var(--mono); font-size: 10px; color: var(--accent-d); cursor: pointer;
  }
  .dmore:hover { text-decoration: underline; }
  .dpills { display: flex; flex-wrap: wrap; gap: 5px; }
  .dpill {
    display: inline-flex; align-items: center; gap: 4px; text-decoration: none;
    font-family: var(--mono); font-size: 10.5px; font-weight: 600; color: var(--muted);
    background: transparent; border: 1px solid var(--border2); border-radius: 0; padding: 2px 7px;
  }
  .dpill.pr { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
  .dpill:hover { filter: brightness(1.1); }
  /* the legacy components mounted on expand get a bounded, scrollable area */
  .dfull { max-height: 46vh; overflow-y: auto; padding: 0 8px 8px; }
</style>
