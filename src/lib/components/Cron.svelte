<script>
  import { getCronTasks, cronOp } from '$lib/api.js';
  import { data } from '$lib/state.svelte.js';
  import { nextRuns } from '$lib/cron.js';
  import { knownProjects } from '$lib/projects.js';
  import { fmtSpan, ago } from '$lib/format.js';
  import ModelEffort from './ModelEffort.svelte';
  import Icon from './Icon.svelte';

  const PRESETS = [
    ['Hourly', '0 * * * *'],
    ['Daily 9:00', '0 9 * * *'],
    ['Weekdays 9:00', '0 9 * * 1-5'],
    ['Mondays 9:00', '0 9 * * 1'],
  ];
  const EMPTY = { id: null, name: '', schedule: '0 9 * * 1-5', cwd: '', prompt: '', model: '', effort: '', permissionMode: 'default', ephemeral: false, enabled: true };

  let tasks = $state(null);
  let error = $state('');
  let selectedId = $state(null);
  let form = $state({ ...EMPTY });
  let busy = $state(false);
  let notice = $state('');
  let now = $state(Date.now());

  async function load() {
    try { tasks = (await getCronTasks()).tasks; error = ''; } catch (e) { error = e.message; }
    now = Date.now();
  }
  $effect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  });

  const selected = $derived(tasks?.find((t) => t.id === selectedId) || null);
  const projects = $derived(knownProjects(data.sessions).map(([cwd]) => cwd).sort());
  const preview = $derived.by(() => {
    try { return { runs: nextRuns(form.schedule, 3, now) }; } catch (e) { return { error: e.message }; }
  });

  function edit(t) {
    selectedId = t ? t.id : 'new';
    form = t
      ? { id: t.id, name: t.name, schedule: t.schedule, cwd: t.cwd, prompt: t.prompt, model: t.model || '', effort: t.effort || '', permissionMode: t.permissionMode, ephemeral: t.ephemeral, enabled: t.enabled }
      : { ...EMPTY };
    notice = '';
  }

  async function act(fn, done) {
    busy = true;
    notice = '';
    const r = await fn();
    busy = false;
    if (!r.ok) { notice = r.data?.error || 'HTTP ' + r.status; await load(); return; }
    await load();
    done?.(r.data);
  }

  const save = () => act(() => cronOp('save', { task: form }), (d) => { selectedId = d.task.id; form.id = d.task.id; notice = 'Saved.'; });
  const runNow = (id) => act(() => cronOp('run', { id }), () => { notice = 'Started.'; });
  const remove = (t) => confirm(`Delete "${t.name}"?`) && act(() => cronOp('delete', { id: t.id }), () => edit(null));
  const toggle = (t) => act(() => cronOp('save', { task: { ...t, enabled: !t.enabled } }), () => { if (selectedId === t.id) form.enabled = !t.enabled; });

  const when = (iso) => {
    const ms = Date.parse(iso) - now;
    return ms < 60000 ? 'in <1 min' : 'in ' + fmtSpan(ms);
  };
  const stamp = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const projectName = (cwd) => (cwd || '').split('/').pop();
  function status(t) {
    if (t.starting) return ['starting', 'warn'];
    if (t.lastSession?.waiting) return ['needs you', 'danger'];
    if (t.lastSession?.busy) return ['running', 'warn'];
    if (!t.enabled) return ['paused', 'muted'];
    return null;
  }
</script>

<div class="cr">
  <aside class="cr-list">
    <header class="cr-head">
      <h1>Cron <span class="count">{tasks ? tasks.length : ''}</span></h1>
      <button class="btn primary" onclick={() => edit(null)}><Icon name="plus" size={14} /> New task</button>
    </header>

    {#if error}
      <p class="empty">Could not load tasks: {error}</p>
    {:else if !tasks}
      <p class="empty">Loading…</p>
    {:else if !tasks.length}
      <p class="empty">No task yet. A task launches a session with its prompt on a schedule.</p>
    {:else}
      <ul>
        {#each tasks as t (t.id)}
          {@const s = status(t)}
          <li>
            <button class="item" class:on={selectedId === t.id} class:off={!t.enabled} onclick={() => edit(t)}>
              <span class="row">
                <span class="name">{t.name}</span>
                {#if s}<span class="badge st-{s[1]}">{s[0]}</span>{/if}
              </span>
              <span class="meta">
                <code>{t.schedule}</code>
                <span>{projectName(t.cwd)}</span>
                {#if t.nextRun}<span title={stamp(t.nextRun)}>{when(t.nextRun)}</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </aside>

  <section class="cr-detail">
    {#if !selectedId}
      <p class="empty">Pick a task, or create one.</p>
    {:else}
      <div class="form">
        <header class="d-head">
          <h2>{selected ? selected.name : 'New task'}</h2>
          {#if selected}
            <div class="actions">
              <label class="switch" title="Scheduled runs only; Run now always works">
                <input type="checkbox" checked={selected.enabled} disabled={busy} onchange={() => toggle(selected)} /> Enabled
              </label>
              <button class="btn" disabled={busy || selected.starting} onclick={() => runNow(selected.id)}>Run now</button>
              <button class="btn danger" disabled={busy} onclick={() => remove(selected)}>Delete</button>
            </div>
          {/if}
        </header>

        <label class="lf-label" for="cr-name">Name</label>
        <input id="cr-name" class="lf-input" placeholder="Defaults to the prompt's first line" bind:value={form.name} />

        <label class="lf-label" for="cr-sched">Schedule</label>
        <input id="cr-sched" class="lf-input mono" placeholder="minute hour day month weekday" bind:value={form.schedule} />
        <div class="presets">
          {#each PRESETS as [label, expr] (expr)}
            <button class="chip" class:on={form.schedule === expr} onclick={() => (form.schedule = expr)}>{label}</button>
          {/each}
        </div>
        {#if preview.error}
          <p class="hint err">{preview.error}</p>
        {:else if preview.runs.length}
          <p class="hint">Next: {preview.runs.map((d) => stamp(d.toISOString())).join(' · ')}</p>
        {:else}
          <p class="hint err">This schedule never fires.</p>
        {/if}

        <label class="lf-label" for="cr-cwd">Project</label>
        <input id="cr-cwd" class="lf-input mono" list="cr-projects" placeholder="/path/to/the/project" bind:value={form.cwd} />
        <datalist id="cr-projects">
          {#each projects as p (p)}<option value={p}></option>{/each}
        </datalist>

        <label class="lf-label" for="cr-prompt">Prompt</label>
        <textarea id="cr-prompt" class="lf-input" rows="7" placeholder="What the session should do on each run" bind:value={form.prompt}></textarea>

        <ModelEffort allowInherit showMode bind:model={form.model} bind:effort={form.effort} bind:mode={form.permissionMode} />

        <label class="check">
          <input type="checkbox" bind:checked={form.ephemeral} /> Ephemeral: the session archives itself once it is sure nothing is left for you
        </label>

        <p class="hint">Each run starts a new session tagged <code>cron</code> and closes the previous run if it is idle. A run that is still working or waiting on you makes the next one skip.</p>

        <div class="save">
          <button class="btn primary" disabled={busy || !!preview.error} onclick={save}>{selected ? 'Save' : 'Create task'}</button>
          {#if notice}<span class="notice">{notice}</span>{/if}
        </div>
      </div>

      {#if selected?.runs.length}
        <div class="runs">
          <h3>Recent runs</h3>
          <ul>
            {#each [...selected.runs].reverse() as r (r.at + (r.sessionId || '') + (r.error || r.skipped || ''))}
              <li>
                <span class="r-at" title={stamp(r.at)}>{ago(r.at, now)}</span>
                {#if r.manual}<span class="badge st-muted">manual</span>{/if}
                {#if r.error}<span class="r-err">{r.error}</span>
                {:else if r.skipped}<span class="r-skip">Skipped: {r.skipped}</span>
                {:else}<a href="/session/{encodeURIComponent(r.sessionId)}">Open session</a>{/if}
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </section>
</div>

<style>
  .cr { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(280px, 380px) 1fr; }
  .cr-list { min-height: 0; overflow-y: auto; border-right: 1px solid var(--border); background: var(--bg2); }
  .cr-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 18px 16px 12px; background: var(--bg2); border-bottom: 1px solid var(--border); }
  h1 { margin: 0; font-size: var(--t-head); line-height: var(--lh-head); letter-spacing: -.01em; }
  .count { color: var(--muted); font-size: var(--t-body); font-weight: 600; }

  ul { list-style: none; margin: 0; padding: 6px; }
  .item { width: 100%; display: flex; flex-direction: column; gap: 4px; padding: 9px 10px; border: none; border-radius: 8px; background: none; color: var(--text); text-align: left; cursor: pointer; }
  .item:hover { background: rgba(var(--ink-rgb), .05); }
  .item.on { background: color-mix(in srgb, var(--accent) 14%, transparent); }
  .item.off { opacity: .6; }
  .row { display: flex; align-items: center; gap: 8px; }
  .name { flex: 1; min-width: 0; font-weight: 600; font-size: var(--t-body); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--muted); font-size: var(--t-ui); }
  .meta code { font-family: var(--mono); }
  .badge { flex: none; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; background: var(--bg3); color: var(--muted); }
  .st-warn { color: var(--warn); }
  .st-danger { color: var(--danger); }

  .cr-detail { min-height: 0; overflow-y: auto; padding: 24px 32px 80px; }
  .form, .runs { max-width: 760px; }
  .d-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-bottom: 14px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: var(--t-title); overflow-wrap: anywhere; }
  .actions { display: flex; align-items: center; gap: 8px; }
  .switch { display: inline-flex; align-items: center; gap: 6px; font-size: var(--t-ui); font-weight: 600; color: var(--muted); cursor: pointer; }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .btn.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
  .mono { font-family: var(--mono); }
  .check { display: flex; align-items: center; gap: 8px; margin-top: 14px; font-size: var(--t-ui); color: var(--text); cursor: pointer; }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { padding: 4px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg); color: var(--muted); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .chip:hover { border-color: var(--border2); }
  .chip.on { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .hint { margin: 8px 0 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .hint.err { color: var(--danger); }
  .save { display: flex; align-items: center; gap: 12px; margin-top: 18px; }
  .notice { color: var(--muted); font-size: var(--t-ui); }

  .runs { margin-top: 28px; }
  h3 { margin: 0 0 6px; font-size: var(--t-meta); font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; }
  .runs ul { padding: 0; }
  .runs li { display: flex; align-items: center; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--border); font-size: var(--t-ui); }
  .r-at { min-width: 80px; color: var(--muted); }
  .r-err { color: var(--danger); overflow-wrap: anywhere; }
  .r-skip { color: var(--warn); }
  .empty { color: var(--muted); text-align: center; padding: 40px 16px; }

  @media (max-width: 760px) {
    .cr { grid-template-columns: 1fr; grid-template-rows: minmax(0, 40%) 1fr; }
    .cr-list { border-right: none; border-bottom: 1px solid var(--border); }
    .cr-detail { padding: 18px 16px 60px; }
  }
</style>
