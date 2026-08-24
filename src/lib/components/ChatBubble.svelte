<script>
  import { ago, splitMessageImages } from '$lib/format.js';
  import ToolChip from './ToolChip.svelte';
  import Markdown from './Markdown.svelte';
  import MessageImages from './MessageImages.svelte';
  import Icon from '$lib/components/Icon.svelte';
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

  // ── Tool-call folding (« reading column ») ───────────────────────────────────────────────────
  // Runs of ≥ FOLD_MIN consecutive "plain" tool calls collapse into one grey line
  // (`▸ 14 tool calls · read ×9, bash ×5`) you can open — the prose stays readable.
  // Interactive tools (ask/send), hand-off tools and tool calls carrying a diff stay visible.
  const FOLD_MIN = 3;
  const isPlainTool = (p) => p.type === 'tool' && !p.ask && !p.send && !p.diff && !HANDOFF_TOOLS.has(p.tool?.name);
  const blocks = $derived.by(() => {
    const out = [];
    let run = null;
    parts.forEach((p, i) => {
      if (isPlainTool(p)) {
        if (!run) { run = { type: 'run', items: [], start: i }; out.push(run); }
        run.items.push(p);
      } else { run = null; out.push({ type: 'part', p, i }); }
    });
    return out;
  });
  let openRuns = $state({}); // run start index → expanded?
  // `read ×9, bash ×5` summary, most frequent first.
  function runLabel(items) {
    const counts = new Map();
    for (const p of items) { const n = (p.tool?.name || 'tool').toLowerCase(); counts.set(n, (counts.get(n) || 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(', ');
  }
  // While the turn streams, the run in progress ends the message: keep its LAST call visible so
  // the live activity stays observable — only the settled prefix folds.
  const lastBlock = $derived(blocks[blocks.length - 1]);
  const liveTail = (b) => b === lastBlock && parts[parts.length - 1]?.type === 'tool';
</script>

{#if m.role === 'system'}
  <div class="sysline" class:bg={m.kind === 'bg'} data-msg-ts={m.ts || ''}>
    <span class="sys-txt">{#if m.kind === 'bg'}<Icon name="background" size={13} color="var(--background)" /> {/if}{m.text}</span>
    <span class="t">{ago(m.ts)}</span>
  </div>
{:else}
<div class="bubble {m.role}" class:auto={m.auto} data-msg-ts={m.ts || ''}>
  <div class="who">{#if m.role === 'user'}{#if m.auto}<Icon name="rotate-cw" size={14} /> Auto-resumed (background job){:else}<Icon name="user" size={14} /> You{/if}{:else}<Icon name="bot" size={14} /> Claude{/if}<span class="t">{ago(m.ts)}</span>
    {#if onfork && m.forkUuid}
      <span class="fork-ctl">
        <button class="fork-btn fork-main" title="Fork here without a message — independent branch waiting for you"
                onclick={() => onfork(m)}><Icon name="git-branch" size={13} /> Fork</button>
        {#if onforkadvanced}
          <button class="fork-btn fork-caret" aria-label="Fork options"
                  title="Fork options (model, effort, immediate message…)"
                  onclick={() => onforkadvanced(m)}><Icon name="chevron-down" size={13} /></button>
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
      {#each blocks as b (b.type === 'run' ? 'r' + b.start : 'p' + b.i)}
        {#if b.type === 'part'}
          {#if b.p.type === 'text'}
            {#if isFinalText(b.i)}
              <div class="md final"><Markdown text={b.p.text} /></div>
            {:else}
              <div class="md reasoning"><Markdown text={b.p.text} /></div>
            {/if}
          {:else}
            <div class="part-tool"><ToolChip t={b.p.tool} diff={b.p.diff} ask={b.p.ask} send={b.p.send} {session} {agent} /></div>
          {/if}
        {:else}
          {@const tail = liveTail(b) ? 1 : 0}
          {@const folded = b.items.slice(0, b.items.length - tail)}
          {#if folded.length >= FOLD_MIN && !openRuns[b.start]}
            <button class="tool-fold" onclick={() => (openRuns = { ...openRuns, [b.start]: true })}
                    title="Show these tool calls">
              <span class="tf-chip"><Icon name="chevron-right" size={13} /> {folded.length} tool calls · {runLabel(folded)}</span>
              <span class="tf-rule"></span>
            </button>
          {:else}
            {#each folded as p, k (b.start + k)}
              <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} ask={p.ask} send={p.send} {session} {agent} /></div>
            {/each}
            {#if folded.length >= FOLD_MIN}
              <button class="tool-fold" onclick={() => (openRuns = { ...openRuns, [b.start]: false })} title="Collapse">
                <span class="tf-chip"><Icon name="chevron-down" size={13} /> collapse {folded.length} tool calls</span>
                <span class="tf-rule"></span>
              </button>
            {/if}
          {/if}
          {#if tail}
            {@const p = b.items[b.items.length - 1]}
            <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} ask={p.ask} send={p.send} {session} {agent} /></div>
          {/if}
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

  /* run de tool calls replié : une ligne grise mono carrée + filet jusqu'au bord. */
  .tool-fold {
    display: flex; align-items: center; gap: 10px; width: 100%; margin: 2px 0;
    background: none; border: none; padding: 0; cursor: pointer; text-align: left;
  }
  .tf-chip {
    flex: 0 0 auto; font: 500 11px var(--mono); color: var(--muted);
    border: 1px solid var(--border); background: var(--bg2); padding: 3px 7px; border-radius: 0;
  }
  .tool-fold:hover .tf-chip { color: var(--text); border-color: var(--border2); }
  .tf-rule { flex: 1 1 auto; height: 1px; background: var(--border); }
</style>
