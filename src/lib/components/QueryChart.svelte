<script>
  // Grafana-style time series: 2px lines, crosshair tooltip, and a legend table (last / max / mean)
  // where a click isolates one series.
  import { themeType } from '$lib/theme.svelte.js';

  let { series, unit = '' } = $props();

  // Categorical slots in fixed order; past them, series are drawn in recessive grey.
  const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
  const DARK = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
  const M = { top: 8, right: 12, bottom: 22, left: 52 };

  let w = $state(600);
  let h = $state(260);
  let only = $state(null);  // isolated series index
  let hover = $state(null); // { t, x }

  const fmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 });
  const BYTES = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  function fmtBytes(v) {
    let i = 0;
    while (Math.abs(v) >= 1024 && i < BYTES.length - 1) { v /= 1024; i++; }
    return `${+v.toFixed(v >= 100 ? 0 : 1)} ${BYTES[i]}`;
  }
  const fmtV = (v) => (!Number.isFinite(v) ? '–' : unit === 'bytes' ? fmtBytes(v) : fmt.format(v));

  // Highest peaks first, so the colored slots go to the series that matter.
  const rows = $derived.by(() => {
    const palette = themeType() === 'dark' ? DARK : LIGHT;
    return series.map((s) => {
      const vals = s.points.map((p) => p[1]).filter(Number.isFinite);
      return { ...s, last: vals.at(-1), max: vals.length ? vals.reduce((a, b) => (b > a ? b : a)) : NaN, mean: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : NaN };
    }).sort((a, b) => (b.max || 0) - (a.max || 0)).map((s, i) => ({ ...s, color: palette[i] || 'var(--border2)', i }));
  });
  const visible = $derived(only == null ? rows : rows.filter((r) => r.i === only));

  // Loops rather than Math.min(...spread): a long range has more points than the argument limit.
  function extent(rs, i) {
    let lo = Infinity, hi = -Infinity;
    for (const r of rs) for (const p of r.points) if (Number.isFinite(p[i])) { if (p[i] < lo) lo = p[i]; if (p[i] > hi) hi = p[i]; }
    return [lo, hi];
  }
  const [tMin, tMax] = $derived(extent(rows, 0));
  const yRange = $derived.by(() => {
    const [vlo, vhi] = extent(visible, 1);
    const lo = Math.min(0, Number.isFinite(vlo) ? vlo : 0);
    return niceTicks(lo, Math.max(Number.isFinite(vhi) ? vhi : 0, lo + 1));
  });

  function niceTicks(lo, hi, n = 4) {
    const raw = (hi - lo) / n;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
    const start = Math.floor(lo / step) * step, end = Math.ceil(hi / step) * step;
    const ticks = [];
    for (let v = start; v <= end + step / 2; v += step) ticks.push(+v.toPrecision(12));
    return { lo: start, hi: end, ticks };
  }

  const pw = $derived(Math.max(10, w - M.left - M.right));
  const ph = $derived(Math.max(10, h - M.top - M.bottom));
  const x = (t) => M.left + (tMax === tMin ? pw / 2 : ((t - tMin) / (tMax - tMin)) * pw);
  const y = (v) => M.top + ph - ((v - yRange.lo) / (yRange.hi - yRange.lo || 1)) * ph;

  // A missing or NaN sample breaks the line instead of joining across the gap.
  const pathOf = (pts) => {
    let d = '', pen = false;
    for (const [t, v] of pts) {
      if (!Number.isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const days = $derived((tMax - tMin) / 864e5);
  const fmtT = (t) => new Date(t).toLocaleString(undefined, days > 1
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  const xTicks = $derived.by(() => {
    const n = Math.max(2, Math.floor(pw / 110));
    return Array.from({ length: n + 1 }, (_, i) => tMin + ((tMax - tMin) * i) / n);
  });

  const times = $derived([...new Set(visible.flatMap((r) => r.points.map((p) => p[0])))].sort((a, b) => a - b));
  function move(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * w;
    if (px < M.left || px > M.left + pw || !times.length) { hover = null; return; }
    const t = tMin + ((px - M.left) / pw) * (tMax - tMin);
    const near = times.reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
    hover = { t: near, x: x(near) };
  }
  const readout = $derived(hover ? visible
    .map((r) => ({ r, v: r.points.find((p) => p[0] === hover.t)?.[1] }))
    .filter((e) => Number.isFinite(e.v)).sort((a, b) => b.v - a.v).slice(0, 10) : []);
</script>

<div class="qc">
  <div class="plot" bind:clientWidth={w} bind:clientHeight={h}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <svg width={w} height={h} onpointermove={move} onpointerleave={() => (hover = null)} role="img" aria-label="Time series chart">
      {#each yRange.ticks as v}
        <line class="grid" x1={M.left} x2={M.left + pw} y1={y(v)} y2={y(v)} />
        <text class="ax" x={M.left - 6} y={y(v)} text-anchor="end" dominant-baseline="middle">{fmtV(v)}</text>
      {/each}
      {#each xTicks as t, i}
        <text class="ax" x={x(t)} y={h - 6} text-anchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}>{fmtT(t)}</text>
      {/each}
      {#each [...visible].reverse() as r (r.i)}
        <path d={pathOf(r.points)} fill="none" stroke={r.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      {/each}
      {#if hover}
        <line class="cross" x1={hover.x} x2={hover.x} y1={M.top} y2={M.top + ph} />
        {#each readout as e (e.r.i)}<circle cx={hover.x} cy={y(e.v)} r="4" fill={e.r.color} stroke="var(--bg2)" stroke-width="2" />{/each}
      {/if}
    </svg>
    {#if hover && readout.length}
      <div class="tip" style:left="{hover.x}px" class:flip={hover.x > w / 2}>
        <div class="tip-t">{new Date(hover.t).toLocaleString()}</div>
        {#each readout as e (e.r.i)}
          <div class="tip-r"><i style:background={e.r.color}></i><b>{fmtV(e.v)}</b><span>{e.r.label}</span></div>
        {/each}
      </div>
    {/if}
  </div>

  <div class="legend">
    <table>
      <thead><tr><th>Series</th><th>Last</th><th>Max</th><th>Mean</th></tr></thead>
      <tbody>
        {#each rows as r (r.i)}
          <tr class:off={only != null && only !== r.i} onclick={() => (only = only === r.i ? null : r.i)} title="Click to isolate">
            <td class="nm"><div><i style:background={r.color}></i><span>{r.label}</span></div></td>
            <td>{fmtV(r.last)}</td><td>{fmtV(r.max)}</td><td>{fmtV(r.mean)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>

<style>
  .qc { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
  .plot { position: relative; flex: 1 1 60%; min-height: 140px; }
  svg { position: absolute; inset: 0; display: block; }
  .grid { stroke: var(--border); stroke-width: 1; }
  .ax { fill: var(--muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .cross { stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
  .tip { position: absolute; top: 8px; transform: translateX(12px); max-width: 60%; pointer-events: none; padding: 7px 9px; border-radius: 8px;
    background: var(--bg2); border: 1px solid var(--border2); box-shadow: var(--shadow); font-size: var(--t-micro); z-index: 1; }
  .tip.flip { transform: translateX(calc(-100% - 12px)); }
  .tip-t { color: var(--muted); margin-bottom: 4px; }
  .tip-r { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tip-r span { color: var(--muted); overflow: hidden; text-overflow: ellipsis; }
  .tip-r b { font-variant-numeric: tabular-nums; }
  i { flex: none; width: 10px; height: 2px; border-radius: 1px; display: inline-block; }
  .legend { flex: 0 1 40%; min-height: 60px; overflow: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--t-micro); }
  th { position: sticky; top: 0; background: var(--bg2); color: var(--muted); font-weight: 600; text-align: right; padding: 3px 6px; }
  th:first-child { text-align: left; }
  td { text-align: right; padding: 3px 6px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr { cursor: pointer; }
  tbody tr:hover { background: rgba(var(--ink-rgb), .04); }
  tr.off { opacity: .45; }
  td.nm { text-align: left; max-width: 0; width: 100%; }
  td.nm div { display: flex; align-items: center; gap: 6px; }
  td.nm span { overflow: hidden; text-overflow: ellipsis; }
</style>
