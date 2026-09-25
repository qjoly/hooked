<script>
  import Lightbox from './Lightbox.svelte';
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

<Lightbox src={zoom} onclose={() => (zoom = null)} />

<style>
  .msg-imgs { display: flex; flex-wrap: wrap; gap: 8px; margin: 2px 0 6px; }
  .msg-img {
    padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2);
    cursor: zoom-in; overflow: hidden; line-height: 0; max-width: 220px;
  }
  .msg-img:hover { border-color: var(--accent); }
  .msg-img img { display: block; max-width: 220px; max-height: 160px; object-fit: contain; }

</style>
