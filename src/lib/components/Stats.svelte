<script>
  import { getStats } from '$lib/api.js';
  import { fmtCost, fmtTokens, shortModel } from '$lib/format.js';
  import BarChart from './BarChart.svelte';

  const RANGES = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['all', 'All']];
  let range = $state('7');
  let d = $state(null);

  async function load() { try { d = await getStats(range); } catch (_) {} }
  $effect(() => { range; load(); });

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
    <div><BarChart entries={projectEntries} fmt={fmtCost} /></div>
  </div>
  <div class="card chart-card">
    <h3>Most used tools</h3>
    <div><BarChart entries={toolEntries} fmt={(n) => n} /></div>
  </div>
</div>
