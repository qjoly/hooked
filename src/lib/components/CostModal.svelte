<script>
  import { data } from '$lib/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';
  import { fmtCost, fmtTokens, shortModel } from '$lib/format.js';

  const S = $derived(data.sessions);
  const sum = (f) => S.reduce((a, s) => a + f(s), 0);

  const cb = $derived({
    input: sum((s) => (s.costBreak ? s.costBreak.input : 0)),
    output: sum((s) => (s.costBreak ? s.costBreak.output : 0)),
    cacheCreate: sum((s) => (s.costBreak ? s.costBreak.cacheCreate : 0)),
    cacheRead: sum((s) => (s.costBreak ? s.costBreak.cacheRead : 0)),
  });
  const tk = $derived({
    input: sum((s) => s.usage.input), output: sum((s) => s.usage.output),
    cacheCreate: sum((s) => s.usage.cacheCreate), cacheRead: sum((s) => s.usage.cacheRead),
  });
  const tot = $derived(cb.input + cb.output + cb.cacheCreate + cb.cacheRead || 1e-9);
  const COMP = [['Input', 'input', '#6cb0ff'], ['Output', 'output', '#3fb950'], ['Cache write', 'cacheCreate', '#e3b341'], ['Cache read', 'cacheRead', '#f0883e']];

  const byModel = $derived.by(() => { const o = {}; S.forEach((s) => { if (s.cost) o[s.model || '?'] = (o[s.model || '?'] || 0) + s.cost; }); return o; });
  const byProj = $derived.by(() => { const o = {}; S.forEach((s) => { o[s.projectName || '?'] = (o[s.projectName || '?'] || 0) + s.cost; }); return o; });

  function listRows(obj, fk) {
    const e = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const mx = Math.max(1e-9, ...e.map((x) => x[1]));
    return e.map(([k, v]) => ({ k, label: fk ? fk(k) : k, v, pct: Math.max(1, v / mx * 100) }));
  }
  const modelRows = $derived(listRows(byModel, (k) => shortModel(k)));
  const projRows = $derived(listRows(byProj));
</script>

<h2 style="margin:0 0 4px"><Icon name="cost" size={18} /> Estimated API cost — {fmtCost(tot)}</h2>
<p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 18px">
  Pay-as-you-go API estimate. On a subscription (Max/Pro), this is <b>not</b> your actual bill.
  Rates: Fable 10/50, Opus 5/25, Sonnet 3/15, Haiku 1/5 $/Mtok; cache write ×1.25, read ×0.1.</p>
<h3 style="margin:0 0 12px">By component <span style="color:var(--muted);font-weight:400;font-size:12px">(cost · % · tokens)</span></h3>
{#each COMP as [label, key, col]}
  <div class="bar-row">
    <span class="label">{label}</span>
    <span class="track"><span class="fill" style="width:{Math.max(1, (cb[key] / tot) * 100)}%;background:{col}"></span></span>
    <span class="val">{fmtCost(cb[key])}</span>
    <span class="val" style="width:48px;color:var(--muted)">{(cb[key] / tot * 100).toFixed(0)}%</span>
    <span class="val" style="width:58px;color:var(--muted)">{fmtTokens(tk[key])}</span>
  </div>
{/each}
<div class="cost-cols">
  <div>
    <h3 style="margin:18px 0 12px">By model</h3>
    {#if modelRows.length}
      {#each modelRows as r}
        <div class="bar-row"><span class="label" title={r.k}>{r.label}</span><span class="track"><span class="fill" style="width:{r.pct}%"></span></span><span class="val">{fmtCost(r.v)}</span></div>
      {/each}
    {:else}<div class="empty">—</div>{/if}
  </div>
  <div>
    <h3 style="margin:18px 0 12px">By project</h3>
    {#if projRows.length}
      {#each projRows as r}
        <div class="bar-row"><span class="label" title={r.k}>{r.label}</span><span class="track"><span class="fill" style="width:{r.pct}%"></span></span><span class="val">{fmtCost(r.v)}</span></div>
      {/each}
    {:else}<div class="empty">—</div>{/if}
  </div>
</div>
