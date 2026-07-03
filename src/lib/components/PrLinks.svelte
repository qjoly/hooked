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
        <div class="pr-card">
          <a class="pr-link" href={url} target="_blank" rel="noopener"
             onclick={(e) => e.stopPropagation()}>
            <span class="pr-header">
              <span class="pr-label">{prLabel(url)}</span>
              {#if meta}
                {#if meta.state}
                  <span class="pr-badge {stateClass(meta.state)}">{meta.state.toLowerCase()}</span>
                {/if}
                {#if meta.author}
                  <span class="pr-author">@{meta.author}</span>
                {/if}
              {/if}
            </span>
            {#if meta?.title}
              <span class="pr-title">{meta.title}</span>
            {/if}
            <span class="pr-url">{url}</span>
          </a>
          {#if meta?.body}
            <button class="pr-toggle" type="button"
                    onclick={(e) => { e.stopPropagation(); expanded[url] = !expanded[url]; }}>
              {expanded[url] ? '▾ Hide description' : '▸ Show description'}
            </button>
            {#if expanded[url]}
              <div class="pr-body"><Markdown text={meta.body} /></div>
            {/if}
          {/if}
        </div>
      </li>
    {/each}
  </ul>
{:else}
  <div class="pane-empty">No linked pull requests.</div>
{/if}

<style>
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
  }
  .pr-card {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bg2);
    border: 1px solid var(--border);
    min-width: 0;
    flex: 1;
  }
  .pr-link {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-decoration: none;
    min-width: 0;
  }
  .pr-card:hover {
    background: var(--bg3);
  }
  .pr-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .pr-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--fg);
  }
  .pr-badge {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: capitalize;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    color: #fff;
    background: var(--fg2);
  }
  .pr-badge.open { background: #2ea043; }
  .pr-badge.merged { background: #8957e5; }
  .pr-badge.closed { background: #cf222e; }
  .pr-author {
    font-size: 0.75rem;
    color: var(--fg2);
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
  .pr-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    margin-top: 0.15rem;
    font-size: 0.75rem;
    color: var(--accent, var(--fg2));
    cursor: pointer;
  }
  .pr-body {
    margin: 0.25rem 0 0;
    padding: 0.35rem 0.6rem;
    border-radius: 4px;
    background: var(--bg1, var(--bg));
    border: 1px solid var(--border);
    font-size: 0.8rem;
    color: var(--fg2);
    word-break: break-word;
    max-height: 20rem;
    overflow-y: auto;
  }
</style>
