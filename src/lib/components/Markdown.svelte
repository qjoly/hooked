<script>
  import { mdSegments } from '$lib/format.js';
  import CodeBlock from './CodeBlock.svelte';
  import Mermaid from './Mermaid.svelte';
  import TerminalBlock from './TerminalBlock.svelte';
  import PtyBlock from './PtyBlock.svelte';
  import SessionCard from './SessionCard.svelte';

  let { text = '' } = $props();
  const segs = $derived(mdSegments(text));
</script>

{#each segs as s, i (i)}
  {#if s.type === 'code'}
    {#if s.lang === 'mermaid'}
      <Mermaid code={s.code} />
    {:else if s.lang === 'pty'}
      <!-- `!!commande` : terminal VIVANT dans le fil, pas un compte rendu figé (cf. PtyBlock). -->
      <PtyBlock code={s.code} meta={s.meta || {}} />
    {:else if s.lang === 'console'}
      <!-- transcription de terminal : compte rendu d'un `!commande` du composer, rendu comme un
           terminal plutôt que comme une citation de code (cf. TerminalBlock). -->
      <TerminalBlock code={s.code} meta={s.meta || {}} />
    {:else}
      <CodeBlock code={s.code} lang={s.lang} />
    {/if}
  {:else}
    <!-- un segment texte est une suite de sous-parties : html brut ({@html}) et liens de
         session rendus comme des cartes vivantes (<SessionCard>). -->
    {#each s.parts as p, j (j)}
      {#if p.type === 'session'}<SessionCard sessionId={p.id} label={p.label} />{:else}<span class="md-text">{@html p.html}</span>{/if}
    {/each}
  {/if}
{/each}
