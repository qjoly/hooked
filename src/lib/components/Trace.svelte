<script>
  import { untrack } from 'svelte';
  import { getTrace, getTraceTool } from '$lib/api.js';
  import { tagColor } from '$lib/format.js';
  import Icon from './Icon.svelte';

  // `version` changes whenever the transcript grows; the trace only refetches while visible.
  let { id, version = 0, active = false } = $props();

  const TURN_WINDOW = 20;
  let res = $state(null);
  let loading = $state(false);
  let filter = $state('');
  let open = $state(null);        // tool_use_id of the expanded span
  let details = $state({});       // tool_use_id -> { input, result, error } | { failed }
  let shown = $state(TURN_WINDOW);

  async function load(sid) {
    loading = true;
    try { res = await getTrace(sid); } catch (_) { res = { turns: [], error: 'request failed' }; }
    finally { loading = false; }
  }

  $effect(() => { id; untrack(() => { res = null; open = null; details = {}; shown = TURN_WINDOW; }); });
  $effect(() => {
    const sid = id, on = active; version;  // tracked deps read BEFORE the guard (Svelte 5 trap)
    if (on) untrack(() => load(sid));
  });

  async function toggle(span) {
    if (open === span.id) { open = null; return; }
    open = span.id;
    if (details[span.id]) return;
    try { details = { ...details, [span.id]: await getTraceTool(id, span.id) }; }
    catch (_) { details = { ...details, [span.id]: { failed: true } }; }
  }

  const fmtMs = (d) => d == null ? '—'
    : d < 1000 ? `${d} ms`
    : d < 60000 ? `${(d / 1000).toFixed(1)} s`
    : `${Math.floor(d / 60000)}m ${String(Math.round((d % 60000) / 1000)).padStart(2, '0')}s`;
  const clock = (t) => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
  const dur = (sp) => sp.end != null && sp.start != null ? Math.max(0, sp.end - sp.start) : null;
  // mcp__server__tool reads better as server › tool.
  const label = (n) => n.startsWith('mcp__') ? n.slice(5).replace('__', ' › ') : n;

  const turns = $derived.by(() => {
    const q = filter.trim().toLowerCase();
    const all = (res?.turns || []).map((t) => ({
      ...t,
      spans: q ? t.spans.filter((s) => s.name.toLowerCase().includes(q) || s.detail.toLowerCase().includes(q)) : t.spans,
    })).filter((t) => t.spans.length);
    return all.reverse();
  });
  const stats = $derived.by(() => {
    let n = 0, total = 0, slowest = null, errors = 0;
    for (const t of turns) for (const s of t.spans) {
      n++;
      if (s.error) errors++;
      const d = dur(s);
      if (d == null) continue;
      total += d;
      if (!slowest || d > dur(slowest)) slowest = s;
    }
    return { n, total, slowest, errors };
  });

  function bar(t, s) {
    const span = Math.max(1, (t.end || t.start) - t.start);
    const left = ((s.start - t.start) / span) * 100;
    const end = s.end ?? t.end;
    const width = Math.max(0.6, ((end - s.start) / span) * 100);
    return `left:${Math.min(left, 99.4)}%;width:${Math.min(width, 100 - left)}%`;
  }
</script>

<div class="trace">
  <div class="head">
    <div>
      <h2>Trace</h2>
      <p class="sub">
        Every tool call, timed from the request to its result, grouped by prompt (newest first).
        Gaps between bars are model time. Click a row for its input and output.
      </p>
    </div>
    <div class="kpis">
      <div><b>{stats.n}</b><span>calls</span></div>
      <div><b>{fmtMs(stats.total)}</b><span>in tools</span></div>
      {#if stats.errors}<div class="bad"><b>{stats.errors}</b><span>errors</span></div>{/if}
    </div>
  </div>

  <div class="bar">
    <input class="pick" bind:value={filter} placeholder="Filter by tool or argument (Bash, mcp, src/…)" />
    <button class="btn" onclick={() => load(id)} disabled={loading}>
      <Icon name={loading ? 'queued' : 'refresh'} size={14} /> Refresh
    </button>
  </div>

  {#if stats.slowest}
    <p class="slowest">
      Slowest: <b>{label(stats.slowest.name)}</b> · {fmtMs(dur(stats.slowest))}
      {#if stats.slowest.detail}<code>{stats.slowest.detail}</code>{/if}
    </p>
  {/if}

  {#if res?.error}
    <p class="empty">{res.error}</p>
  {:else if !res}
    <p class="empty">Loading trace…</p>
  {:else if !turns.length}
    <p class="empty">{filter ? 'No tool call matches this filter.' : 'No tool call in this session yet.'}</p>
  {:else}
    {#each turns.slice(0, shown) as t (t.start + ':' + t.spans[0].id)}
      <section class="turn">
        <header>
          <span class="prompt" title={t.prompt}><Icon name="user" size={13} /> {t.prompt || '(resumed)'}</span>
          <span class="meta">{clock(t.start)} · {fmtMs(t.end - t.start)} · {t.spans.length} call{t.spans.length > 1 ? 's' : ''}</span>
        </header>
        {#each t.spans as s (s.id)}
          <button class="row" class:open={open === s.id} class:err={s.error} onclick={() => toggle(s)}>
            <span class="name" style="--c:{tagColor(s.name)}">{label(s.name)}</span>
            <span class="detail" title={s.detail}>{s.detail}</span>
            <span class="track"><span class="span" class:pending={s.end == null} style="{bar(t, s)};--c:{tagColor(s.name)}"></span></span>
            <span class="dur">{s.end == null ? 'no result' : fmtMs(dur(s))}</span>
          </button>
          {#if open === s.id}
            {@const d = details[s.id]}
            <div class="det">
              <div class="when">started {clock(s.start)}{#if s.end} · ended {clock(s.end)}{/if}</div>
              {#if !d}
                <span class="sub">Loading…</span>
              {:else if d.failed}
                <span class="sub">Could not load this call.</span>
              {:else}
                <div class="io"><span>Input</span><pre>{d.input || '—'}</pre></div>
                <div class="io" class:err={d.error}><span>{d.error ? 'Error' : 'Output'}</span><pre>{d.result ?? '(no result)'}</pre></div>
              {/if}
            </div>
          {/if}
        {/each}
      </section>
    {/each}
    {#if turns.length > shown}
      <button class="btn more" onclick={() => (shown += TURN_WINDOW)}>Show earlier prompts · {turns.length - shown} hidden</button>
    {/if}
  {/if}
</div>

<style>
  .trace { padding: 10px 0 60px; }
  .head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
  .head > div:first-child { flex: 1 1 auto; }
  h2 { font-size: var(--t-title); line-height: var(--lh-title); margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { margin: 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .kpis { flex: none; display: flex; gap: 8px; }
  .kpis div { display: flex; flex-direction: column; align-items: center; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 6px 12px; }
  .kpis b { font-size: var(--t-body); color: var(--accent); font-variant-numeric: tabular-nums; }
  .kpis span { font-size: var(--t-micro); color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
  .kpis .bad { border-color: var(--attention); }
  .kpis .bad b { color: var(--attention); }

  .bar { display: flex; gap: 8px; margin: 0 0 12px; }
  .pick { flex: 1 1 260px; min-width: 0; padding: 9px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-body); }
  .pick:focus { outline: none; border-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .more { display: flex; margin: 12px auto 0; }
  .slowest { margin: 0 0 16px; color: var(--muted); font-size: var(--t-ui); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .slowest code { margin-left: 6px; font-family: var(--mono); font-size: var(--t-meta); }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }

  .turn { border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); margin-bottom: 10px; overflow: hidden; }
  .turn header { display: flex; gap: 12px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--border); font-size: var(--t-ui); }
  .prompt { flex: 1 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { flex: none; color: var(--muted); font-size: var(--t-meta); font-variant-numeric: tabular-nums; }

  .row { display: grid; grid-template-columns: 150px minmax(0, 1fr) minmax(120px, 34%) 72px; gap: 10px; align-items: center; width: 100%; padding: 5px 12px; border: none; background: none; color: var(--text); font: inherit; font-size: var(--t-meta); text-align: left; cursor: pointer; }
  .row:hover, .row.open { background: var(--hover); }
  .name { font-weight: 650; color: var(--c); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .detail { font-family: var(--mono); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .track { position: relative; height: 10px; background: var(--bg3); border-radius: 3px; }
  .span { position: absolute; top: 0; bottom: 0; background: var(--c); border-radius: 3px; min-width: 2px; }
  .span.pending { opacity: .35; }
  .row.err .span { background: var(--attention); }
  .row.err .dur { color: var(--attention); }
  .dur { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }

  .det { padding: 8px 12px 12px; background: var(--bg); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
  .when { color: var(--muted); font-size: var(--t-micro); }
  .io span { display: block; font-size: var(--t-micro); text-transform: uppercase; letter-spacing: .03em; color: var(--muted); margin-bottom: 3px; }
  .io.err span { color: var(--attention); }
  .io pre { margin: 0; padding: 9px 10px; background: var(--bg3); border-radius: 8px; font-family: var(--mono); font-size: var(--t-meta); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow-y: auto; }
</style>
