<script>
  import { ago } from '$lib/format.js';
  import ToolChip from './ToolChip.svelte';
  import Markdown from './Markdown.svelte';
  // Fork (uniquement si le message a un point de coupe `forkUuid`) :
  //   `onfork(m)`         = fork express en 1 clic — aucune saisie, modèle/effort de la
  //                         session, branche indépendante qui attend (pas de modale).
  //   `onforkadvanced(m)` = ouvre la modale avancée (modèle/effort/message immédiat).
  //   `forkState`         = retour inline du fork express en cours pour CE message
  //                         ({ uuid, phase: 'busy'|'done'|'err', text }).
  // Tout absent pour les traces de sous-agents (non reprenables).
  let { m, onfork = null, onforkadvanced = null, forkState = null } = $props();

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
  <div class="who">{m.role === 'user' ? '🧑 You' : '🤖 Claude'}<span class="t">{ago(m.ts)}</span>
    {#if onfork && m.forkUuid}
      <span class="fork-ctl">
        <button class="fork-btn fork-main" title="Fork here without a message — independent branch waiting for you"
                onclick={() => onfork(m)}>⑂ Fork</button>
        {#if onforkadvanced}
          <button class="fork-btn fork-caret" aria-label="Fork options"
                  title="Fork options (model, effort, immediate message…)"
                  onclick={() => onforkadvanced(m)}>▾</button>
        {/if}
      </span>
      {#if forkState && forkState.uuid === m.forkUuid}
        <span class="fork-state {forkState.phase}">{forkState.text}</span>
      {/if}
    {/if}
  </div>
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
          <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} /></div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
