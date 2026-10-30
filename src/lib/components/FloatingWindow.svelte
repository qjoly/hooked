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
  // A window larger than the viewport would hide its own resize edges.
  const fit = () => { size.w = Math.min(size.w, vw()); size.h = Math.min(size.h, vh()); };

  function grab(e) {
    if (e.button !== 0 || e.target.closest('a,button')) return;
    grabOffset = { x: e.clientX / zoom - pos.x, y: e.clientY / zoom - pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  const drag = (e) => { if (grabOffset) pos = clamp({ x: e.clientX / zoom - grabOffset.x, y: e.clientY / zoom - grabOffset.y }); };
  const drop = () => { grabOffset = null; };

  // Resized from the sides and bottom corners; the top edge is the drag bar.
  const MIN = { w: 420, h: 240 };
  let size = $state(untrack(() => ({ w: width, h: height })));
  let resizing = $state(null); // { dir, x, y, w, h, left }
  function grabEdge(e, dir) {
    if (e.button !== 0) return;
    e.stopPropagation();
    resizing = { dir, x: e.clientX / zoom, y: e.clientY / zoom, w: size.w, h: size.h, left: pos.x };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function resize(e) {
    const r = resizing;
    if (!r) return;
    const dx = e.clientX / zoom - r.x, dy = e.clientY / zoom - r.y;
    if (r.dir.includes('e')) size.w = Math.max(MIN.w, Math.min(vw() - pos.x, r.w + dx));
    if (r.dir.includes('w')) {
      const w = Math.max(MIN.w, Math.min(r.left + r.w, r.w - dx));
      size.w = w;
      pos.x = r.left + r.w - w;
    }
    if (r.dir.includes('s')) size.h = Math.max(MIN.h, Math.min(vh() - pos.y, r.h + dy));
  }
  const release = () => { resizing = null; };
</script>

<svelte:window onresize={() => { fit(); pos = clamp(pos); }} />

<div class="win" style:left="{Math.max(0, pos.x)}px" style:top="{Math.max(0, pos.y)}px" style:width="{size.w}px" style:height="{size.h}px" class:resizing role="dialog">
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="bar" class:dragging={grabOffset} onpointerdown={grab} onpointermove={drag} onpointerup={drop} onpointercancel={drop}>
    <div class="ttl">{@render title()}</div>
    <button class="close" onclick={onclose} title="Close" aria-label="Close"><Icon name="close" size={12} /></button>
  </div>
  <div class="body">{@render children()}</div>
  {#each ['e', 'w', 's', 'se', 'sw'] as dir}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="edge {dir}" onpointerdown={(e) => grabEdge(e, dir)} onpointermove={resize} onpointerup={release} onpointercancel={release}></div>
  {/each}
</div>

<style>
  .win { position: fixed; z-index: 46; display: flex; flex-direction: column;
    background: var(--bg2); border: 1px solid var(--border2); border-radius: 12px; box-shadow: var(--shadow); font-size: var(--t-ui); }
  .bar { flex: none; display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 12px; border-bottom: 1px solid var(--border); cursor: grab; user-select: none; touch-action: none; }
  .bar.dragging { cursor: grabbing; }
  .ttl { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-weight: 700; overflow: hidden; }
  .close { flex: none; display: inline-flex; padding: 5px; border: none; border-radius: 7px; background: none; color: var(--muted); cursor: pointer; }
  .close:hover { background: var(--bg3); color: var(--text); }
  .body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 10px; padding: 10px 12px 12px; border-radius: 0 0 12px 12px; }
  .win.resizing { user-select: none; }
  .edge { position: absolute; z-index: 2; touch-action: none; }
  .edge.e, .edge.w { top: 12px; bottom: 12px; width: 8px; cursor: ew-resize; }
  .edge.e { right: -4px; }
  .edge.w { left: -4px; }
  .edge.s { left: 12px; right: 12px; bottom: -4px; height: 8px; cursor: ns-resize; }
  .edge.se, .edge.sw { bottom: -4px; width: 16px; height: 16px; }
  .edge.se { right: -4px; cursor: nwse-resize; }
  .edge.sw { left: -4px; cursor: nesw-resize; }
  /* A visible grip, so the corner reads as resizable. */
  .edge.se::after { content: ''; position: absolute; right: 7px; bottom: 7px; width: 8px; height: 8px;
    border-right: 2px solid var(--border2); border-bottom: 2px solid var(--border2); border-bottom-right-radius: 3px; }
</style>
