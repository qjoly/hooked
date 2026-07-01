<script>
  import { mdSegments } from '$lib/format.js';
  import CodeBlock from './CodeBlock.svelte';
  import SessionCard from './SessionCard.svelte';

  let { text = '' } = $props();
  const segs = $derived(mdSegments(text));
</script>

{#each segs as s, i (i)}
  {#if s.type === 'code'}
    <CodeBlock code={s.code} lang={s.lang} />
  {:else}
    <!-- un segment texte est une suite de sous-parties : html brut ({@html}) et liens de
         session rendus comme des cartes vivantes (<SessionCard>). -->
    {#each s.parts as p, j (j)}
      {#if p.type === 'session'}<SessionCard sessionId={p.id} label={p.label} />{:else}<span class="md-text">{@html p.html}</span>{/if}
    {/each}
  {/if}
{/each}
