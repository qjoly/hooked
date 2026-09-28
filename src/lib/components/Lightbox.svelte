<script>
  // Full-size image overlay shared by every thumbnail strip (message images, files Claude sent,
  // screenshots). `src` null = closed. A click anywhere or Esc closes through `onclose`; `children`
  // (optional) renders a caption bar below the image, in the caller's own styles.
  let { src = null, alt = '', onclose = null, children = null } = $props();
</script>

{#if src}
  <div class="lightbox" role="presentation" onclick={() => onclose?.()}>
    <img class="lightbox-img" {src} {alt} />
    {#if children}{@render children()}{/if}
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (src && e.key === 'Escape') { e.preventDefault(); onclose?.(); } }} />

<style>
  .lightbox {
    position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; background: rgba(0, 0, 0, 0.85); cursor: zoom-out; padding: 24px;
  }
  .lightbox-img { max-width: 94vw; max-height: 86vh; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
</style>
