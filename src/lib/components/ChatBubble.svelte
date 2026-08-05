<script>
  import { ago, splitMessageImages } from '$lib/format.js';
  import ToolChip from './ToolChip.svelte';
  import Markdown from './Markdown.svelte';
  import MessageImages from './MessageImages.svelte';
  // Fork (uniquement si le message a un point de coupe `forkUuid`) :
  //   `onfork(m)`         = fork express en 1 clic — aucune saisie, modèle/effort de la
  //                         session, branche indépendante qui attend (pas de modale).
  //   `onforkadvanced(m)` = ouvre la modale avancée (modèle/effort/message immédiat).
  //   `forkState`         = retour inline du fork express en cours pour CE message
  //                         ({ uuid, phase: 'busy'|'done'|'err', text }).
  // Tout absent pour les traces de sous-agents (non reprenables).
  // `session` / `agent` : identifiants pour servir les fichiers SendUserFile (cf. userFileUrl).
  // `agent` non nul quand la bulle appartient au déroulé d'un sous-agent (SubagentCard).
  let { m, onfork = null, onforkadvanced = null, forkState = null, session = null, agent = null } = $props();

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
  // A text block renders as the contrasted "final" answer only if it's the last one; earlier
  // blocks are dimmed as reasoning. Exception: text that directly precedes a hand-back-to-user
  // tool (AskUserQuestion / ExitPlanMode) is the lead-in to that prompt, not reasoning — keep it
  // full-contrast. Without this it dims the instant the turn continues after you answer (the
  // lead-in stops being the last text block once the reply is appended to the same bubble).
  const HANDOFF_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);
  const isFinalText = (i) => i === lastTextIdx
    || (parts[i + 1]?.type === 'tool' && HANDOFF_TOOLS.has(parts[i + 1].tool?.name));
  // user message: pasted images are stored as absolute paths prefixed to the text → render them as
  // expandable thumbnails and drop the raw paths from the displayed text.
  const userMsg = $derived(m.role === 'user' ? splitMessageImages(m.text) : null);
</script>

{#if m.role === 'system'}
  <div class="sysline" class:bg={m.kind === 'bg'} data-msg-ts={m.ts || ''}>
    <span class="sys-txt">{m.kind === 'bg' ? '🌀 ' : ''}{m.text}</span>
    <span class="t">{ago(m.ts)}</span>
  </div>
{:else}
<div class="bubble {m.role}" class:auto={m.auto} data-msg-ts={m.ts || ''}>
  <div class="who">{m.role === 'user' ? (m.auto ? '↻ Auto-resumed (background job)' : '🧑 You') : '🤖 Claude'}<span class="t">{ago(m.ts)}</span>
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
    {#if userMsg.images.length}<MessageImages images={userMsg.images} />{/if}
    {#if userMsg.text}<div class="md"><Markdown text={userMsg.text} /></div>{/if}
  {:else}
    <div class="parts">
      {#each parts as p, i (i)}
        {#if p.type === 'text'}
          {#if isFinalText(i)}
            <div class="md final"><Markdown text={p.text} /></div>
          {:else}
            <div class="md reasoning"><Markdown text={p.text} /></div>
          {/if}
        {:else}
          <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} ask={p.ask} send={p.send} {session} {agent} /></div>
        {/if}
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  /* ligne système sobre, centrée — notification de tâche de fond (queued_command) dans le fil. */
  .sysline {
    display: flex; align-items: baseline; gap: 8px; justify-content: center;
    margin: 4px auto; padding: 4px 12px; max-width: 90%;
    font-size: 12px; color: var(--muted); text-align: center;
  }
  .sysline.bg { color: var(--background); font-weight: 600; }
  .sysline .sys-txt {
    background: var(--bg2); border: 1px dashed var(--border);
    border-radius: 999px; padding: 3px 12px;
  }
  .sysline .t { font-size: 10.5px; color: var(--muted); font-weight: 400; }
  /* message auto-repris (ScheduleWakeup) : liseré indigo pour le distinguer d'un vrai « You ». */
  .bubble.auto { border-left: 3px solid var(--background); }
</style>
