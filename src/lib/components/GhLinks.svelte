<script>
  import { prLabel, issueLabel } from '$lib/format.js';
  import { ghMeta } from '$lib/prState.svelte.js';
  import Markdown from './Markdown.svelte';

  // Pull requests or issues linked from a session, enriched with GitHub metadata (title, state,
  // author, review decision, description). `kind` picks the label and the state palette; the
  // metadata comes from the shared gh cache, so the dock pills and this card never fetch a URL twice.
  let { links = [], kind = 'pr' } = $props();
  let expanded = $state({}); // url → description unfolded

  const label = (url) => (kind === 'pr' ? prLabel(url) : issueLabel(url));
  // Closed is red for a PR (dropped) but purple for an issue (resolved), like on GitHub.
  function stateClass(state) {
    const s = String(state || '').toUpperCase();
    if (s === 'OPEN') return 'open';
    if (s === 'MERGED') return 'merged';
    if (s === 'CLOSED') return kind === 'pr' ? 'closed' : 'merged';
    return '';
  }
  const REVIEW = {
    APPROVED: ['approved', 'Approved'],
    CHANGES_REQUESTED: ['changes', 'Changes requested'],
    REVIEW_REQUIRED: ['pending', 'Review required'],
  };
  const review = (rd) => REVIEW[String(rd || '').toUpperCase()] || null;
</script>

{#if links.length}
  <ul class="gh-list">
    {#each links as url (url)}
      {@const m = ghMeta(url)}
      {@const d = m.data}
      <li class="gh-row">
        <div class="gh-head">
          <a class="gh-lnk" href={url} target="_blank" rel="noopener" onclick={(e) => e.stopPropagation()}>
            <span class="gh-label">{label(url)}</span>
            {#if d?.title}<span class="gh-title">{d.title}</span>{/if}
            <span class="gh-url">{url}</span>
          </a>
          {#if d}
            <div class="gh-right">
              {#if d.state}<span class="gh-state s-{stateClass(d.state)}">{d.state}</span>{/if}
              {#if kind === 'pr' && review(d.reviewDecision)}<span class="gh-state r-{review(d.reviewDecision)[0]}">{review(d.reviewDecision)[1]}</span>{/if}
              {#if d.author}<span class="gh-author">@{d.author}</span>{/if}
            </div>
          {:else if m.loading}
            <span class="gh-muted">…</span>
          {/if}
        </div>
        {#if d?.body}
          <button class="gh-toggle" type="button" onclick={(e) => { e.stopPropagation(); expanded[url] = !expanded[url]; }}>
            {expanded[url] ? '▾ Hide description' : '▸ Show description'}
          </button>
          {#if expanded[url]}<div class="gh-body"><Markdown text={d.body} /></div>{/if}
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <div class="pane-empty">{kind === 'pr' ? 'No linked pull requests.' : 'No linked issues.'}</div>
{/if}

<style>
  .gh-list { list-style: none; margin: 0; padding: 4px 0; display: flex; flex-direction: column; gap: 10px; }
  .gh-row {
    display: flex; flex-direction: column; gap: 8px;
    padding: 15px 17px; border-radius: 12px;
    background: var(--card); border: 1px solid var(--border); min-width: 0;
  }
  .gh-head { display: flex; align-items: flex-start; gap: 12px; }
  .gh-lnk { display: flex; flex-direction: column; gap: 3px; text-decoration: none; min-width: 0; flex: 1; }
  .gh-label { font-weight: 700; font-size: var(--t-body); color: var(--accent); }
  .gh-lnk:hover .gh-label { text-decoration: underline; }
  .gh-title { font-size: var(--t-body); color: var(--text); }
  .gh-url { font-family: var(--mono); font-size: var(--t-meta); color: var(--accent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gh-right { display: flex; flex-direction: column; align-items: flex-end; gap: 5px; flex: 0 0 auto; }
  .gh-state {
    font-family: var(--mono); font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .03em;
    padding: 2px 9px; border-radius: 20px; color: #fff; background: #6b7280;
  }
  .gh-state.s-open, .gh-state.r-approved { background: #2a9d63; }
  .gh-state.s-merged { background: #8250df; }
  .gh-state.s-closed, .gh-state.r-changes { background: #cf222e; }
  .gh-state.r-pending { background: #9a6700; }
  .gh-author { font-family: var(--mono); font-size: var(--t-meta); color: var(--muted); }
  .gh-muted { font-size: var(--t-meta); color: var(--muted); }
  .gh-toggle {
    align-self: flex-start; background: none; border: none; color: var(--accent);
    font: inherit; font-size: var(--t-meta); font-weight: 600; cursor: pointer; padding: 0;
  }
  .gh-toggle:hover { text-decoration: underline; }
  .gh-body {
    margin: 0; padding: 12px 14px; background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
    font-size: var(--t-ui); line-height: 1.65; color: var(--text); word-break: break-word;
    max-height: 320px; overflow: auto; white-space: pre-wrap;
  }
</style>
