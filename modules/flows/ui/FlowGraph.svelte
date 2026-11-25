<script>
  // A flow drawn as a CI pipeline: one column per depth, stage cards, edges between them, and a
  // dashed back-edge from the decider to the stage it loops to. `stages` (the run's state map) is
  // optional: without it the graph is a template preview.
  import { columns } from '../lib/flows.js';
  import Icon from '#lib/components/Icon.svelte';

  let { flow, stages = null, iteration = 1, selected = null, onselect = null } = $props();

  const W = 188, H = 64, GX = 64, GY = 18, PAD = 12, LOOP_H = 44;

  const layout = $derived.by(() => {
    const cols = columns(flow.stages);
    const tallest = Math.max(1, ...cols.map((c) => c.length));
    const height = tallest * H + (tallest - 1) * GY;
    const pos = new Map();
    cols.forEach((col, i) => {
      const colH = col.length * H + (col.length - 1) * GY;
      col.forEach((s, j) => pos.set(s.key, { x: PAD + i * (W + GX), y: PAD + (height - colH) / 2 + j * (H + GY) }));
    });
    const decider = flow.stages.find((s) => s.decider && s.loopTo && pos.has(s.loopTo));
    return {
      pos,
      decider,
      width: PAD * 2 + cols.length * W + (cols.length - 1) * GX,
      height: PAD * 2 + height + (decider ? LOOP_H : 0),
      bottom: PAD + height,
    };
  });

  const edges = $derived(flow.stages.flatMap((s) => s.after.filter((a) => layout.pos.has(a)).map((a) => {
    const p = layout.pos.get(a), c = layout.pos.get(s.key);
    const x1 = p.x + W, y1 = p.y + H / 2, x2 = c.x, y2 = c.y + H / 2, mx = (x1 + x2) / 2;
    const st = stages?.[a]?.status;
    return { id: a + '>' + s.key, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 6},${y2}`, done: st === 'done' };
  })));

  const loop = $derived.by(() => {
    const d = layout.decider;
    if (!d) return null;
    const from = layout.pos.get(d.key), to = layout.pos.get(d.loopTo);
    const y = layout.bottom + LOOP_H - 14;
    const x1 = from.x + W / 2, x2 = to.x + W / 2;
    return {
      d: `M${x1},${from.y + H} C${x1},${y} ${x1},${y} ${(x1 + x2) / 2},${y} C${x2},${y} ${x2},${y} ${x2},${to.y + H + 6}`,
      lx: (x1 + x2) / 2, ly: y - 6,
      label: `loop · max ${flow.maxLoops}`,
    };
  });

  function look(key) {
    const st = stages?.[key];
    if (!st) return { tone: 'idle', icon: 'circle', text: 'stage' };
    if (st.starting || st.status === 'starting') return { tone: 'run', icon: 'working', text: 'starting', spin: true };
    if (st.status === 'done') {
      const v = st.report?.verdict;
      if (v === 'loop') return { tone: 'loop', icon: 'rotate-cw', text: 'looped back' };
      if (v === 'escalate') return { tone: 'warn', icon: 'attention', text: 'escalated' };
      return { tone: 'ok', icon: 'circle-check', text: st.report?.byUser ? 'done (by you)' : 'done' };
    }
    if (st.status === 'stalled') return { tone: 'warn', icon: 'attention', text: 'stalled: needs you' };
    if (st.status === 'lost') return { tone: 'bad', icon: 'warning', text: 'session lost' };
    if (st.status === 'running') {
      if (st.waiting) return { tone: 'warn', icon: 'question', text: 'waiting on you' };
      if (st.report) return { tone: 'run', icon: 'working', text: 'reported, wrapping up', spin: true };
      return { tone: 'run', icon: 'working', text: 'working', spin: true };
    }
    return { tone: 'idle', icon: 'queued', text: 'pending' };
  }
</script>

<div class="fg" style="width:{layout.width}px;height:{layout.height}px">
  <svg width={layout.width} height={layout.height} aria-hidden="true">
    <defs>
      <marker id="fg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
        <path d="M0,0 L10,5 L0,10 z" fill="currentColor" />
      </marker>
    </defs>
    {#each edges as e (e.id)}
      <path class="edge" class:done={e.done} d={e.d} marker-end="url(#fg-arrow)" />
    {/each}
    {#if loop}
      <path class="edge loop" d={loop.d} marker-end="url(#fg-arrow)" />
      <text class="loop-label" x={loop.lx} y={loop.ly} text-anchor="middle">{loop.label}{stages && iteration > 1 ? ` · pass ${iteration}` : ''}</text>
    {/if}
  </svg>
  {#each flow.stages as s (s.key)}
    {@const p = layout.pos.get(s.key)}
    {@const l = look(s.key)}
    {#if p}
      <button
        class="card t-{l.tone}"
        class:sel={selected === s.key}
        style="left:{p.x}px;top:{p.y}px;width:{W}px;height:{H}px"
        onclick={() => onselect?.(s.key)}
        disabled={!onselect}
        title={s.role}
      >
        <span class="ic" class:spin={l.spin}><Icon name={l.icon} size={16} /></span>
        <span class="txt">
          <span class="nm">{s.name}{#if s.decider}<span class="tag">decider</span>{/if}{#if s.writes}<span class="tag">writer</span>{/if}</span>
          <span class="sub">{l.text}</span>
        </span>
      </button>
    {/if}
  {/each}
</div>

<style>
  .fg { position: relative; flex: none; }
  svg { position: absolute; inset: 0; overflow: visible; color: var(--border2); }
  .edge { fill: none; stroke: currentColor; stroke-width: 1.6; }
  .edge.done { color: var(--success); stroke: var(--success); }
  .edge.loop { stroke-dasharray: 5 4; color: var(--accent); stroke: var(--accent); }
  .loop-label { fill: var(--accent); font-size: 11px; font-weight: 600; }
  .card {
    position: absolute; display: flex; align-items: center; gap: 10px; padding: 0 12px; text-align: left;
    border: 1px solid var(--border); border-left-width: 4px; border-radius: 10px; background: var(--bg2); color: var(--text); cursor: pointer;
  }
  .card:disabled { cursor: default; }
  .card:hover:not(:disabled) { border-color: var(--border2); }
  .card.sel { box-shadow: 0 0 0 2px var(--accent); }
  .ic { flex: none; display: inline-flex; }
  .ic.spin { animation: fg-spin 1s linear infinite; }
  @keyframes fg-spin { to { transform: rotate(360deg); } }
  .txt { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .nm { font-weight: 600; font-size: var(--t-body); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 6px; }
  .sub { font-size: var(--t-ui); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); background: var(--bg3); border-radius: 4px; padding: 1px 4px; }
  .t-ok { border-left-color: var(--success); } .t-ok .ic { color: var(--success); }
  .t-run { border-left-color: var(--warn); } .t-run .ic { color: var(--warn); }
  .t-warn { border-left-color: var(--danger); } .t-warn .ic { color: var(--danger); }
  .t-bad { border-left-color: var(--danger); } .t-bad .ic { color: var(--danger); }
  .t-loop { border-left-color: var(--accent); } .t-loop .ic { color: var(--accent); }
  .t-idle { border-left-color: var(--border2); } .t-idle .ic { color: var(--muted); }
</style>
