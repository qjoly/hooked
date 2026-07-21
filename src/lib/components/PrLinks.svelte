<script>
  import { prLabel } from '$lib/format.js';
  import Markdown from './Markdown.svelte';
  let { prLinks = [] } = $props();

  // url -> { loading, meta } — meta is null when gh is unavailable/unauthenticated.
  let metaByUrl = $state({});
  let expanded = $state({});

  async function loadMeta(url) {
    metaByUrl[url] = { loading: true, meta: null };
    try {
      const res = await fetch(`/api/gh?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      metaByUrl[url] = { loading: false, meta: data?.data ?? null };
    } catch {
      metaByUrl[url] = { loading: false, meta: null };
    }
  }

  // Re-fetch whenever the set of PR links changes.
  $effect(() => {
    for (const url of prLinks) {
      if (!metaByUrl[url]) loadMeta(url);
    }
  });

  function stateClass(state) {
    const s = String(state || '').toUpperCase();
    if (s === 'MERGED') return 'merged';
    if (s === 'CLOSED') return 'closed';
    if (s === 'OPEN') return 'open';
    return '';
  }
</script>

{#if prLinks.length}
  <ul class="pr-list">
    {#each prLinks as url (url)}
      {@const entry = metaByUrl[url]}
      {@const meta = entry?.meta}
      <li class="pr-row">
        <div class="pr-head">
          <a class="pr-lnk" href={url} target="_blank" rel="noopener"
             onclick={(e) => e.stopPropagation()}>
            <span class="pr-label">{prLabel(url)}</span>
            {#if meta?.title}<span class="pr-title">{meta.title}</span>{/if}
            <span class="pr-url">{url}</span>
          </a>
          {#if meta}
            {#if meta.state}<span class="pr-state s-{stateClass(meta.state)}">{meta.state}</span>{/if}
            {#if meta.author}<span class="pr-author">@{meta.author}</span>{/if}
          {:else if entry?.loading}
            <span class="pr-muted">…</span>
          {/if}
        </div>
        {#if meta?.body}
          <button class="pr-toggle" type="button"
                  onclick={(e) => { e.stopPropagation(); expanded[url] = !expanded[url]; }}>
            {expanded[url] ? '▾ Hide description' : '▸ Show description'}
          </button>
          {#if expanded[url]}<div class="pr-body"><Markdown text={meta.body} /></div>{/if}
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <div class="pane-empty">No linked pull requests.</div>
{/if}

<style>
  /* Aligné sur l'onglet Issues (IssueLinks.svelte) : même carte, même en-tête, mêmes badges. */
  .pr-list {
    list-style: none;
    margin: 0;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pr-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bg2);
    border: 1px solid var(--border);
    min-width: 0;
  }
  .pr-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  /* NB: classe .pr-lnk (pas .pr-link) — un .pr-link GLOBAL existe dans app.css (chips PR du
     header de conversation) et fuirait ici (align-items:center → texte centré). */
  .pr-lnk {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-decoration: none;
    min-width: 0;
    flex: 1;
  }
  .pr-lnk:hover .pr-label { text-decoration: underline; }
  .pr-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--fg);
  }
  .pr-title {
    font-size: 0.85rem;
    color: var(--fg);
  }
  .pr-url {
    font-size: 0.75rem;
    color: var(--fg2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pr-state {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 1px 8px;
    border-radius: 20px;
    color: #fff;
    background: var(--muted);
  }
  .pr-state.s-open { background: #2da44e; }   /* open → green */
  .pr-state.s-merged { background: #8250df; } /* merged → purple */
  .pr-state.s-closed { background: #cf222e; } /* closed → red */
  .pr-author {
    font-size: 0.75rem;
    color: var(--fg2);
  }
  .pr-muted { font-size: 0.75rem; color: var(--fg2); }
  .pr-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--accent-d);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
  }
  .pr-body {
    margin: 0;
    padding: 0.35rem 0.75rem;
    background: var(--bg3);
    border-radius: 6px;
    font-size: 0.8rem;
    color: var(--fg);
    word-break: break-word;
    max-height: 320px;
    overflow: auto;
  }
</style>
