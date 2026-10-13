<script>
  import { mdSegments, isCommandTranscript } from '$lib/format.js';
  import CodeBlock from './CodeBlock.svelte';
  import Mermaid from './Mermaid.svelte';
  import TerminalBlock from './TerminalBlock.svelte';
  import PtyBlock from './PtyBlock.svelte';
  import SessionCard from './SessionCard.svelte';

  // breaks: a single newline becomes a <br> (chat). Pass false for a document (see mdSegments).
  let { text = '', breaks = true } = $props();
  const segs = $derived(mdSegments(text, { breaks }));
</script>

{#each segs as s, i (i)}
  {#if s.type === 'code'}
    {#if s.lang === 'mermaid'}
      <Mermaid code={s.code} />
    {:else if s.lang === 'pty'}
      <!-- `!!commande` : terminal VIVANT dans le fil, pas un compte rendu figé (cf. PtyBlock). -->
      <PtyBlock code={s.code} meta={s.meta || {}} />
    {:else if isCommandTranscript(s)}
      <!-- terminal transcript: the report of a composer `!command` (stamped `exit=` by hooked), rendered
           as a terminal rather than a code quote (cf. TerminalBlock). A plain ```console block written
           by Claude has no such marker and falls through to CodeBlock. -->
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
