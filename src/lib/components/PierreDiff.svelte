<script>
  /*
   * Renders a diff via @pierre/diffs (Shiki). The library is browser-only (customElements,
   * HTMLElement) and heavy (Shiki) → dynamic import in onMount + lazy mount by the caller.
   * The diff `<pre>` lives in the shadow root of <diffs-container> (the library's stylesheet is
   * adopted there, theme driven via setThemeType since `data-theme` does not cascade into shadow).
   *
   * `oldStr`/`newStr` = raw contents; pass old='' for a new file (Write/notebook).
   * `name` infers the highlighting language. `diffStyle`: 'split' or 'unified'.
   */
  import { onMount } from 'svelte';
  import { themeType } from '$lib/theme.svelte.js';

  let { oldStr = '', newStr = '', name = 'file.txt', diffStyle = 'unified' } = $props();

  const THEME = { dark: 'pierre-dark', light: 'pierre-light' };

  let host;               // host <div> (bind:this)
  let container = null;   // <diffs-container>
  let fd = null;          // FileDiff instance
  let ready = $state(false);

  const baseOptions = (tt) => ({
    diffStyle,
    disableFileHeader: true, // hooked already shows the file name above
    overflow: 'wrap',
    theme: THEME,
    themeType: tt,
  });

  onMount(() => {
    let alive = true;
    (async () => {
      const [{ FileDiff }] = await Promise.all([
        import('@pierre/diffs'),
        import('@pierre/diffs/web-components'), // side effect: registers <diffs-container> (vite alias)
      ]);
      if (!alive || !host) return;
      container = document.createElement('diffs-container');
      host.appendChild(container);
      fd = new FileDiff(baseOptions(themeType()));
      fd.hydrate({
        fileContainer: container,
        oldFile: { name, contents: oldStr ?? '' },
        newFile: { name, contents: newStr ?? '' },
      });
      ready = true;
    })();
    return () => {
      alive = false;
      try { fd?.cleanUp?.(); } catch (_) {}
      fd = null;
      if (container?.parentNode) container.parentNode.removeChild(container);
      container = null;
    };
  });

  // Re-render when content or style changes (read the deps BEFORE the `ready` guard).
  // setOptions merges → the theme set at construction is preserved.
  $effect(() => {
    const o = { name, contents: oldStr ?? '' };
    const n = { name, contents: newStr ?? '' };
    const ds = diffStyle;
    if (!ready || !fd) return;
    fd.setOptions({ diffStyle: ds, disableFileHeader: true, overflow: 'wrap', theme: THEME });
    fd.render({ oldFile: o, newFile: n, forceRender: true });
  });

  // Theme toggle only (cheap, no diff re-parse).
  $effect(() => {
    const tt = themeType();
    if (ready && fd) fd.setThemeType(tt);
  });
</script>

<div class="pierre-diff" bind:this={host}></div>
