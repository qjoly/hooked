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
            <div class="issue-right">
              <span class="issue-state s-{(d.state || '').toLowerCase()}">{d.state}</span>
              {#if d.author}<span class="issue-author">@{d.author}</span>{/if}
            </div>
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
  .issue-list { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; gap: 10px; }
  .issue-row {
    display: flex; flex-direction: column; gap: 8px;
    padding: 15px 17px; border-radius: 12px;
    background: var(--card); border: 1px solid var(--border); min-width: 0;
  }
  .issue-head { display: flex; align-items: flex-start; gap: 12px; }
  .issue-link { display: flex; flex-direction: column; gap: 3px; text-decoration: none; min-width: 0; flex: 1; }
  .issue-label { font-weight: 700; font-size: 13.5px; color: var(--accent); }
  .issue-link:hover .issue-label { text-decoration: underline; }
  .issue-title { font-size: 13.5px; color: var(--text); }
  .issue-url { font-family: var(--mono); font-size: 11.5px; color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .issue-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: 0 0 auto; }
  .issue-state {
    font-family: var(--mono); font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    padding: 2px 9px; border-radius: 20px; color: #fff; background: #6b7280;
  }
  .issue-state.s-open { background: #2a9d63; }
  .issue-state.s-closed { background: #8250df; }
  .issue-author { font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
  .issue-muted { font-size: 11.5px; color: var(--muted); }
  .issue-toggle {
    align-self: flex-start; background: none; border: none; color: var(--accent);
    font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; padding: 0;
  }
  .issue-toggle:hover { text-decoration: underline; }
  .issue-body {
    margin: 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
    font-size: 12.5px; line-height: 1.65; color: var(--text); word-break: break-word;
    max-height: 320px; overflow: auto; white-space: pre-wrap;
  }
</style>
