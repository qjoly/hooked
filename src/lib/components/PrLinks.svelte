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
            <div class="pr-right">
              {#if meta.state}<span class="pr-state s-{stateClass(meta.state)}">{meta.state}</span>{/if}
              {#if meta.author}<span class="pr-author">@{meta.author}</span>{/if}
            </div>
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
  .pr-list { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; gap: 10px; }
  .pr-row {
    display: flex; flex-direction: column; gap: 8px;
    padding: 15px 17px; border-radius: 12px;
    background: var(--card); border: 1px solid var(--border); min-width: 0;
  }
  .pr-head { display: flex; align-items: flex-start; gap: 12px; }
  /* NB: classe .pr-lnk (pas .pr-link) — un .pr-link GLOBAL existe dans app.css (chips PR du
     header de conversation) et fuirait ici (align-items:center → texte centré). */
  .pr-lnk { display: flex; flex-direction: column; gap: 3px; text-decoration: none; min-width: 0; flex: 1; }
  .pr-label { font-weight: 700; font-size: 13.5px; color: var(--accent); }
  .pr-lnk:hover .pr-label { text-decoration: underline; }
  .pr-title { font-size: 13.5px; color: var(--text); }
  .pr-url { font-family: var(--mono); font-size: 11.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pr-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: 0 0 auto; }
  .pr-state {
    font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    padding: 2px 9px; border-radius: 20px; color: #fff; background: #6b7280;
  }
  .pr-state.s-open { background: #2a9d63; }
  .pr-state.s-merged { background: #8250df; }
  .pr-state.s-closed { background: #cf222e; }
  .pr-author { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .pr-muted { font-size: 11.5px; color: var(--muted); }
  .pr-toggle {
    align-self: flex-start; background: none; border: none; color: var(--accent);
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0;
  }
  .pr-toggle:hover { text-decoration: underline; }
  .pr-body {
    margin: 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
    font-size: 12.5px; line-height: 1.65; color: var(--text); word-break: break-word;
    max-height: 320px; overflow: auto; white-space: pre-wrap;
  }
</style>
