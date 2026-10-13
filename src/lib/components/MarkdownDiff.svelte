<script>
  // Rendered view of a markdown diff (the Review lens's "rendered" toggle): the document as a
  // reader sees it, each block tinted and signed like the line diff. Read-only: comments, blame
  // and go-to-definition hang off source lines, so they stay in the source view.
  import { mdBlockDiff } from '$lib/mdDiff.js';
  import Markdown from '$lib/components/Markdown.svelte';

  let { oldStr = '', newStr = '' } = $props();
  const blocks = $derived(mdBlockDiff(oldStr, newStr));
</script>

<div class="mdd">
  {#each blocks as b, i (i)}
    <div class="mdd-block {b.kind}">
      <span class="mdd-sign" aria-hidden="true">{b.kind === 'add' ? '+' : b.kind === 'del' ? '−' : ''}</span>
      <!-- `md md-doc`: the global markdown skin (app.css), the file flavour of it -->
      <div class="mdd-body md md-doc"><Markdown text={b.text} breaks={false} /></div>
    </div>
  {:else}
    <div class="mdd-empty">Empty document.</div>
  {/each}
</div>

<style>
  .mdd { padding: 10px 0; font-size: var(--t-body); line-height: 1.6; color: var(--text); }
  .mdd-block { display: grid; grid-template-columns: 22px minmax(0, 1fr); padding: 3px 24px 3px 0; }
  .mdd-sign { text-align: center; user-select: none; font-family: var(--mono); font-weight: 700; }
  .mdd-block.add { background: rgba(var(--success-rgb), .13); box-shadow: inset 3px 0 0 var(--success); }
  .mdd-block.add .mdd-sign { color: var(--success); }
  .mdd-block.del { background: rgba(var(--danger-rgb), .12); box-shadow: inset 3px 0 0 var(--danger); }
  .mdd-block.del .mdd-sign { color: var(--danger); }
  /* A list item is rendered as a one-item list: without this, the list's own margins would
     space consecutive items like separate paragraphs. */
  .mdd-body :global(.md-text > ul), .mdd-body :global(.md-text > ol) { margin: 0; }
  .mdd-empty { padding: 4px 24px; color: var(--muted); font-style: italic; }
</style>
