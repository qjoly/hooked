<script>
  // A draggable, resizable window above the whole UI (no backdrop, the page stays usable).
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';

  let { title, onclose, children, width = 760, height = 520, corner = 'right' } = $props();

  // Same drag as the companion: app.css zooms <body>, so pointer and viewport sizes are converted.
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  const MARGIN = 24;
  const vw = () => window.innerWidth / zoom;
  const vh = () => window.innerHeight / zoom;
  // Opened in a bottom corner; the props only seed the first position.
  let pos = $state(untrack(() => ({ x: corner === 'left' ? MARGIN : vw() - width - MARGIN, y: vh() - height - MARGIN })));
  let grabOffset = $state(null);
  const clamp = ({ x, y }) => ({ x: Math.max(0, Math.min(vw() - 120, x)), y: Math.max(0, Math.min(vh() - 40, y)) });

  function grab(e) {
    if (e.button !== 0 || e.target.closest('a,button')) return;
    grabOffset = { x: e.clientX / zoom - pos.x, y: e.clientY / zoom - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  const drag = (e) => { if (grabOffset) pos = clamp({ x: e.clientX / zoom - grabOffset.x, y: e.clientY / zoom - grabOffset.y }); };
  const drop = () => { grabOffset = null; };
</script>

<svelte:window onresize={() => (pos = clamp(pos))} />

<div class="win" style:left="{Math.max(0, pos.x)}px" style:top="{Math.max(0, pos.y)}px" style:width="{width}px" style:height="{height}px" role="dialog">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="bar" class:dragging={grabOffset} onpointerdown={grab} onpointermove={drag} onpointerup={drop} onpointercancel={drop}>
    <div class="ttl">{@render title()}</div>
    <button class="close" onclick={onclose} title="Close" aria-label="Close"><Icon name="close" size={12} /></button>
  </div>
  <div class="body">{@render children()}</div>
</div>

<style>
  .win { position: fixed; z-index: 46; min-width: 420px; min-height: 240px; max-width: 96vw; max-height: 92vh;
    resize: both; overflow: hidden; display: flex; flex-direction: column;
    background: var(--bg2); border: 1px solid var(--border2); border-radius: 12px; box-shadow: var(--shadow); font-size: var(--t-ui); }
  .bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--border); cursor: grab; user-select: none; touch-action: none; }
  .bar.dragging { cursor: grabbing; }
  .ttl { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-weight: 700; overflow: hidden; }
  .close { flex: none; display: inline-flex; padding: 5px; border: none; border-radius: 7px; background: none; color: var(--muted); cursor: pointer; }
  .close:hover { background: var(--bg3); color: var(--text); }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; }
</style>
