<script>
  import { ago } from '$lib/format.js';
  import ToolChip from './ToolChip.svelte';
  import Markdown from './Markdown.svelte';
  let { m } = $props();

  // Style claude-cli : on rend les blocs dans l'ordre, et on distingue le DERNIER
  // bloc texte (réponse finale, contrasté) des précédents (raisonnement, discret).
  // Si parts est absent (vieux transcript en cache), on retombe sur text + tools.
  const parts = $derived(m.parts && m.parts.length
    ? m.parts
    : [
        ...(m.text ? [{ type: 'text', text: m.text }] : []),
        ...((m.tools || []).map((t) => ({ type: 'tool', tool: t }))),
      ]);
  const lastTextIdx = $derived.by(() => {
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type === 'text') return i;
    return -1;
  });
</script>

<div class="bubble {m.role}" data-msg-ts={m.ts || ''}>
  <div class="who">{m.role === 'user' ? '🧑 Toi' : '🤖 Claude'}<span class="t">{ago(m.ts)}</span></div>
  {#if m.role === 'user'}
    {#if m.text}<div class="md"><Markdown text={m.text} /></div>{/if}
  {:else}
    <div class="parts">
      {#each parts as p, i (i)}
        {#if p.type === 'text'}
          {#if i === lastTextIdx}
            <div class="md final"><Markdown text={p.text} /></div>
          {:else}
            <div class="md reasoning"><Markdown text={p.text} /></div>
          {/if}
        {:else}
          <div class="part-tool"><ToolChip t={p.tool} /></div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
