<script>
  // Rendered view of a markdown diff (the Review lens's "rendered" toggle, when there is no room
  // beside the source): the document as a reader sees it, each block tinted and signed like the
  // line diff. Read-only: comments, blame and go-to-definition hang off source lines, so they stay
  // in the source view.
  import { mdBlockDiff } from '$lib/mdDiff.js';
  import MdDiffBlock from '$lib/components/MdDiffBlock.svelte';

  let { oldStr = '', newStr = '' } = $props();
  const blocks = $derived(mdBlockDiff(oldStr, newStr));
</script>

<div class="mdd">
  {#each blocks as b, i (i)}
    <MdDiffBlock block={b} />
  {:else}
    <div class="mdd-empty">Empty document.</div>
  {/each}
</div>

<style>
  .mdd { padding: 10px 0; }
  .mdd-empty { padding: 4px 24px; color: var(--muted); font-style: italic; }
</style>
