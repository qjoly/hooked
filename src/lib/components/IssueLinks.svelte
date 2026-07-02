<script>
  import { issueLabel } from '$lib/format.js';
  import Markdown from './Markdown.svelte';
  let { issueLinks = [] } = $props();

  // Enrichissement gh par URL : { loading } | { data: {title,state,author,body} | null }.
  // Chargé paresseusement au montage/à tout changement de la liste ; échec gh → data null (fallback).
  let meta = $state({});
  let expanded = $state({}); // URLs dont la description est dépliée

  $effect(() => {
    const urls = issueLinks; // dépendance suivie AVANT toute garde (règle réactivité Svelte 5)
    for (const url of urls) {
      if (meta[url]) continue;
      meta[url] = { loading: true };
      fetch('/api/gh?url=' + encodeURIComponent(url))
        .then((r) => r.json())
        .then((j) => { meta[url] = { data: j?.data ?? null }; })
        .catch(() => { meta[url] = { data: null }; });
    }
  });

  function toggle(url) { expanded[url] = !expanded[url]; }
</script>

{#if issueLinks.length}
  <ul class="issue-list">
    {#each issueLinks as url (url)}
      {@const m = meta[url]}
      {@const d = m && m.data}
      <li class="issue-row">
        <div class="issue-head">
          <a class="issue-link" href={url} target="_blank" rel="noopener"
             onclick={(e) => e.stopPropagation()}>
            <span class="issue-label">{issueLabel(url)}</span>
            {#if d}<span class="issue-title">{d.title}</span>{/if}
            <span class="issue-url">{url}</span>
          </a>
          {#if d}
            <span class="issue-state s-{(d.state || '').toLowerCase()}">{d.state}</span>
            {#if d.author}<span class="issue-author">@{d.author}</span>{/if}
          {:else if m && m.loading}
            <span class="issue-muted">…</span>
          {/if}
        </div>
        {#if d && d.body}
          <button class="issue-toggle" onclick={() => toggle(url)}>
            {expanded[url] ? '▾ Hide description' : '▸ Show description'}
          </button>
          {#if expanded[url]}<div class="issue-body"><Markdown text={d.body} /></div>{/if}
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <div class="pane-empty">No linked issues.</div>
{/if}

<style>
  .issue-list {
    list-style: none;
    margin: 0;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .issue-row {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bg2);
    border: 1px solid var(--border);
    min-width: 0;
  }
  .issue-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .issue-link {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    text-decoration: none;
    min-width: 0;
    flex: 1;
  }
  .issue-link:hover .issue-label { text-decoration: underline; }
  .issue-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--fg);
  }
  .issue-title {
    font-size: 0.85rem;
    color: var(--fg);
  }
  .issue-url {
    font-size: 0.75rem;
    color: var(--fg2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .issue-state {
    font-size: 0.7rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    padding: 1px 8px;
    border-radius: 20px;
    color: #fff;
    background: var(--muted);
  }
  .issue-state.s-open { background: #2da44e; }   /* open → green */
  .issue-state.s-closed { background: #8250df; } /* closed → purple */
  .issue-author {
    font-size: 0.75rem;
    color: var(--fg2);
  }
  .issue-muted { font-size: 0.75rem; color: var(--fg2); }
  .issue-toggle {
    align-self: flex-start;
    background: none;
    border: none;
    color: var(--accent-d);
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0;
  }
  .issue-body {
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
