<script>
  // A tool rendered inline in the conversation.
  // File-mutating tools (Write/Edit/MultiEdit/NotebookEdit) show a Pierre diff INLINE and
  // uncollapsed by default (unified, or side-by-side per Settings), clamped to a max height so small edits (a handful
  // of lines) are visible at a glance; a "Show more" toggle appears only when the diff
  // overflows the clamp. Other tools keep a compact chip that expands to JSON input/result.
  // State is local; since the list is keyed by tool_use id it survives live re-renders.
  import PierreDiff from './PierreDiff.svelte';
  import { ui } from '$lib/state.svelte.js';
  let { t, diff = null, ask = null } = $props();
  const hasDiff = $derived(!!(diff && diff.ops && diff.ops.length));

  // non-diff tools: collapsible JSON input / result. AskUserQuestion (`ask` = the questions
  // payload) renders read-only — header, question, options — instead of raw JSON, and marks the
  // option(s) you picked, parsed from the tool result (`…="label"` pairs, comma-joined if multi).
  let open = $state(false);
  const hasDetail = $derived(!!(t.inputText || t.result || ask));
  const answers = $derived.by(() => (ask && t.result)
    ? [...t.result.matchAll(/="([^"]*)"/g)].map((m) => m[1]) : []);
  const isPicked = (label) => answers.some((a) => a === label || a.split(',').map((s) => s.trim()).includes(label));
  const answerText = $derived(answers.length ? answers.join('  ·  ') : (ask && t.result ? t.result.trim() : ''));

  // diff tools: inline, clamped, expandable only when the content exceeds the clamp
  let expanded = $state(false);
  let box = $state(null);          // the clamped diff container
  let overflowing = $state(false);
  const CLAMP = 260;               // ~12 lines; small edits fit without scrolling
  $effect(() => {
    const el = box;                // read tracked deps before the guard
    if (!hasDiff || !el) return;
    const check = () => { overflowing = el.scrollHeight > CLAMP + 8; };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return () => ro.disconnect();
  });
</script>

{#if hasDiff}
  <div class="tool tool-diff" class:expanded>
    <span class="chip chip-diff" class:clickable={overflowing}
          onclick={() => { if (overflowing) expanded = !expanded; }}>
      🔧 {t.name}{#if t.detail}<span class="chip-d">{t.detail}</span>{/if}{#if overflowing}<span class="chip-x">▸</span>{/if}
    </span>
    <div class="td-diff" class:clamped={!expanded} bind:this={box}>
      {#each diff.ops as o}
        {#if o.all}<div class="diff-tag">replace all occurrences</div>{/if}
        <PierreDiff
          oldStr={o.kind === 'edit' ? (o.old || '') : ''}
          newStr={o.kind === 'write' ? (o.content || '') : (o.new || '')}
          name={diff.name}
          diffStyle={ui.diffSplit ? 'split' : 'unified'} />
      {/each}
    </div>
    {#if overflowing}
      <button class="diff-more" onclick={() => (expanded = !expanded)}>{expanded ? '▲ Show less' : '▼ Show more'}</button>
    {/if}
  </div>
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
