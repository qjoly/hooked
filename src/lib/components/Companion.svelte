<script>
  // A little dancing buddy floating above the whole UI. Drag it anywhere: the spot is kept per
  // browser (`ui.companionPos`) and re-clamped to the window, so shrinking it never strands the
  // companion off-screen. Until the first drag it sits in the bottom-right corner.
  //
  // The dance is a spritesheet — equally-sized frames laid out left to right — played by sliding
  // the strip behind a one-frame window with a CSS `steps()` animation: no JS loop, and a PNG
  // strip drops in just as well (update SHEET to match it).
  import { ui } from '$lib/state.svelte.js';
  import Icon from './Icon.svelte';
  import danceSheet from '$lib/assets/companion-dance.svg';

  const SHEET = { src: danceSheet, frames: 8, frameWidth: 20, frameHeight: 14, fps: 8 };
  const SCALE = 4;
  const WIDTH = SHEET.frameWidth * SCALE;
  const HEIGHT = SHEET.frameHeight * SCALE;
  const CORNER_MARGIN = 24;

  // app.css zooms <body> (`--app-zoom`), so left/top are zoomed pixels while the window size and
  // pointer coordinates are plain viewport pixels: everything is converted into the zoomed space.
  const zoom = parseFloat(getComputedStyle(document.body).zoom) || 1;
  let windowW = $state(window.innerWidth);
  let windowH = $state(window.innerHeight);
  const viewportW = $derived(windowW / zoom);
  const viewportH = $derived(windowH / zoom);
  const pointer = (e) => ({ x: e.clientX / zoom, y: e.clientY / zoom });

  const clampToViewport = ({ x, y }) => ({
    x: Math.max(0, Math.min(viewportW - WIDTH, x)),
    y: Math.max(0, Math.min(viewportH - HEIGHT, y)),
  });

  // Local while dragging, committed to `ui` on drop: `ui` is serialised to localStorage on every
  // change, which pointermove would otherwise trigger at frame rate.
  let pos = $state(ui.companionPos);
  const shown = $derived(clampToViewport(pos ?? {
    x: viewportW - WIDTH - CORNER_MARGIN,
    y: viewportH - HEIGHT - CORNER_MARGIN,
  }));

  let dragging = $state(false);
  let grabOffset = { x: 0, y: 0 };

  function grab(e) {
    if (e.button !== 0) return;
    const p = pointer(e);
    grabOffset = { x: p.x - shown.x, y: p.y - shown.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging = true;
  }

  function drag(e) {
    if (!dragging) return;
    const p = pointer(e);
    pos = clampToViewport({ x: p.x - grabOffset.x, y: p.y - grabOffset.y });
  }

  function drop() {
    if (!dragging) return;
    dragging = false;
    ui.companionPos = pos;
  }
</script>

<svelte:window bind:innerWidth={windowW} bind:innerHeight={windowH} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="companion" class:dragging title="Drag me around"
     style:left="{shown.x}px" style:top="{shown.y}px" style:width="{WIDTH}px" style:height="{HEIGHT}px"
     onpointerdown={grab} onpointermove={drag} onpointerup={drop} onpointercancel={drop}>
  <div class="frame">
    <img class="sheet" src={SHEET.src} alt="" draggable="false"
         style:--frames={SHEET.frames} style:--loop="{SHEET.frames / SHEET.fps}s" />
  </div>
  <!-- Stops the pointerdown so the click lands here instead of starting a drag, whose pointer
       capture would retarget it to the companion. -->
  <button class="hide" title="Hide companion (Settings → Appearance brings it back)" aria-label="Hide companion"
          onpointerdown={(e) => e.stopPropagation()} onclick={() => (ui.companion = false)}>
    <Icon name="close" size={11} />
  </button>
</div>

<style>
  .companion {
    position: fixed;
    /* Above popovers (40), below modals (50), lightboxes and the command palette. */
    z-index: 45;
    cursor: grab; touch-action: none; user-select: none;
    filter: drop-shadow(0 3px 3px rgb(0 0 0 / .22));
    transition: transform .12s, filter .12s;
  }
  .companion.dragging {
    cursor: grabbing;
    transform: scale(1.08);
    filter: drop-shadow(0 8px 8px rgb(0 0 0 / .28));
  }

  .frame { width: 100%; height: 100%; overflow: hidden; }
  .sheet {
    display: block; height: 100%; width: auto; max-width: none;
    image-rendering: pixelated;
    animation: dance var(--loop) steps(var(--frames)) infinite;
  }
  /* steps(n) lands on translateX(0), -1/n, …, -(n-1)/n of the strip: one stop per frame. */
  @keyframes dance { to { transform: translateX(-100%); } }
  @media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }

  .hide {
    position: absolute; top: -6px; right: -6px;
    width: 18px; height: 18px; padding: 0;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border2); border-radius: 50%;
    background: var(--bg2); color: var(--muted); cursor: pointer;
    box-shadow: var(--shadow-sm);
    opacity: 0; transition: opacity .12s;
  }
  .companion:hover .hide, .hide:focus-visible { opacity: 1; }
  .companion.dragging .hide { opacity: 0; }
  .hide:hover { color: var(--text); background: var(--hover); }
</style>
