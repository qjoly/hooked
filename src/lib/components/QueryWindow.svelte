<script>
  // The result of a Grafana query made by Claude (Prometheus or Loki), drawn in a floating window.
  // It is the snapshot Claude received: hooked cannot re-run the query.
  import Icon from './Icon.svelte';
  import FloatingWindow from './FloatingWindow.svelte';
  import QueryChart from './QueryChart.svelte';

  let { q, onclose } = $props(); // q = { session, agent, id }

  let r = $state(null);
  let err = $state('');

  $effect(() => {
    const p = new URLSearchParams({ session: q.session || '', agent: q.agent || '', id: q.id });
    fetch(`/api/query-result?${p}`).then((x) => x.json())
      .then((j) => { if (j.error) err = j.error; else r = j; })
      .catch((e) => { err = e.message; });
  });

  const d = $derived(r?.data);
  const range = $derived(r ? [r.input.start, r.input.end].filter(Boolean).join(' → ') : '');
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  // ponytail: the unit is guessed from the query, an explicit unit needs the metric metadata.
  // A ratio of two memory metrics is a percentage, not bytes.
  const bytesQuery = (x = '') => (/bytes|memory/i.test(x) && !x.includes('/') ? 'bytes' : '');
  const LEVEL = { error: 'ko', err: 'ko', critical: 'ko', fatal: 'ko', warn: 'wait', warning: 'wait' };
</script>

<FloatingWindow {onclose} corner="left" width={820} height={540}>
  {#snippet title()}
    <Icon name="stats" size={14} />
    <span class="ttl">{r ? (r.tool === 'loki' ? 'Loki' : 'Prometheus') : 'Grafana query'}</span>
    {#if r?.input.datasource}<code>{r.input.datasource}</code>{/if}
  {/snippet}

  {#if !r}
    <p class="empty" class:ko={err}>{err || 'Loading…'}</p>
  {:else}
    <div class="q">
      <code class="expr" title={r.input.query}>{r.input.query}</code>
      <span class="dim">{range}{r.input.step ? ` · step ${r.input.step}` : ''}</span>
    </div>

    {#if d.kind === 'error'}
      <p class="ko">{d.error}</p>
    {:else if d.kind === 'series'}
      {#if d.series.some((x) => x.points.length)}<QueryChart series={d.series} unit={bytesQuery(r.input.query)} />{:else}<p class="empty">No data.</p>{/if}
    {:else if d.kind === 'table'}
      <div class="scroll">
        <table>
          <tbody>
            {#each [...d.rows].sort((a, b) => b.value - a.value) as row, i (i)}
              <tr><td class="nm">{row.label}</td><td class="v">{fmt.format(row.value)}</td></tr>
            {:else}<tr><td class="dim">No data.</td></tr>{/each}
          </tbody>
        </table>
      </div>
    {:else}
      {#if d.total > d.lines.length}<span class="dim">Latest {d.lines.length} of {d.total} lines.</span>{/if}
      <div class="scroll logs">
        {#each d.lines as l, i (i)}
          <div class="log" title={l.labels}>
            <span class="dim t">{new Date(l.t).toLocaleString()}</span>
            <span class="lv {LEVEL[l.level.toLowerCase()] || 'dim'}">{l.level && l.level !== 'unknown' ? l.level : ''}</span>
            <span class="line">{l.line}</span>
          </div>
        {:else}<p class="empty">No lines.</p>{/each}
      </div>
    {/if}
  {/if}
</FloatingWindow>

<style>
  .ttl { white-space: nowrap; }
  .empty { text-align: center; padding: 40px 12px; color: var(--muted); }
  .dim { color: var(--muted); }
  .ko { color: var(--danger); } .wait { color: var(--warn); }
  code { font-family: var(--mono); font-size: var(--t-micro); background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-weight: 500; }
  .q { display: flex; flex-direction: column; gap: 4px; font-size: var(--t-meta); }
  .expr { display: block; padding: 6px 8px; white-space: pre-wrap; word-break: break-word; max-height: 4.5em; overflow: auto; }
  .scroll { flex: 1; min-height: 0; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--t-meta); }
  td { padding: 3px 6px; border-bottom: 1px solid var(--border); }
  td.nm { font-family: var(--mono); font-size: var(--t-micro); word-break: break-all; }
  td.v { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .logs { font-family: var(--mono); font-size: var(--t-micro); line-height: 1.5; }
  .log { display: grid; grid-template-columns: auto 4.5em 1fr; gap: 8px; padding: 1px 4px; border-radius: 4px; }
  .log:hover { background: rgba(var(--ink-rgb), .04); }
  .t { white-space: nowrap; }
  .line { white-space: pre-wrap; word-break: break-word; }
</style>
