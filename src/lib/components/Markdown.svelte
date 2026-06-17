<script>
  import { mdSegments } from '$lib/format.js';
  import CodeBlock from './CodeBlock.svelte';

  let { text = '' } = $props();
  const segs = $derived(mdSegments(text));
</script>

{#each segs as s, i (i)}
  {#if s.type === 'code'}
    <CodeBlock code={s.code} lang={s.lang} />
  {:else}
    <span class="md-text">{@html s.html}</span>
  {/if}
{/each}
