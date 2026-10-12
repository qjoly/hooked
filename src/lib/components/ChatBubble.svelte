<script>
  import { ago, splitMessageImages, fmtTokens } from '$lib/format.js';
  import { getMessageText } from '$lib/api.js';
  import { setContext } from 'svelte';
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
  // Lets a shell CodeBlock, two components down, run itself in this session (cf. CodeBlock).
  setContext('hooked.session', () => session);

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
  // ── long user messages ──────────────────────────────────────────────────────────────────────
  // A batched review, a pasted log: a sent message can run for hundreds of lines, and the server
  // caps what it puts in the conversation payload. Rather than dumping it (or cutting it with no
  // way back), the bubble shows its first CLAMP_LINES lines and a "Show more" button. The clamp
  // is a max-height, not a cut in the text: the markdown is never sliced mid-fence. When the
  // server flagged the message `truncated`, expanding also FETCHES the tail it left out.
  const CLAMP_LINES = 10;
  let expanded = $state(false);
  let fullText = $state(null);   // tail fetched for a `truncated` message
  let loadingFull = $state(false);
  let bodyEl = $state(null);
  let overflowing = $state(false); // measured while collapsed: is there anything hidden?

  // user message: pasted images are stored as absolute paths prefixed to the text → render them as
  // expandable thumbnails and drop the raw paths from the displayed text.
  const userMsg = $derived(m.role === 'user' ? splitMessageImages(fullText ?? m.text) : null);
  // The tail can only be fetched when we know which session (and, in a subagent trace, which
  // agent) the bubble belongs to, and where to cut in the transcript.
  const canLoadFull = $derived(!!(m.truncated && session && m.forkUuid));
  const foldable = $derived(overflowing || canLoadFull);

  // Measure only while collapsed — expanded, scrollHeight == clientHeight and the flag would
  // clear itself, taking the "Show less" button with it.
  $effect(() => {
    if (expanded || !bodyEl || !userMsg?.text) return;
    overflowing = bodyEl.scrollHeight > bodyEl.clientHeight + 2;
  });

  async function toggleExpand() {
    if (!expanded && canLoadFull && fullText == null && !loadingFull) {
      loadingFull = true;
      try {
        const r = await getMessageText(session, m.forkUuid, agent);
        if (r && typeof r.text === 'string') fullText = r.text;
      } catch (_) {
        // the tail stays unavailable — the capped text is still there, and so is the button
      } finally {
        loadingFull = false;
      }
    }
    expanded = !expanded;
  }

  // ── Tool-call folding (« reading column ») ───────────────────────────────────────────────────
  // Runs of ≥ FOLD_MIN consecutive "plain" tool calls collapse into one grey line
  // (`▸ 14 tool calls · read ×9, bash ×5`) you can open — the prose stays readable.
  // Interactive tools (ask/send), hand-off tools and tool calls carrying a diff stay visible.
  const FOLD_MIN = 3;
  const isPlainTool = (p) => p.type === 'tool' && !p.ask && !p.send && !p.show && !p.diff && !HANDOFF_TOOLS.has(p.tool?.name);
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
    <span class="sys-txt">{#if m.kind === 'bg'}<Icon name="background" size={13} color="var(--background)" /> {:else if m.kind === 'compact'}<Icon name="archive" size={13} /> {/if}{m.text}{#if m.kind === 'compact' && m.preTokens} · {fmtTokens(m.preTokens)}{#if m.postTokens} → {fmtTokens(m.postTokens)}{/if} tokens{/if}</span>
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
    {#if userMsg.text}
      <div class="md" class:clamped={foldable && !expanded} style="--clamp-lines:{CLAMP_LINES}"
           bind:this={bodyEl}><Markdown text={userMsg.text} /></div>
      {#if foldable}
        <button class="more" onclick={toggleExpand} disabled={loadingFull}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={12} />
          {loadingFull ? 'Loading the rest…' : expanded ? 'Show less' : 'Show more'}
        </button>
      {/if}
    {/if}
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
            <div class="part-tool"><ToolChip t={b.p.tool} diff={b.p.diff} ask={b.p.ask} send={b.p.send} show={b.p.show} {session} {agent} /></div>
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
              <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} ask={p.ask} send={p.send} show={p.show} {session} {agent} /></div>
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
            <div class="part-tool"><ToolChip t={p.tool} diff={p.diff} ask={p.ask} send={p.send} show={p.show} {session} {agent} /></div>
          {/if}
        {/if}
      {/each}
    </div>
  {/if}
</div>
{/if}

<style>
  /* Une bulle rétrécit à son contenu, et un terminal n'a pas de largeur intrinsèque : xterm se
     dimensionne sur son conteneur, qui se dimensionne sur son contenu → la boucle s'effondrait sur
     une fenêtre minuscule. On force donc la bulle qui contient un terminal `!!` à occuper la largeur
     maximale d'une bulle, et PtyBlock la remplit. `:has()` parce que la contrainte est sur l'ANCÊTRE
     de l'élément concerné, et que le bloc est rendu deux composants plus bas (Markdown → PtyBlock). */
  .bubble:has(:global(.pb)) { width: 85%; max-width: 85%; padding: 7px 8px; }
  /* message long : replié sur ses 10 premières lignes, dégradé de sortie + bouton « Show more ».
     C'est une hauteur max, pas une coupe dans le texte — le markdown reste entier. */
  .md.clamped {
    max-height: calc(var(--clamp-lines) * 1.5em); overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
    mask-image: linear-gradient(to bottom, #000 72%, transparent 100%);
  }
  .more {
    display: inline-flex; align-items: center; gap: 5px; margin-top: 6px;
    font: inherit; font-size: var(--t-micro); font-weight: 700; line-height: 1.4; cursor: pointer;
    border: 1px solid rgba(255,255,255,.45); background: rgba(255,255,255,.12); color: inherit;
    border-radius: 999px; padding: 2px 10px;
  }
  .more:hover:not(:disabled) { background: rgba(255,255,255,.24); border-color: #fff; }
  .more:disabled { opacity: .65; cursor: default; }

  /* ligne système sobre, centrée — notification de tâche de fond (queued_command) dans le fil. */
  .sysline {
    display: flex; align-items: baseline; gap: 8px; justify-content: center;
    margin: 4px auto; padding: 4px 12px; max-width: 90%;
    font-size: var(--t-meta); color: var(--muted); text-align: center;
  }
  .sysline.bg { color: var(--background); font-weight: 600; }
  .sysline .sys-txt {
    background: var(--bg2); border: 1px dashed var(--border);
    border-radius: 999px; padding: 3px 12px;
  }
  .sysline .t { font-size: var(--t-micro); color: var(--muted); font-weight: 400; }
  /* message auto-repris (ScheduleWakeup) : l'en-tête le dit déjà en toutes lettres, la bulle prend
     simplement le violet des jobs de fond au lieu de l'indigo du « You » — même token partout. */
  .bubble.auto { background: var(--background); }

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
