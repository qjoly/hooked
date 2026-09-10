<script>
  import { screenshotUrl } from '$lib/api.js';

  // `shots`: [{ path, name, ts, size }] — images read or written by the session (cf.
  // server/screenshots.js). Thumbnails; clicking one opens a lightbox navigable with ← / →.
  // `limit` caps the THUMBNAILS only (collapsed dock card): the lightbox always walks the whole
  // list, so navigating with the arrows is not silently truncated to the visible four.
  let { shots = [], session, limit = 0 } = $props();
  const thumbs = $derived(limit ? shots.slice(0, limit) : shots);
  let zoom = $state(-1);
  const url = (s) => screenshotUrl(session, s.path);
  // a thumbnail whose file is gone (temp dir cleaned since the transcript was written) hides itself.
  function hide(e) { const b = e.currentTarget.closest('.shot'); if (b) b.style.display = 'none'; }
  function step(d) {
    if (zoom < 0) return;
    zoom = (zoom + d + shots.length) % shots.length;
  }
  function onkey(e) {
    if (zoom < 0) return;
    if (e.key === 'Escape') zoom = -1;
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }
</script>

<div class="shots">
  {#each thumbs as s, i}
    <button class="shot" title="{s.name} — click to expand" onclick={() => (zoom = i)}>
      <img src={url(s)} alt={s.name} loading="lazy" onerror={hide} />
      <span class="shot-name">{s.name}</span>
    </button>
  {/each}
</div>

{#if zoom >= 0 && shots[zoom]}
  <div class="lightbox" role="presentation" onclick={() => (zoom = -1)}>
    <img class="lightbox-img" src={url(shots[zoom])} alt={shots[zoom].name} />
    <div class="lightbox-bar">
      {shots[zoom].name} · {zoom + 1}/{shots.length}
      <a href={url(shots[zoom])} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>open</a>
    </div>
  </div>
{/if}

<svelte:window onkeydown={onkey} />

<style>
  /* grid (pas flex-wrap) : la largeur du dock est réglable, deux colonnes restent lisibles et
     ne dépendent pas d'un max-width qui basculait à une colonne selon la place restante. */
  .shots { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 2px 14px 11px; }
  .shot {
    padding: 0; border: 1px solid var(--border); border-radius: 6px; background: var(--bg3);
    cursor: zoom-in; overflow: hidden; line-height: 0; min-width: 0;
  }
  .shot:hover { border-color: var(--accent); }
  .shot img { display: block; width: 100%; height: 74px; object-fit: cover; }
  .shot-name {
    display: block; padding: 3px 5px; font: 10px var(--mono); color: var(--muted);
    line-height: 1.3; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    direction: rtl;
  }

  .lightbox {
    position: fixed; inset: 0; z-index: 200; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; background: rgba(0, 0, 0, 0.85); cursor: zoom-out; padding: 24px;
  }
  .lightbox-img { max-width: 94vw; max-height: 86vh; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
  .lightbox-bar { font: 11px var(--mono); color: #ddd; display: flex; gap: 10px; align-items: center; }
  .lightbox-bar a { color: #9cf; }
</style>
