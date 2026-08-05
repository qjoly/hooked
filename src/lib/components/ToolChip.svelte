<script>
  // A tool rendered inline in the conversation.
  // File-mutating tools (Write/Edit/MultiEdit/NotebookEdit) show a Pierre diff INLINE and
  // uncollapsed by default (unified, or side-by-side per Settings), clamped to a max height so small edits (a handful
  // of lines) are visible at a glance; a "Show more" toggle appears only when the diff
  // overflows the clamp. Other tools keep a compact chip that expands to JSON input/result.
  // State is local; since the list is keyed by tool_use id it survives live re-renders.
  import PierreDiff from './PierreDiff.svelte';
  import { ui } from '$lib/state.svelte.js';
  import { userFileUrl } from '$lib/api.js';
  let { t, diff = null, ask = null, send = null, session = null, agent = null } = $props();
  const hasDiff = $derived(!!(diff && diff.ops && diff.ops.length));

  // SendUserFile: files delivered to the user. Images render as click-to-expand thumbnails; other
  // files render as a click-to-open link. URLs are served by /api/user-file (transcript allowlist).
  const hasSend = $derived(!!(send && send.files && send.files.length));
  const fileUrl = (f) => userFileUrl(session, agent, f.path);
  let zoom = $state(null);
  function imgFail(e) { const b = e.currentTarget.closest('.send-img'); if (b) b.style.display = 'none'; }

  // non-diff tools: collapsible JSON input / result. AskUserQuestion (`ask` = the questions
  // payload) renders read-only — header, question, options — instead of raw JSON, and marks the
  // option(s) you picked, parsed from the tool result (`…="label"` pairs, comma-joined if multi).
  let open = $state(false);
  const hasDetail = $derived(!!(t.inputText || t.result || ask));
  const answers = $derived.by(() => (ask && t.result)
    ? [...t.result.matchAll(/="([^"]*)"/g)].map((m) => m[1]) : []);
  const isPicked = (label) => answers.some((a) => a === label || a.split(',').map((s) => s.trim()).includes(label));
  const answerText = $derived(answers.length ? answers.join('  ·  ') : (ask && t.result ? t.result.trim() : ''));

  // diff tools: SMALL diffs render inline (at-a-glance), clamped + "Show more" if they overflow.
  // BIG diffs stay collapsed and render only on expand. Rendering a diff runs @pierre/diffs' TextMate
  // highlighter, which is heavy for large hunks — but the old freeze on session switch was the
  // hidden Files pane rendering every diff at once (now lazy-mounted), not these few inline ones,
  // so small conversation edits are cheap to show. State is local, keyed by tool_use id.
  let expanded = $state(false);
  let box = $state(null);          // the clamped diff container (inline/small only)
  let overflowing = $state(false);
  const CLAMP = 260;               // ~12 lines; small edits fit without scrolling
  const diffLines = $derived.by(() => {
    if (!hasDiff) return 0;
    const nl = (x) => (x ? (x.match(/\n/g) || []).length + 1 : 0);
    let n = 0;
    for (const o of diff.ops) n += Math.max(nl(o.old), nl(o.new), nl(o.content));
    return n;
  });
  const BIG_DIFF = 12;             // > ~12 lines → collapsed by default (render on expand)
  const bigDiff = $derived(diffLines > BIG_DIFF);
  const showDiff = $derived(hasDiff && (!bigDiff || expanded));
  $effect(() => {
    const el = box;                // read tracked deps before the guard
    if (!showDiff || bigDiff || !el) return; // clamp/overflow logic is for the inline (small) case
    const check = () => { overflowing = el.scrollHeight > CLAMP + 8; };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  });
</script>

{#if hasDiff}
  <div class="tool tool-diff" class:expanded>
    <span class="chip chip-diff" class:clickable={bigDiff || overflowing}
          onclick={() => { if (bigDiff || overflowing) expanded = !expanded; }}>
      🔧 {t.name}{#if t.detail}<span class="chip-d">{t.detail}</span>{/if}{#if bigDiff}<span class="diff-size">{diffLines} lines</span>{/if}{#if bigDiff || overflowing}<span class="chip-x">▸</span>{/if}
    </span>
    {#if showDiff}
      <div class="td-diff" class:clamped={!bigDiff && !expanded} bind:this={box}>
        {#each diff.ops as o}
          {#if o.all}<div class="diff-tag">replace all occurrences</div>{/if}
          <PierreDiff
            oldStr={o.kind === 'edit' ? (o.old || '') : ''}
            newStr={o.kind === 'write' ? (o.content || '') : (o.new || '')}
            name={diff.name}
            diffStyle={ui.diffSplit ? 'split' : 'unified'} />
        {/each}
      </div>
    {/if}
    {#if !bigDiff && overflowing}
      <button class="diff-more" onclick={() => (expanded = !expanded)}>{expanded ? '▲ Show less' : '▼ Show more'}</button>
    {/if}
  </div>
{:else if hasSend}
  <div class="tool tool-send">
    <span class="chip chip-send">📎 Sent to you{#if send.caption}<span class="chip-d">{send.caption}</span>{/if}</span>
    <div class="send-files">
      {#each send.files as f}
        {#if f.kind === 'image'}
          <button class="send-img" title="{f.name} — click to expand" onclick={() => (zoom = fileUrl(f))}>
            <img src={fileUrl(f)} alt={f.name} loading="lazy" onerror={imgFail} />
          </button>
        {:else}
          <a class="send-file" href={fileUrl(f)} target="_blank" rel="noopener" title={f.path}>
            <span class="sf-ico">📄</span><span class="sf-name">{f.name}</span><span class="sf-open">↗</span>
          </a>
        {/if}
      {/each}
    </div>
  </div>
  {#if zoom}
    <div class="lightbox" role="presentation" onclick={() => (zoom = null)}>
      <img class="lightbox-img" src={zoom} alt="" />
    </div>
  {/if}
{:else}
  <div class="tool" class:has-detail={hasDetail} class:open>
    <span class="chip" onclick={() => { if (hasDetail) open = !open; }}>
      🔧 {t.name}{#if t.detail}<span class="chip-d">{t.detail}</span>{/if}{#if hasDetail}<span class="chip-x">▸</span>{/if}
    </span>
    {#if hasDetail}
      <div class="tool-detail">
        {#if ask}
          <div class="td-sec">
            <div class="td-h">question</div>
            <div class="ask-ro">
              {#each ask as q}
                <div class="q-block">
                  {#if q.header}<span class="q-chip">{q.header}</span>{/if}
                  <div class="q-text">{q.question}</div>
                  {#if q.multiSelect}<div class="q-hint">Multiple choices allowed</div>{/if}
                  <div class="q-opts">
                    {#each q.options || [] as o}
                      <div class="q-opt" class:sel={isPicked(o.label)}>
                        <span class="q-opt-body">
                          <span class="q-opt-label">{#if isPicked(o.label)}<span class="ask-check">✓ </span>{/if}{o.label}</span>
                          {#if o.description}<span class="q-opt-desc">{o.description}</span>{/if}
                        </span>
                      </div>
                    {/each}
                  </div>
                </div>
              {/each}
            </div>
          </div>
          {#if answerText}<div class="td-sec"><div class="td-h">answer</div><div class="ask-answer">{answerText}</div></div>{/if}
        {:else}
          {#if t.inputText}<div class="td-sec"><div class="td-h">input</div><pre>{t.inputText}</pre></div>{/if}
          {#if t.result}<div class="td-sec"><div class="td-h">result</div><pre>{t.result}</pre></div>{/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<svelte:window onkeydown={(e) => { if (e.key === 'Escape' && zoom) zoom = null; }} />

<style>
  /* taille d'un gros diff replié (indice avant ouverture) */
  .diff-size { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-left: 6px; }

  /* SendUserFile : chip « envoyé » + miniatures images / liens fichiers */
  .tool-send { display: flex; flex-direction: column; gap: 6px; }
  .chip-send { align-self: flex-start; }
  .send-files { display: flex; flex-wrap: wrap; gap: 8px; }
  .send-img {
    padding: 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2);
    cursor: zoom-in; overflow: hidden; line-height: 0; max-width: 220px;
  }
  .send-img:hover { border-color: var(--accent); }
  .send-img img { display: block; max-width: 220px; max-height: 160px; object-fit: contain; }
  .send-file {
    display: inline-flex; align-items: center; gap: 6px; max-width: 260px;
    padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg2); color: var(--text); text-decoration: none; font-size: 12.5px;
  }
  .send-file:hover { border-color: var(--accent); background: var(--bg3); }
  .sf-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sf-open { color: var(--muted); margin-left: 2px; }

  .lightbox {
    position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.8); cursor: zoom-out; padding: 24px;
  }
  .lightbox-img { max-width: 96vw; max-height: 92vh; object-fit: contain; border-radius: 6px; box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5); }
</style>
