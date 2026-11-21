<script>
  // Flows: pipelines of driven sessions (server/flows.js). Left: runs and templates. Right: the run
  // as a CI-style graph with the selected stage's report, the new-run form, or the template editor.
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { getFlows, flowOp } from '#lib/api.js';
  import { data } from '#lib/state.svelte.js';
  import { knownProjects } from '#lib/projects.js';
  import { ago } from '#lib/format.js';
  import { cleanFlow, validateFlow, runBadge } from '#lib/flows.js';
  import FlowGraph from './FlowGraph.svelte';
  import ModelEffort from './ModelEffort.svelte';
  import Markdown from './Markdown.svelte';
  import Icon from './Icon.svelte';

  let flows = $state(null);
  let error = $state('');
  let busy = $state(false);
  let notice = $state('');
  let now = $state(Date.now());
  let selStage = $state(null);
  let note = $state('');

  async function load() {
    try { flows = await getFlows(); error = ''; } catch (e) { error = e.message; }
    now = Date.now();
  }
  $effect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  });

  const q = $derived(page.url.searchParams);
  const view = $derived(q.get('run') ? 'run' : q.get('tpl') ? 'tpl' : q.get('new') ? 'new' : null);
  const run = $derived(view === 'run' ? flows?.runs.find((r) => r.id === q.get('run')) || null : null);
  const go = (params) => goto('/flows' + (params ? '?' + new URLSearchParams(params) : ''), { replaceState: true, keepFocus: true, noScroll: true });
  const projects = $derived(knownProjects(data.sessions).map(([cwd]) => cwd).sort());

  async function act(op, extra, done) {
    busy = true;
    notice = '';
    const r = await flowOp(op, extra);
    busy = false;
    if (!r.ok) { notice = r.data?.error || 'HTTP ' + r.status; return; }
    await load();
    done?.(r.data);
  }

  // ── New run ──
  let nr = $state({ templateId: 'feature', cwd: '', task: '', name: '', worktree: true, base: '' });
  const nrTemplate = $derived(flows?.templates.find((t) => t.id === nr.templateId) || null);
  // The worktree box follows the template's default when the template changes, not on every poll.
  let nrSeen = null;
  $effect(() => {
    const t = nrTemplate;
    if (t && t.id !== nrSeen) { nrSeen = t.id; nr.worktree = t.worktree; }
  });
  const startRun = () => act('start', { ...nr, base: nr.base || undefined }, (d) => { nr.task = ''; nr.name = ''; go({ run: d.run.id }); });

  // ── Template editor ──
  let tpl = $state(null);
  let tplFor = $state(null);
  $effect(() => {
    if (view !== 'tpl' || !flows) return;
    const id = q.get('tpl');
    if (tplFor === id) return;
    tplFor = id;
    const src = id === 'new'
      ? { id: null, name: 'New flow', description: '', maxLoops: 3, worktree: true, stages: [{ key: 'work', name: 'Work', role: '', after: [] }] }
      : flows.templates.find((t) => t.id === id);
    tpl = src ? toForm(src) : null;
  });
  const toForm = (t) => ({
    ...JSON.parse(JSON.stringify(t)),
    stages: t.stages.map((s) => ({ ...s, model: s.model || '', effort: s.effort || '', permissionMode: s.permissionMode || 'default', loopTo: s.loopTo || '' })),
  });
  const tplCheck = $derived.by(() => {
    if (!tpl) return { flow: null, error: null };
    const flow = cleanFlow(tpl);
    try { validateFlow(flow); return { flow, error: null }; } catch (e) { return { flow, error: e.message }; }
  });
  function addStage() {
    const keys = new Set(tpl.stages.map((s) => s.key));
    let n = tpl.stages.length + 1;
    while (keys.has('stage-' + n)) n++;
    const last = tpl.stages.filter((s) => !s.decider).at(-1);
    tpl.stages.push({ key: 'stage-' + n, name: 'Stage ' + n, role: '', after: last ? [last.key] : [], decider: false, loopTo: '', writes: false, model: '', effort: '', permissionMode: 'default' });
  }
  function removeStage(i) {
    const k = tpl.stages[i].key;
    tpl.stages.splice(i, 1);
    for (const s of tpl.stages) { s.after = s.after.filter((a) => a !== k); if (s.loopTo === k) s.loopTo = ''; }
  }
  function renameKey(s, v) {
    const old = s.key;
    s.key = v;
    for (const o of tpl.stages) { o.after = o.after.map((a) => (a === old ? v : a)); if (o.loopTo === old) o.loopTo = v; }
  }
  const toggleAfter = (s, k) => { s.after = s.after.includes(k) ? s.after.filter((a) => a !== k) : [...s.after, k]; };
  const saveTpl = () => act('saveTemplate', { template: tplCheck.flow }, (d) => { tplFor = d.template.id; go({ tpl: d.template.id }); notice = 'Saved.'; });
  const deleteTpl = (t) => confirm(t.builtIn ? 'Restore the built-in template?' : `Delete "${t.name}"?`)
    && act('deleteTemplate', { id: t.id }, () => { tplFor = null; go(null); });
  const duplicateTpl = () => { tpl = { ...toForm(tplCheck.flow), id: null, name: tpl.name + ' (copy)' }; tplFor = 'new'; goto('/flows?tpl=new', { replaceState: true }); };

  // ── Run view ──
  $effect(() => { if (run && selStage && !run.flow.stages.some((s) => s.key === selStage)) selStage = null; });
  const stageDef = $derived(run && selStage ? run.flow.stages.find((s) => s.key === selStage) : null);
  const stageSt = $derived(run && selStage ? run.stages[selStage] : null);
  const stageHistory = $derived(run && selStage ? (run.history || []).filter((h) => h.stage === selStage).reverse() : []);
  const decider = $derived(run?.flow.stages.find((s) => s.decider) || null);
  const hasPending = $derived(run ? Object.values(run.stages).some((s) => s.status !== 'done') : false);
  const runAct = (op, extra = {}) => act(op, { id: run.id, ...extra }, () => { note = ''; });

  const projectName = (cwd) => (cwd || '').split('/').pop();
  const stageDots = (r) => r.flow.stages.map((s) => r.stages[s.key]?.status || 'pending');
</script>

<div class="fl">
  <aside class="fl-list">
    <header class="fl-head">
      <h1>Flows</h1>
      <button class="btn primary" onclick={() => go({ new: 1 })}><Icon name="plus" size={14} /> New run</button>
    </header>
    {#if error}
      <p class="empty">Could not load flows: {error}</p>
    {:else if !flows}
      <p class="empty">Loading…</p>
    {:else}
      <h3>Runs</h3>
      {#if !flows.runs.length}
        <p class="empty small">No run yet. A run chains one session per stage, like a CI pipeline.</p>
      {/if}
      <ul>
        {#each flows.runs as r (r.id)}
          {@const b = runBadge(r)}
          <li>
            <button class="item" class:on={run?.id === r.id} onclick={() => { selStage = null; go({ run: r.id }); }}>
              <span class="row"><span class="name">{r.name}</span><span class="badge st-{b[1]}">{b[0]}</span></span>
              <span class="meta">
                <span class="dots">{#each stageDots(r) as d, i (i)}<i class="dot d-{d}"></i>{/each}</span>
                <span>{projectName(r.project)}</span>
                {#if r.iteration > 1}<span>pass {r.iteration}</span>{/if}
                <span>{ago(r.updatedAt, now)}</span>
              </span>
            </button>
          </li>
        {/each}
      </ul>
      <h3 class="tpl-h">Templates <button class="link" onclick={() => { tplFor = null; go({ tpl: 'new' }); }}>+ new</button></h3>
      <ul>
        {#each flows.templates as t (t.id)}
          <li>
            <button class="item" class:on={view === 'tpl' && q.get('tpl') === t.id} onclick={() => go({ tpl: t.id })}>
              <span class="row"><span class="name">{t.name}</span>{#if t.builtIn}<span class="badge">built-in</span>{/if}</span>
              <span class="meta"><span>{t.stages.map((s) => s.name).join(' → ')}</span></span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section class="fl-detail">
    {#if !flows}
      <p class="empty">…</p>
    {:else if view === 'run' && !run}
      <p class="empty">Run not found.</p>
    {:else if run}
      {@const b = runBadge(run)}
      <header class="d-head">
        <div>
          <h2>{run.name} <span class="badge st-{b[1]}">{b[0]}</span></h2>
          <p class="sub">
            {run.flow.name} · pass {run.iteration}{decider ? ` of ${run.flow.maxLoops + 1} max` : ''} ·
            <code>{run.cwd}</code>{#if run.worktree} (worktree of {projectName(run.project)}){/if}
          </p>
        </div>
        <div class="actions">
          {#if run.status === 'running'}
            <button class="btn danger" disabled={busy} onclick={() => runAct('stop')}><Icon name="stop" size={14} /> Stop</button>
          {:else if run.status === 'done' || run.status === 'stopped'}
            {#if run.status === 'stopped' && hasPending}<button class="btn" disabled={busy} onclick={() => runAct('continue')}>Resume</button>{/if}
            <button class="btn danger" disabled={busy} onclick={() => confirm('Delete this run? Its sessions are kept.') && act('delete', { id: run.id }, () => go(null))}>Delete</button>
          {/if}
        </div>
      </header>

      {#if run.status === 'needs-you'}
        <div class="banner">
          <p><Icon name="attention" size={15} /> {run.note || 'The flow is waiting on you.'}</p>
          <textarea class="lf-input" rows="2" placeholder="Optional instructions for the next pass" bind:value={note}></textarea>
          <div class="row-btns">
            {#if hasPending}<button class="btn primary" disabled={busy} onclick={() => runAct('continue')}>Continue</button>{/if}
            {#if decider}<button class="btn" disabled={busy} onclick={() => runAct('rerun', { stage: decider.loopTo, loop: true, note })}><Icon name="rotate-cw" size={14} /> Loop again</button>{/if}
            <button class="btn" disabled={busy} onclick={() => runAct('finish')}><Icon name="check" size={14} /> Close run</button>
          </div>
        </div>
      {/if}
      {#if notice}<p class="notice">{notice}</p>{/if}

      <div class="graph"><FlowGraph flow={run.flow} stages={run.stages} iteration={run.iteration} selected={selStage} onselect={(k) => (selStage = selStage === k ? null : k)} /></div>

      {#if stageDef && stageSt}
        <div class="stage">
          <header class="s-head">
            <h3>{stageDef.name} <code>{stageDef.key}</code></h3>
            <div class="actions">
              {#if stageSt.sessionId}<a class="btn" href="/session/{encodeURIComponent(stageSt.sessionId)}"><Icon name="converse" size={14} /> Open session</a>{/if}
              {#if stageSt.status !== 'done' && stageSt.sessionId}
                <button class="btn" disabled={busy} onclick={() => runAct('markDone', { stage: stageDef.key })} title="Use the session's last message as its report">Mark done</button>
              {/if}
              {#if stageSt.status === 'done' || stageSt.status === 'stalled' || stageSt.status === 'lost'}
                <button class="btn" disabled={busy} onclick={() => runAct('rerun', { stage: stageDef.key, note })}>Re-run from here</button>
              {/if}
            </div>
          </header>
          {#if stageSt.status !== 'done' && stageSt.sessionId}
            <p class="hint">Talk to the stage in its session; it moves on once it calls <code>flow_report</code>. <b>Mark done</b> takes its last message as the report.</p>
          {/if}
          {#if stageHistory.length}
            {#each stageHistory as h (h.at)}
              <div class="report">
                <p class="r-meta">
                  pass {h.iteration}{#if h.verdict} · <b class="v-{h.verdict}">{h.verdict}</b>{/if}{#if h.byUser} · marked by you{/if} · {ago(h.at, now)}
                </p>
                <Markdown text={h.summary} />
              </div>
            {/each}
          {:else}
            <p class="hint">No report yet.</p>
          {/if}
          <details class="role"><summary>Role</summary><p>{stageDef.role}</p></details>
        </div>
      {:else}
        <p class="hint">Click a stage to see its reports and open its session.</p>
      {/if}

      <details class="task"><summary>Task</summary><Markdown text={run.task} /></details>
      <details class="log">
        <summary>Log</summary>
        <ul>{#each [...(run.log || [])].reverse() as l, i (i)}<li><span class="r-at">{ago(l.at, now)}</span> {l.text}</li>{/each}</ul>
      </details>

    {:else if view === 'new'}
      <div class="form">
        <header class="d-head"><h2>New flow run</h2></header>
        <label class="lf-label" for="fl-tpl">Template</label>
        <select id="fl-tpl" class="lf-input" bind:value={nr.templateId}>
          {#each flows.templates as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
        </select>
        {#if nrTemplate}
          <p class="hint">{nrTemplate.description}</p>
          <div class="graph"><FlowGraph flow={nrTemplate} /></div>
        {/if}
        <label class="lf-label" for="fl-cwd">Project</label>
        <input id="fl-cwd" class="lf-input mono" list="fl-projects" placeholder="/path/to/the/project" bind:value={nr.cwd} />
        <datalist id="fl-projects">{#each projects as p (p)}<option value={p}></option>{/each}</datalist>
        <label class="lf-label" for="fl-task">Task</label>
        <textarea id="fl-task" class="lf-input" rows="8" placeholder="What the flow should achieve. Every stage receives it." bind:value={nr.task}></textarea>
        <label class="lf-label" for="fl-name">Name</label>
        <input id="fl-name" class="lf-input" placeholder="Defaults to the task's first line" bind:value={nr.name} />
        <label class="check"><input type="checkbox" bind:checked={nr.worktree} /> Run in a new git worktree shared by every stage</label>
        {#if nr.worktree}
          <input class="lf-input mono" placeholder="Base branch (default: the repository's default branch)" bind:value={nr.base} />
        {/if}
        <div class="save">
          <button class="btn primary" disabled={busy || !nr.cwd || !nr.task.trim()} onclick={startRun}>Start</button>
          {#if notice}<span class="notice">{notice}</span>{/if}
        </div>
      </div>

    {:else if view === 'tpl' && tpl}
      {@const stored = flows.templates.find((t) => t.id === tpl.id)}
      <div class="form wide">
        <header class="d-head">
          <h2>{tpl.id ? 'Edit template' : 'New template'}</h2>
          <div class="actions">
            {#if tpl.id}<button class="btn" onclick={duplicateTpl}>Duplicate</button>{/if}
            {#if stored && !stored.builtIn}<button class="btn danger" disabled={busy} onclick={() => deleteTpl(stored)}>Delete</button>{/if}
          </div>
        </header>
        <label class="lf-label" for="ft-name">Name</label>
        <input id="ft-name" class="lf-input" bind:value={tpl.name} />
        <label class="lf-label" for="ft-desc">Description</label>
        <input id="ft-desc" class="lf-input" bind:value={tpl.description} />
        <div class="inline">
          <label>Max loops <input class="lf-input num" type="number" min="0" max="20" bind:value={tpl.maxLoops} /></label>
          <label class="check"><input type="checkbox" bind:checked={tpl.worktree} /> Worktree by default</label>
        </div>

        <div class="graph">{#if tplCheck.flow}<FlowGraph flow={tplCheck.flow} />{/if}</div>
        {#if tplCheck.error}<p class="hint err">{tplCheck.error}</p>{/if}

        {#each tpl.stages as s, i (i)}
          <fieldset class="st-edit">
            <div class="inline">
              <label>Key <input class="lf-input mono" value={s.key} oninput={(e) => renameKey(s, e.currentTarget.value)} /></label>
              <label>Name <input class="lf-input" bind:value={s.name} /></label>
              <button class="btn danger" onclick={() => removeStage(i)} disabled={tpl.stages.length < 2}><Icon name="trash" size={14} /></button>
            </div>
            <div class="after">
              <span>Runs after:</span>
              {#each tpl.stages.filter((o) => o.key !== s.key) as o (o.key)}
                <button class="chip" class:on={s.after.includes(o.key)} onclick={() => toggleAfter(s, o.key)}>{o.name || o.key}</button>
              {/each}
            </div>
            <textarea class="lf-input" rows="4" placeholder="Role: what this stage does" bind:value={s.role}></textarea>
            <ModelEffort allowInherit showMode bind:model={s.model} bind:effort={s.effort} bind:mode={s.permissionMode} />
            <div class="inline">
              <label class="check"><input type="checkbox" bind:checked={s.writes} /> Writer (edits the code)</label>
              <label class="check"><input type="checkbox" bind:checked={s.decider} /> Decider</label>
              {#if s.decider}
                <label>Loops back to
                  <select class="lf-input" bind:value={s.loopTo}>
                    <option value="">—</option>
                    {#each tpl.stages.filter((o) => o.key !== s.key) as o (o.key)}<option value={o.key}>{o.name || o.key}</option>{/each}
                  </select>
                </label>
              {/if}
            </div>
          </fieldset>
        {/each}
        <button class="btn" onclick={addStage}><Icon name="plus" size={14} /> Add stage</button>
        <p class="hint">Every stage is its own session. It receives the task, its role, and the reports of the stages before it, and reports back with the <code>flow_report</code> MCP tool. The decider answers <code>done</code>, <code>loop</code> or <code>escalate</code>.</p>
        <div class="save">
          <button class="btn primary" disabled={busy || !!tplCheck.error} onclick={saveTpl}>Save</button>
          {#if notice}<span class="notice">{notice}</span>{/if}
        </div>
      </div>
    {:else}
      <p class="empty">Pick a run or a template, or start a new run.</p>
    {/if}
  </section>
</div>

<style>
  .fl { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(280px, 360px) 1fr; }
  .fl-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg2); }
  .fl-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 18px 16px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: var(--t-head); line-height: var(--lh-head); letter-spacing: -.01em; }
  h3 { margin: 14px 16px 2px; font-size: var(--t-meta); font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; display: flex; align-items: center; justify-content: space-between; }
  .link { border: none; background: none; color: var(--accent); font-weight: 600; cursor: pointer; text-transform: none; letter-spacing: 0; }
  ul { list-style: none; margin: 0; padding: 6px; }
  .item { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: none; border-radius: 8px; background: none; color: var(--text); text-align: left; cursor: pointer; }
  .item:hover { background: rgba(var(--ink-rgb), .05); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .row { display: flex; align-items: center; gap: 8px; }
  .name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; color: var(--muted); font-size: var(--t-ui); }
  .dots { display: inline-flex; gap: 3px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border2); }
  .d-done { background: var(--success); }
  .d-running, .d-starting { background: var(--warn); }
  .d-stalled, .d-lost { background: var(--danger); }
  .badge { flex: none; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--bg3); color: var(--muted); vertical-align: middle; }
  .st-warn { color: var(--warn); } .st-danger { color: var(--danger); } .st-success { color: var(--success); }

  .fl-detail { min-height: 0; overflow-y: auto; padding: 24px 32px 80px; }
  .form { max-width: 760px; }
  .form.wide { max-width: 980px; }
  .d-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: var(--t-title); overflow-wrap: anywhere; }
  .sub { margin: 6px 0 0; color: var(--muted); font-size: var(--t-ui); }
  .sub code, code { font-family: var(--mono); }
  .actions, .row-btns { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; text-decoration: none; }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
  .graph { overflow-x: auto; padding: 18px 0; }
  .banner { margin-top: 14px; padding: 12px 14px; border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border)); border-radius: 10px; background: color-mix(in srgb, var(--danger) 7%, transparent); display: flex; flex-direction: column; gap: 10px; }
  .banner p { margin: 0; display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .stage { border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; background: var(--bg2); }
  .s-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .s-head h3 { margin: 0; text-transform: none; letter-spacing: 0; font-size: var(--t-body); color: var(--text); gap: 8px; }
  .report { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border); }
  .r-meta { margin: 0 0 6px; color: var(--muted); font-size: var(--t-ui); }
  .v-done { color: var(--success); } .v-loop { color: var(--accent); } .v-escalate { color: var(--danger); }
  .role, .task, .log { margin-top: 14px; font-size: var(--t-ui); }
  .role p { white-space: pre-wrap; color: var(--muted); }
  summary { cursor: pointer; font-weight: 600; color: var(--muted); }
  .log ul { padding: 6px 0; }
  .log li { padding: 3px 0; }
  .r-at { display: inline-block; min-width: 90px; color: var(--muted); }
  .mono { font-family: var(--mono); }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: var(--t-ui); color: var(--text); cursor: pointer; }
  .inline { display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
  .inline label { display: flex; flex-direction: column; gap: 4px; font-size: var(--t-ui); color: var(--muted); }
  .inline .check { flex-direction: row; margin-top: 0; }
  .num { width: 80px; }
  .st-edit { margin: 14px 0; padding: 12px 14px; border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 10px; }
  .after { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: var(--t-ui); color: var(--muted); }
  .chip { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--muted); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .chip.on { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .hint.err { color: var(--danger); }
  .save { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  .notice { color: var(--muted); font-size: var(--t-ui); }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }
  .empty.small { padding: 10px 16px; font-size: var(--t-ui); text-align: left; }

  @media (max-width: 760px) {
    .fl { grid-template-columns: 1fr; grid-template-rows: minmax(0, 40%) 1fr; }
    .fl-list { border-right: none; border-bottom: 1px solid var(--border); }
    .fl-detail { padding: 18px 16px 60px; }
  }
</style>
