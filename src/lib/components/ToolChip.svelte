<script>
  // A tool rendered inline in the conversation.
  // File-mutating tools (Write/Edit/MultiEdit/NotebookEdit) show a unified Pierre diff
  // INLINE and uncollapsed by default, clamped to a max height so small edits (a handful
  // of lines) are visible at a glance; a "Show more" toggle appears only when the diff
  // overflows the clamp. Other tools keep a compact chip that expands to JSON input/result.
  // State is local; since the list is keyed by tool_use id it survives live re-renders.
  import PierreDiff from './PierreDiff.svelte';
  let { t, diff = null } = $props();
  const hasDiff = $derived(!!(diff && diff.ops && diff.ops.length));

  // non-diff tools: collapsible JSON input / result
  let open = $state(false);
  const hasDetail = $derived(!!(t.inputText || t.result));

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
          diffStyle="unified" />
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
        {#if t.inputText}<div class="td-sec"><div class="td-h">input</div><pre>{t.inputText}</pre></div>{/if}
        {#if t.result}<div class="td-sec"><div class="td-h">result</div><pre>{t.result}</pre></div>{/if}
      </div>
    {/if}
  </div>
{/if}
