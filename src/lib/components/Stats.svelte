<script>
  import { getStats, getUsage } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import { fmtCost, fmtTokens, shortModel, fmtDuration, ago, lotColor } from '$lib/format.js';
  import { ui } from '$lib/state.svelte.js';
  import BarChart from './BarChart.svelte';

  const RANGES = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All']];
  let range = $state('7');
  let d = $state(null);

  async function load() { try { d = await getStats(range); } catch (_) {} }
  $effect(() => { range; load(); });

  // Bloc « Usage » (équivalent /usage) : rate limits du compte + contexte/effort de la session
  // courante + budget 5 h. Indépendant du sélecteur de plage → rafraîchi sur le tick live (SSE)
  // pour que les comptes à rebours de reset avancent. Lire ui.tick AVANT toute garde (dép suivie).
  let u = $state(null);
  async function loadUsage() { try { u = await getUsage(); } catch (_) {} }
  $effect(() => { ui.tick; loadUsage(); });

  // largeur de barre bornée [0,100] ; null → 0.
  const barW = (pct) => Math.max(0, Math.min(100, pct || 0));

  const kpis = $derived(d ? [
    [fmtCost(d.totals.cost), 'Estimated cost'],
    [d.totals.sessions, 'Sessions'],
    [d.totals.prompts, 'Prompts'],
    [fmtTokens(d.totals.output), 'Tokens generated'],
    [fmtTokens(d.totals.cacheRead), 'Cache tokens read'],
  ] : []);

  const days = $derived(d ? Object.keys(d.byDay).sort() : []);
  const maxDayCost = $derived(Math.max(1e-6, ...days.map((k) => d.byDay[k].cost)));
  const modelEntries = $derived(d ? Object.entries(d.byModel).map(([k, v]) => [shortModel(k), v.cost]) : []);
  const projectEntries = $derived(d ? Object.entries(d.byProject).map(([k, v]) => [k, v.cost]) : []);
  const toolEntries = $derived(d ? Object.entries(d.byTool).map(([k, v]) => [k, v]) : []);
</script>

<h2 class="usage-title">Usage</h2>
<div class="usage-grid">
  <!-- Account rate limits (5 h / 7 j) — globaux au compte -->
  <div class="card usage-card">
    <h3>Account limits</h3>
    {#if u && u.account}
      {@const a = u.account}
      <div class="ubar-row">
        <div class="ubar-head"><span>5-hour</span><span class="pct">{a.fiveHour?.pct ?? '—'}%</span></div>
        <div class="ubar"><div class="ubar-fill" style="width:{barW(a.fiveHour?.pct)}%"></div></div>
        <div class="ubar-sub">{a.fiveHour?.resetInMin != null ? `resets in ${fmtDuration(a.fiveHour.resetInMin)}` : '—'}</div>
      </div>
      <div class="ubar-row">
        <div class="ubar-head"><span>7-day</span><span class="pct">{a.sevenDay?.pct ?? '—'}%</span></div>
        <div class="ubar"><div class="ubar-fill" style="width:{barW(a.sevenDay?.pct)}%"></div></div>
        <div class="ubar-sub">{a.sevenDay?.resetInMin != null ? `resets in ${fmtDuration(a.sevenDay.resetInMin)}` : '—'}</div>
      </div>
      {#if a.at}<div class="usage-foot">updated {ago(a.at)}</div>{/if}
    {:else if u}
      <div class="empty">No statusline data yet — is <code>statusline-tap.sh</code> configured?</div>
    {:else}
      <div class="empty">Loading usage…</div>
    {/if}
  </div>

  <!-- Session courante (statusline la plus fraîche) : contexte, effort, modèle, fast mode -->
  <div class="card usage-card">
    <h3>Current session</h3>
    {#if u && u.session}
      {@const s = u.session}
      <div class="ubar-row">
        <div class="ubar-head"><span>Context</span><span class="pct">{s.context?.pct ?? '—'}%</span></div>
        <div class="ubar"><div class="ubar-fill" style="width:{barW(s.context?.pct)}%"></div></div>
        <div class="ubar-sub">{s.context?.size ? `of ${fmtTokens(s.context.size)} tokens` : '—'}</div>
      </div>
      <div class="chips">
        <span class="chip">Effort: <b>{s.effort || '—'}</b></span>
        <span class="chip">Model: <b>{s.modelName || shortModel(s.modelId) || '—'}</b></span>
        {#if s.fastMode}<span class="chip fast"><Icon name="fast" size={13} tint={false} /> Fast</span>{/if}
      </div>
    {:else if u}
      <div class="empty">No active session snapshot.</div>
    {:else}
      <div class="empty">Loading usage…</div>
    {/if}
  </div>
</div>

<div class="toolbar">
  <div class="range" id="range">
    {#each RANGES as [r, label]}
      <button class:active={range === r} onclick={() => (range = r)}>{label}</button>
    {/each}
  </div>
</div>

<div class="kpis">
  {#each kpis as [v, l]}
    <div class="kpi"><div class="v">{v}</div><div class="l">{l}</div></div>
  {/each}
</div>

<div class="charts">
  <div class="card chart-card">
    <h3>Cost per day <span class="sub">(estimated)</span></h3>
    <div>
      {#if days.length}
        <div class="daybars">
          {#each days.slice(-30) as k}
            <div class="col" title="{k} · {fmtCost(d.byDay[k].cost)}">
              <div class="b" style="height:{Math.round((d.byDay[k].cost / maxDayCost) * 100)}%"></div>
              <div class="cap">{k.slice(5)}</div>
            </div>
          {/each}
        </div>
      {:else}
        <div class="empty">No data</div>
      {/if}
    </div>
  </div>
  <div class="card chart-card">
    <h3>By model</h3>
    <div><BarChart entries={modelEntries} fmt={fmtCost} /></div>
  </div>
  <div class="card chart-card">
    <h3>By project</h3>
    <div><BarChart entries={projectEntries} fmt={fmtCost} series={lotColor} /></div>
  </div>
  <div class="card chart-card">
    <h3>Most used tools</h3>
    <div><BarChart entries={toolEntries} fmt={(n) => n} /></div>
  </div>
</div>

<style>
  .usage-title { margin: 0 0 14px; font-size: var(--t-title); line-height: var(--lh-title); }
  .usage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; margin-bottom: 24px; }
  .usage-card h3 { margin: 0 0 14px; font-size: var(--t-body); }
  .usage-card h3 .sub { color: var(--muted); font-weight: 400; font-size: var(--t-meta); }
  .ubar-row { margin-bottom: 14px; }
  .ubar-row:last-child { margin-bottom: 0; }
  .ubar-head { display: flex; justify-content: space-between; font-size: var(--t-ui); margin-bottom: 6px; }
  .ubar-head .pct { font-weight: 700; font-variant-numeric: tabular-nums; }
  .ubar { height: 8px; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
  .ubar-fill { height: 100%; background: linear-gradient(90deg, #d2825a, var(--accent)); border-radius: 6px; transition: width .3s ease; }
  .ubar-sub { color: var(--muted); font-size: var(--t-micro); margin-top: 5px; }
  .usage-foot { color: var(--muted); font-size: var(--t-micro); margin-top: 12px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
  .chip { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; font-size: var(--t-meta); color: var(--muted); }
  .chip b { color: var(--text); font-weight: 600; }
  .chip.fast { color: var(--accent); border-color: var(--accent); }
  .empty { color: var(--muted); font-size: var(--t-ui); }
  .empty code { font-family: var(--mono); }
</style>
