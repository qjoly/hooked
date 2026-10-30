<script>
  // A Grafana query (Prometheus or Loki) drawn in a floating window. It opens either on a query
  // Claude made (its result is shown first, then hooked can re-run it) or on a show_query spec.
  // hooked re-runs queries itself through mcp-gateway; a relative range slides with each refresh.
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import FloatingWindow from './FloatingWindow.svelte';
  import QueryChart from './QueryChart.svelte';

  let { q, onclose } = $props(); // q = { session, agent, id } | { spec, session }

  const REFRESH = [[0, 'Off'], [10, '10s'], [30, '30s'], [60, '1m'], [300, '5m']];

  let spec = $state(null);      // { tool, datasource, query, range | start/end, step, limit, title }
  let d = $state(null);         // parsed result
  let err = $state('');
  let login = $state(false);    // hooked is not connected to mcp-gateway yet
  let loading = $state(false);
  let updatedAt = $state(null); // null while the result is Claude's snapshot
  let refresh = $state(0);

  // Claude's absolute range becomes a range of the same length ending now, so a refresh slides it.
  function liveSpec(tool, input) {
    const s = { tool, ...input };
    const len = (Date.parse(input.end) - Date.parse(input.start)) / 1000;
    if (len > 0) { s.range = `${Math.round(len)}s`; delete s.start; delete s.end; }
    return s;
  }

  async function run() {
    if (!spec || loading) return;
    loading = true;
    try {
      const r = await fetch('/api/grafana/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
      const j = await r.json();
      login = !!j.login;
      if (j.error) err = j.login ? '' : j.error;
      else { d = j.data; err = ''; updatedAt = new Date(); }
    } catch (e) { err = e.message; } finally { loading = false; }
  }

  $effect(() => untrack(async () => {
    if (q.spec) { spec = q.spec; refresh = q.spec.refresh ?? 30; return run(); }
    try {
      const p = new URLSearchParams({ session: q.session || '', agent: q.agent || '', id: q.id });
      const j = await (await fetch(`/api/query-result?${p}`)).json();
      if (j.error) { err = j.error; return; }
      spec = liveSpec(j.tool, j.input);
      if (j.data) d = j.data; // show_query has no result of its own
      else { refresh = j.input.refresh ?? 30; run(); }
    } catch (e) { err = e.message; }
  }));

  $effect(() => {
    if (!refresh || login) return;
    const t = setInterval(run, refresh * 1000);
    return () => clearInterval(t);
  });

  // Sign-in happens in a new tab, through a plain link: a scripted window.open is often blocked.
  // The URL is fetched as soon as the sign-in is needed, so the click has a real href to follow.
  let loginHref = $state('');
  let watching = false;
  $effect(() => {
    if (!login || loginHref) return;
    fetch(`/api/grafana/login?proto=${location.protocol.replace(':', '')}`).then((x) => x.json())
      .then((j) => { if (j.error) err = j.error; else loginHref = j.url; })
      .catch((e) => { err = e.message; });
  });
  async function watchLogin() {
    if (watching) return;
    watching = true;
    for (let i = 0; i < 150 && login; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      if ((await (await fetch('/api/grafana/status')).json()).connected) { login = false; loginHref = ''; run(); }
    }
    watching = false;
  }

  const range = $derived(!spec ? '' : spec.range ? `last ${spec.range}` : [spec.start, spec.end].filter(Boolean).join(' → ') || 'instant');
  const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
  // ponytail: the unit is guessed from the query, an explicit unit needs the metric metadata.
  // A ratio of two memory metrics is a percentage, not bytes.
  const bytesQuery = (x = '') => (/bytes|memory/i.test(x) && !x.includes('/') ? 'bytes' : '');
  const LEVEL = { error: 'ko', err: 'ko', critical: 'ko', fatal: 'ko', warn: 'wait', warning: 'wait' };
</script>

<FloatingWindow {onclose} corner="left" width={820} height={540}>
  {#snippet title()}
    <Icon name="stats" size={14} />
    <span class="ttl">{spec?.title || (spec ? (spec.tool === 'loki' ? 'Loki' : 'Prometheus') : 'Grafana query')}</span>
    {#if spec?.datasource}<code>{spec.datasource}</code>{/if}
  {/snippet}

  {#if spec}
    <div class="q">
      <code class="expr" title={spec.query}>{spec.query}</code>
      <div class="tb">
        <span class="dim">{range}{spec.step ? ` · step ${spec.step}` : ''}</span>
        <span class="dim upd">{updatedAt ? `updated ${updatedAt.toLocaleTimeString()}` : d ? 'result Claude got' : ''}</span>
        <button class="rf" onclick={run} disabled={loading || login} title="Run the query again"><Icon name="refresh" size={12} /></button>
        <select bind:value={refresh} title="Auto-refresh" disabled={login}>
          {#each REFRESH as [v, label]}<option value={v}>{label}</option>{/each}
        </select>
      </div>
    </div>
  {/if}
  {#if login}
    <div class="login">
      <span>hooked needs its own sign-in to mcp-gateway to run queries.{#if err}<br /><span class="ko">{err}</span>{/if}</span>
      <a class="cta" class:wait={!loginHref} href={loginHref || undefined} target="_blank" rel="noopener" data-native onclick={watchLogin}><Icon name="external" size={12} /> Connect</a>
    </div>
  {:else if err}<p class="ko">{err}</p>{/if}

  {#if !d}
    {#if !err && !login}<p class="empty">Loading…</p>{/if}
  {:else}
    {#if d.kind === 'error'}
      <p class="ko">{d.error}</p>
    {:else if d.kind === 'series'}
      {#if d.series.some((x) => x.points.length)}<QueryChart series={d.series} unit={bytesQuery(spec?.query)} />{:else}<p class="empty">No data.</p>{/if}
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
  .tb { display: flex; align-items: center; gap: 8px; }
  .upd { margin-left: auto; }
  .rf { display: inline-flex; padding: 4px; border: none; border-radius: 6px; background: none; color: var(--muted); cursor: pointer; }
  .rf:hover:not(:disabled) { background: var(--bg3); color: var(--text); }
  .rf:disabled { opacity: .5; }
  select { font: inherit; font-size: var(--t-micro); color: var(--text); background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 2px 4px; }
  .login { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--warn-soft); font-size: var(--t-meta); }
  .cta.wait { opacity: .6; pointer-events: none; }
  .cta { text-decoration: none; margin-left: auto; display: inline-flex; align-items: center; gap: 5px; border: none; border-radius: 7px; padding: 4px 10px; background: var(--accent); color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer; }
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
