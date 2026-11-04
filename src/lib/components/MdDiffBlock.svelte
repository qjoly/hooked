<script>
  // One block of a rendered markdown diff (see mdBlockDiff), tinted and signed like the line diff.
  // `level`: laid beside its source lines, where its first line must start on theirs.
  import Markdown from '$lib/components/Markdown.svelte';

  let { block, level = false } = $props();
</script>

<div class="mdd-block {block.kind}" class:level>
  <span class="mdd-sign" aria-hidden="true">{block.kind === 'add' ? '+' : block.kind === 'del' ? '−' : ''}</span>
  <!-- `md md-doc`: the global markdown skin (app.css), the file flavour of it -->
  <div class="mdd-body md md-doc"><Markdown text={block.text} breaks={false} /></div>
</div>

<style>
  /* The font is set here, not inherited: beside the source, the block sits inside the mono diff. */
  .mdd-block {
    display: grid; grid-template-columns: 22px minmax(0, 1fr); padding: 3px 24px 3px 0;
    font-family: var(--font); font-size: var(--t-body); line-height: 1.6; color: var(--text);
  }
  .mdd-sign { text-align: center; user-select: none; font-family: var(--mono); font-weight: 700; }
  .mdd-block.add { background: rgba(var(--success-rgb), .13); box-shadow: inset 3px 0 0 var(--success); }
  .mdd-block.add .mdd-sign { color: var(--success); }
  .mdd-block.del { background: rgba(var(--danger-rgb), .12); box-shadow: inset 3px 0 0 var(--danger); }
  .mdd-block.del .mdd-sign { color: var(--danger); }
  /* A list item is rendered as a one-item list: without this, the list's own margins would
     space consecutive items like separate paragraphs. */
  .mdd-body :global(.md-text > ul), .mdd-body :global(.md-text > ol) { margin: 0; }
  /* a heading's top margin would push it below its source line */
  .level .mdd-body :global(.md-text > :first-child) { margin-top: 0; }
</style>
