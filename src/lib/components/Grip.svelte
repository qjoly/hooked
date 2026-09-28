<script>
  // Drag handle for the Review lens layout: drag to resize the neighbouring
  // rail, double-click to restore the default, ←/→ to nudge by `step` when focused. The width
  // itself lives in the caller (usually a persisted `ui` field) — the grip only reads `value`
  // and hands back a clamped one through `set`. `invert` is for a RIGHT-hand rail, which grows
  // when the pointer moves LEFT. Its look lives in app.css (`.ship-grip`) so the lens
  // stylesheets can hide it alongside the rail it resizes.
  let { value, set, def, min = 150, max = 620, invert = false, step = 16, label = 'Resize' } = $props();

  const clamp = (w) => Math.max(min, Math.min(max, w));
  const delta = (d) => (invert ? -d : d);

  function startResize(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const startX = e.clientX, startW = value;
    const move = (ev) => set(clamp(startW + delta(ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function nudge(e) {
    const d = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    if (!d) return;
    e.preventDefault();
    set(clamp(value + delta(d)));
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
<div class="ship-grip" role="separator" aria-label={label} aria-orientation="vertical"
     tabindex="0" title="Drag to resize · double-click to reset"
     onpointerdown={startResize} ondblclick={() => set(def)} onkeydown={nudge}></div>
