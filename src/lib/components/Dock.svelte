<script>
  // Context dock (redesign): the always-visible right column of the Converse lens. Replaces
  // the Tasks / Subagents / Sub-sessions / Background / PRs / Issues subtabs: everything is
  // a live card, expandable in place (the full legacy component mounts on expand).
  import Subagents from './Subagents.svelte';
  import Workflows from './Workflows.svelte';
  import SubSessions from './SubSessions.svelte';
  import Background from './Background.svelte';
  import GhDetail from './GhDetail.svelte';
  import Screenshots from './Screenshots.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { fmtCost, prLabel, issueLabel } from '$lib/format.js';
  import { prState, prStateIcon } from '$lib/prState.svelte.js';
  import { ui } from '$lib/state.svelte.js';
  import { reply } from '$lib/api.js';

  let { s, id, onreview } = $props();

  // drag-resize the dock width (persisted). It's a right panel, so dragging left widens it.
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX, startW = width;
    const move = (ev) => {
      const w = startW - (ev.clientX - startX);
      if (ghOpen) ghWidth = Math.max(420, Math.min(1100, w));
      else ui.dockWidth = Math.max(220, Math.min(520, w));
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const todos = $derived(s?.todos || []);
  const todosDone = $derived(todos.filter((t) => t.status === 'completed').length);
  const todoCurrent = $derived(todos.find((t) => t.status === 'in_progress'));
  const changes = $derived(s?.changes || []);
  const subagents = $derived(s?.subagents || []);
  const workflows = $derived(s?.workflows || []);
  const wfRunning = $derived(workflows.filter((w) => w.status === 'running'));
  const agentCost = $derived(subagents.reduce((a, x) => a + (x.cost || 0), 0));
  const subSessions = $derived(s?.subSessions || []);
  // Background subagents are listed in the Agents card; here only the plain jobs (bash, monitor, wakeup).
  const jobs = $derived((s?.bgJobs || []).filter((j) => j.kind !== 'subagent'));
  const runningJobs = $derived(jobs.filter((j) => (j.status || 'running') === 'running'));
  const prLinks = $derived(s?.prLinks || []);
  const issueLinks = $derived(s?.issueLinks || []);
  const shots = $derived(s?.screenshots || []);

  // A PR / issue opened in place of the cards; the detail needs room, hence its own width.
  let ghOpen = $state(null);
  $effect(() => { id; ghOpen = null; });
  let ghWidth = $state(+globalThis.localStorage?.getItem('hooked.ghDetailWidth') || 640);
  $effect(() => { globalThis.localStorage?.setItem('hooked.ghDetailWidth', String(ghWidth)); });
  const width = $derived(ghOpen ? ghWidth : ui.dockWidth);
  const ghLinks = $derived([...prLinks, ...issueLinks]);
  const openGh = (e, url) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    ghOpen = url;
  };
  const fixCheck = async (c, d) => (await reply(id,
    `The CI check "${c.name}" fails on ${d.url}${c.url ? ` (logs: ${c.url})` : ''}. Investigate why and fix it.`)).ok;

  // per-file add/del totals when available on change entries; tolerate absent fields.
  const fileList = $derived(changes.slice(0, 4));

  let expanded = $state({}); // cardKey → bool
  const toggle = (k) => { expanded = { ...expanded, [k]: !expanded[k] }; };

  const JOB_ICON = { bash: 'bash', monitor: 'eye', wakeup: 'wakeup' };
  const TODO_ICON = { completed: 'checkbox-done', in_progress: 'in-progress', pending: 'checkbox' };
  // issue d'un run de workflow : un run tué ou en échec ne doit pas porter la coche verte.
  const WF_ICON = {
    running:   { icon: 'working',      tint: 'working' },
    completed: { icon: 'circle-check', tint: 'ended' },
    killed:    { icon: 'ban',          tint: 'waiting' },
    cancelled: { icon: 'ban',          tint: 'waiting' },
    timeout:   { icon: 'clock',        tint: 'waiting' },
    failed:    { icon: 'attention',    tint: 'attention' },
    error:     { icon: 'attention',    tint: 'attention' },
  };
</script>

<aside class="dock" aria-label="Session context" style="width:{width}px;min-width:{width}px">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="dock-resize" onpointerdown={startResize} title="Drag to resize"></div>
  <button class="dock-hide" onclick={() => (ui.dockHidden = true)} title="Hide the context panel" aria-label="Hide the context panel">»</button>
  {#if ghOpen}
    <nav class="ghnav" aria-label="Linked pull requests and issues">
      <button class="ghback" onclick={() => (ghOpen = null)} title="Back to the session context"><Icon name="arrow-left" size={13} /></button>
      {#each ghLinks as l (l)}
        <button class="ghtab" class:on={l === ghOpen} onclick={() => (ghOpen = l)} title={l}>
          <Icon name={l.includes('/pull/') ? prStateIcon(prState(l)) : 'issue'} size={12} tint={false} /> #{l.split('/').pop()}
        </button>
      {/each}
    </nav>
    <GhDetail url={ghOpen} onfix={fixCheck} />
  {:else}
  {#if todos.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('todos')}>
        <span class="dh-ico"><Icon name="tasks" size={13} /></span> Tasks
        <span class="dh-n">{todosDone}/{todos.length}</span>
        <span class="dh-chev" class:open={expanded.todos}>▾</span>
      </button>
      <div class="dprog"><i style="width:{todos.length ? Math.round((todosDone / todos.length) * 100) : 0}%"></i></div>
      {#if expanded.todos}
        <div class="db">
          {#each todos as t, i (i)}
            <div class="ditem" class:cur={t.status === 'in_progress'} class:done={t.status === 'completed'}><span class="dst"><Icon name={TODO_ICON[t.status] || 'checkbox'} size={13} /></span><span class="dtxt">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span></div>
          {/each}
        </div>
      {:else}
        <div class="db">
          {#if todoCurrent}
            <div class="ditem cur"><span class="dst"><Icon name="in-progress" size={13} /></span><span class="dtxt">{todoCurrent.activeForm || todoCurrent.content}</span></div>
          {/if}
          {#each todos.filter((t) => t.status === 'pending').slice(0, 3) as t}
            <div class="ditem"><span class="dst"><Icon name="checkbox" size={13} /></span><span class="dtxt">{t.content}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if changes.length}
    <div class="dcard">
      <button class="dh" onclick={() => onreview && onreview()} title="Open the Review lens">
        <span class="dh-ico"><Icon name="diff" size={13} /></span> Changes
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
          <button class="dmore" onclick={() => onreview && onreview()}>＋ {changes.length - fileList.length} more · open Review →</button>
        {/if}
      </div>
    </div>
  {/if}

  {#if workflows.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('workflows')}>
        <span class="dh-ico"><Icon name="workflow" size={13} color="var(--background)" /></span> Workflows
        <span class="dh-n">{wfRunning.length ? `${wfRunning.length} running` : workflows.length}</span>
        <span class="dh-chev" class:open={expanded.workflows}>▾</span>
      </button>
      {#if expanded.workflows}
        <div class="dfull"><Workflows {workflows} session={id} /></div>
      {:else}
        <div class="db">
          {#each workflows.slice(0, 3) as w}
            <div class="ditem" class:cur={w.status === 'running'}>
              <span class="dst"><Icon name={WF_ICON[w.status]?.icon || 'circle'} size={13} color="var(--{WF_ICON[w.status]?.tint || 'muted'})" title={w.status} /></span>
              <span class="dtxt mono">{w.name}</span>
              <span class="dnum">{w.doneCount}/{w.agentCount}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if subagents.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('agents')}>
        <span class="dh-ico"><Icon name="bot" size={13} /></span> Agents
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
        <span class="dh-ico"><Icon name="link" size={13} /></span> Sub-sessions
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
        <span class="dh-ico"><Icon name="background" size={13} color="var(--background)" /></span> Background
        <span class="dh-n">{runningJobs.length} running</span>
        <span class="dh-chev" class:open={expanded.jobs}>▾</span>
      </button>
      {#if expanded.jobs}
        <div class="dfull"><Background {jobs} session={id} /></div>
      {:else}
        <div class="db">
          {#each runningJobs.slice(0, 3) as j}
            <div class="ditem"><span class="dst"><Icon name={JOB_ICON[j.kind] || 'background'} size={13} color={JOB_ICON[j.kind] ? undefined : 'var(--background)'} /></span><span class="dtxt mono">{j.label || j.kind}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if prLinks.length || issueLinks.length}
    <div class="dcard">
      <button class="dh" onclick={() => (ghOpen = ghLinks[0])} title="Open the details">
        <span class="dh-ico"><Icon name="link" size={13} /></span> Links
        <span class="dh-n">{ghLinks.length}</span>
        <span class="dh-chev">›</span>
      </button>
      <div class="db dpills">
        {#each prLinks as l}{@const st = prState(l)}<a class="dpill pr" class:merged={st === 'MERGED'} class:closed={st === 'CLOSED'} href={l} target="_blank" rel="noopener" onclick={(e) => openGh(e, l)} title={st ? st.toLowerCase() : null}><Icon name={prStateIcon(st)} size={13} tint={false} /> {prLabel(l)}</a>{/each}
        {#each issueLinks as l}<a class="dpill" href={l} target="_blank" rel="noopener" onclick={(e) => openGh(e, l)}><Icon name="issue" size={13} /> {issueLabel(l)}</a>{/each}
      </div>
    </div>
  {/if}

  {#if shots.length}
    <div class="dcard">
      <button class="dh" onclick={() => toggle('shots')}>
        <span class="dh-ico"><Icon name="image" size={13} /></span> Screenshots
        <span class="dh-n">{shots.length}</span>
        <span class="dh-chev" class:open={expanded.shots}>▾</span>
      </button>
      <Screenshots {shots} session={id} limit={expanded.shots ? 0 : 4} />
    </div>
  {/if}
  {/if}
</aside>

<style>
  /* Side panels sans gap (anti-bulle) : sections affleurantes separees par des filets. */
  /* compteur d'agents d'un run, collé à droite de la ligne (le nom, lui, s'ellipse) */
  .dnum { margin-left: auto; flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
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
    background: var(--bg2); color: var(--muted); border-radius: 7px; cursor: pointer; font-size: var(--t-meta); line-height: 1;
    opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .dock:hover .dock-hide { opacity: 1; }
  .dock-hide:hover { background: var(--hover); color: var(--text); }
  @media (max-width: 1150px) { .dock { display: none; } }

  .dcard { border: none; border-radius: 0; background: transparent; border-bottom: 1px solid var(--border); overflow: hidden; flex: 0 0 auto; }
  .dh {
    display: flex; align-items: center; gap: 7px; width: 100%; padding: 10px 14px 7px;
    background: none; border: none; font: 750 var(--t-micro) var(--font); letter-spacing: .07em;
    text-transform: uppercase; color: var(--muted); cursor: pointer; text-align: left;
  }
  .dh:hover { color: var(--text); }
  .dh-ico { display: none; }
  .dh-n { margin-left: auto; font-size: var(--t-micro); color: var(--muted); font-weight: 600; letter-spacing: 0; text-transform: none; font-variant-numeric: tabular-nums; }
  .dh-chev { flex: 0 0 auto; color: var(--muted); font-size: var(--t-micro); transition: transform .12s; }
  .dh-chev.open { transform: rotate(180deg); }
  .dprog { height: 2px; background: var(--bg3); margin: 0 14px 6px; border-radius: 0; overflow: hidden; }
  .dprog i { display: block; height: 100%; background: var(--success); border-radius: 0; transition: width .3s; }
  .db { padding: 2px 14px 11px; font-size: var(--t-meta); }
  .ditem { display: flex; gap: 7px; padding: 2px 0; color: var(--muted); min-width: 0; }
  .ditem.cur { color: var(--text); }
  .ditem.cur .dst { color: var(--working); }
  .ditem.done .dtxt { text-decoration: line-through; }
  .ditem.done .dst { color: var(--success); }
  .dst { flex: 0 0 auto; }
  .dtxt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dtxt.mono { font-family: var(--mono); font-size: var(--t-micro); }
  .dfile { display: flex; align-items: center; gap: 7px; padding: 2px 0; font-family: var(--mono); font-size: var(--t-micro); min-width: 0; }
  .dpath { color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .dpm { margin-left: auto; flex: 0 0 auto; font-size: var(--t-micro); color: var(--muted); }
  .dmore {
    display: block; margin-top: 5px; background: none; border: none; padding: 0;
    font: inherit; font-family: var(--mono); font-size: var(--t-micro); color: var(--accent-d); cursor: pointer;
  }
  .dmore:hover { text-decoration: underline; }
  .dpills { display: flex; flex-wrap: wrap; gap: 5px; }
  .dpill {
    display: inline-flex; align-items: center; gap: 4px; text-decoration: none;
    font-family: var(--mono); font-size: var(--t-micro); font-weight: 600; color: var(--muted);
    background: transparent; border: 1px solid var(--border2); border-radius: 0; padding: 2px 7px;
  }
  .dpill.pr { color: var(--success); background: color-mix(in srgb, var(--success) 12%, transparent); }
  .dpill.pr.merged { color: var(--background); background: color-mix(in srgb, var(--background) 12%, transparent); }
  .dpill.pr.closed { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }
  .dpill:hover { filter: brightness(1.1); }
  /* the legacy components mounted on expand get a bounded, scrollable area */
  .ghnav { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 4px; padding: 8px 40px 8px 10px; background: var(--bg2); border-bottom: 1px solid var(--border); overflow-x: auto; flex: none; }
  .ghback, .ghtab { flex: none; display: inline-flex; align-items: center; gap: 4px; border: none; background: none; color: var(--muted); font: inherit; font-size: var(--t-meta); font-weight: 600; padding: 3px 8px; border-radius: 7px; cursor: pointer; }
  .ghback:hover, .ghtab:hover { color: var(--text); background: var(--bg3); }
  .ghtab.on { color: var(--text); background: var(--bg3); }
  .dfull { max-height: 46vh; overflow-y: auto; padding: 0 8px 8px; }
</style>
