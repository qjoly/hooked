<script>
  import { imageUrl } from '$lib/api.js';

  // `images` : absolute paths of images attached to the message (extracted by splitMessageImages).
  // Rendered as thumbnails; clicking one opens a full-size lightbox (Esc or click closes).
  let { images = [] } = $props();
  let zoom = $state(null);
  const name = (p) => p.slice(p.lastIndexOf('/') + 1);
  // a thumbnail that fails to load (image gone / not under the served dir) just hides itself.
  function hide(e) { const b = e.currentTarget.closest('.msg-img'); if (b) b.style.display = 'none'; }
</script>

{#if images.length}
  <div class="msg-imgs">
    {#each images as p}
      <button class="msg-img" title="{name(p)} — click to expand" onclick={() => (zoom = imageUrl(p))}>
        <img src={imageUrl(p)} alt={name(p)} loading="lazy" onerror={hide} />
      </button>
    {/each}
  </div>
{/if}

{#if zoom}
  <div class="lightbox" role="presentation" onclick={() => (zoom = null)}>
    <img class="lightbox-img" src={zoom} alt="" />
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && zoom) zoom = null; }} />

<style>
  .msg-imgs { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 6px; }
  .msg-img {
    padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2);
    cursor: zoom-in; overflow: hidden; line-height: 0; max-width: 220px;
  }
  .msg-img:hover { border-color: var(--accent); }
  .msg-img img { display: block; max-width: 220px; max-height: 160px; object-fit: contain; }

  .lightbox {
    position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.8); cursor: zoom-out; padding: 24px;
  }
  .lightbox-img { max-width: 96vw; max-height: 92vh; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
</style>
