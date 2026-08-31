<script>
  // Custom diff renderer for the Ship lens (replaces @pierre/diffs there): light DOM, styled with
  // the app tokens, syntax-highlighted per line via the repo's own highlighter, unified or split,
  // with GitHub-style inline comments. Input is a single (oldStr → newStr) pair; the caller (Ship)
  // passes the NET original→final content so transient add-then-delete never shows.
  import { toSegments, unifiedRows, splitRows, langFromName, EXPAND_STEP } from '$lib/difflines.js';
  import { highlight } from '$lib/highlight.js';
  import Icon from '$lib/components/Icon.svelte';
  import { ui } from '$lib/state.svelte.js';

  let {
    oldStr = '', newStr = '', name = 'file.txt', mode = 'split',
    compact = false,          // drop the context lines around each change
    commentable = false,
    comments = [],            // [{ id, side, start, end, text }]
    onComment = null,         // ({ side, start, end, text, snippet }) => void
    onDelete = null,          // (id) => void
  } = $props();

  const lang = $derived(langFromName(name));
  const segs = $derived(toSegments(oldStr, newStr));

  // GitHub-style gap expansion: per equal-segment { head, tail, all } — how many hidden unchanged
  // lines the user revealed on each side of a collapsed gap. Reset when the diff content changes.
  let expand = $state({});
  $effect(() => { oldStr; newStr; expand = {}; });
  function expandGap(seg, dir) {
    const e = expand[seg] || { head: 0, tail: 0 };
    expand = { ...expand, [seg]: { ...e, [dir]: (e[dir] || 0) + EXPAND_STEP } };
  }
  function expandAll(seg) { expand = { ...expand, [seg]: { all: true } }; }

  const rows = $derived.by(() => {
    const ctx = compact ? 0 : undefined;
    return mode === 'split' ? splitRows(segs, expand, ctx) : unifiedRows(segs, expand, ctx);
  });

  // highlight cache: identical lines are common (context) → memoise the escaped HTML.
  let hlCache = new Map();
  $effect(() => { name; hlCache = new Map(); }); // reset when the file (language) changes
  function hl(text) {
    if (text === '') return '&nbsp;';
    let v = hlCache.get(text);
    if (v === undefined) { v = highlight(text, lang); hlCache.set(text, v); }
    return v;
  }

  // Comments anchor to a LINE RANGE [start, end] on one side. A committed comment / the draft is
  // rendered under its `end` line; the whole range is highlighted while drafting.
  const src = (side) => (side === 'old' ? (oldStr || '') : (newStr || '')).split('\n');
  function snippetFor(side, start, end) {
    return src(side).slice(Math.max(0, start - 1), Math.max(start, end)).join('\n');
  }
  const commentsAt = (side, endLine) => comments.filter((c) => c.side === side && c.end === endLine);

  // GitHub-style click-drag range selection. Press the "+" on a line and drag over other lines of
  // the same side; releasing opens the comment editor for the whole range. A plain click (press +
  // release on one line) comments a single line.
  let draft = $state(null); // committed-open editor: { side, start, end, text }
  let drag = $state(null);  // active drag: { side, anchor, focus }
  function startDrag(side, lineNo, e) {
    if (!commentable || lineNo == null) return;
    if (e) e.preventDefault(); // no text selection while dragging
    drag = { side, anchor: lineNo, focus: lineNo };
  }
  function overLine(side, lineNo) {
    if (!drag || drag.side !== side || lineNo == null || drag.focus === lineNo) return;
    drag = { ...drag, focus: lineNo };
  }
  function endDrag() {
    if (!drag) return;
    const side = drag.side, start = Math.min(drag.anchor, drag.focus), end = Math.max(drag.anchor, drag.focus);
    drag = null;
    draft = { side, start, end, text: '' };
  }
  function commitDraft() {
    const d = draft;
    if (d && d.text.trim() && onComment)
      onComment({ side: d.side, start: d.start, end: d.end, text: d.text.trim(), snippet: snippetFor(d.side, d.start, d.end) });
    draft = null;
  }
  function cancelDraft() { draft = null; }
  const draftAt = (side, endLine) => draft && draft.side === side && draft.end === endLine;
  // is this (side,line) inside the active drag or the open draft → range highlight.
  const inDraft = (side, lineNo) => {
    if (lineNo == null) return false;
    if (drag && drag.side === side) { const a = Math.min(drag.anchor, drag.focus), b = Math.max(drag.anchor, drag.focus); return lineNo >= a && lineNo <= b; }
    if (draft && draft.side === side) return lineNo >= draft.start && lineNo <= draft.end;
    return false;
  };

  // A comment "slot" belongs after a row when a draft or committed comment anchors its END here.
  function slotFor(side, endLine) {
    if (!side || endLine == null) return { list: [], draft: false };
    return { list: commentsAt(side, endLine), draft: draftAt(side, endLine) };
  }
  // ── side-by-side divider ─────────────────────────────────────────────────────────────────
  // In split mode the old/new columns are 50/50 by default; the bar between them can be dragged
  // to give one side more room (ratio persisted in `ui`, so it holds across files and lenses).
  // Double-click restores 50/50, ←/→ nudge the focused bar. The two 46px line-number gutters sit
  // outside the ratio, hence the `- GUTTERS` in every conversion.
  const GUTTERS = 92;
  const RATIO = { min: 0.15, max: 0.85, def: 0.5, step: 0.04 };
  const clampRatio = (r) => Math.max(RATIO.min, Math.min(RATIO.max, r));
  const ratio = $derived(clampRatio(ui.diffRatio ?? RATIO.def));

  function startSplitDrag(e) {
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    const rect = root.getBoundingClientRect();
    const span = rect.width - GUTTERS;
    if (span <= 0) return;
    const move = (ev) => { ui.diffRatio = clampRatio((ev.clientX - rect.left - GUTTERS / 2) / span); };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function nudgeSplit(e) {
    const d = e.key === 'ArrowLeft' ? -RATIO.step : e.key === 'ArrowRight' ? RATIO.step : 0;
    if (!d) return;
    e.preventDefault();
    ui.diffRatio = clampRatio(ratio + d);
  }

  // ── occurrence echo ─────────────────────────────────────────────────────────────────────
  // Selecting a bit of text paints every OTHER occurrence of it in this diff (VS Code style):
  // select "pro" and the "pro" inside "professional" lights up too. Purely visual — it uses the
  // CSS Custom Highlight API, so no node is added or split and the diff text is never touched.
  // Browsers without the API simply show nothing extra.
  const HL_NAME = 'dv-occurrence';
  const MAX_OCC = 500;      // stop painting past this many hits (huge diffs / one-letter needles)
  let root;                 // the .dv container
  let occRaf = 0;

  const hlStore = () => (typeof CSS !== 'undefined' && CSS.highlights) || null;
  function clearOcc() { const st = hlStore(); if (st) st.delete(HL_NAME); }

  function paintOcc() {
    occRaf = 0;
    const store = hlStore();
    if (!store || !root) return;
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return clearOcc();
    if (!root.contains(sel.getRangeAt(0).commonAncestorContainer)) return clearOcc();
    const needle = sel.toString();
    // one line, non-blank, long enough to mean something
    if (needle.length < 2 || needle.length > 200 || !needle.trim() || /[\n\r]/.test(needle)) return clearOcc();

    const ranges = [];
    for (const code of root.querySelectorAll('.dv-code')) {
      if (ranges.length >= MAX_OCC) break;
      // flatten the line's text nodes once, so a match may span syntax-highlight tokens
      const nodes = [], starts = [];
      let text = '';
      const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) { nodes.push(n); starts.push(text.length); text += n.nodeValue; }
      if (!text) continue;
      const at = (idx) => { // absolute offset -> [node, offsetInNode]
        let i = starts.length - 1;
        while (i > 0 && starts[i] > idx) i--;
        return [nodes[i], idx - starts[i]];
      };
      for (let i = text.indexOf(needle); i !== -1 && ranges.length < MAX_OCC; i = text.indexOf(needle, i + needle.length)) {
        const [sn, so] = at(i), [en, eo] = at(i + needle.length - 1);
        const rg = document.createRange();
        rg.setStart(sn, so); rg.setEnd(en, eo + 1);
        ranges.push(rg);
      }
    }
    if (ranges.length) store.set(HL_NAME, new Highlight(...ranges));
    else clearOcc();
  }

  // selectionchange fires on every pointer move while dragging → coalesce to one paint per frame
  function scheduleOcc() { if (!occRaf) occRaf = requestAnimationFrame(paintOcc); }

  $effect(() => {
    if (!hlStore()) return;
    document.addEventListener('selectionchange', scheduleOcc);
    return () => {
      document.removeEventListener('selectionchange', scheduleOcc);
      if (occRaf) cancelAnimationFrame(occRaf);
      clearOcc();
    };
  });

  const rangeLabel = (side, start, end) => {
    const p = side === 'old' ? '−' : '+';
    return start === end ? `${p}L${end}` : `${p}L${start}–${end}`;
  };
</script>

<svelte:window onpointerup={endDrag} />

<div class="dv {mode}" bind:this={root} class:commentable class:dv-dragging={!!drag}
     style={mode === 'split' ? `--dv-l:${ratio}fr;--dv-r:${1 - ratio}fr;--dv-k:${ratio}` : null}>
  {#if mode === 'split'}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div class="dv-split-grip" role="separator" aria-label="Resize the diff columns" aria-orientation="vertical"
         tabindex="0" title="Drag to resize the two sides · double-click to reset"
         onpointerdown={startSplitDrag} ondblclick={() => (ui.diffRatio = RATIO.def)}
         onkeydown={nudgeSplit}></div>
  {/if}
  {#each rows as r, i (i)}
    {#if r.kind === 'gap'}
      <div class="dv-gap">
        <span class="dv-gap-btns">
          {#if r.count <= EXPAND_STEP}
            <button class="dv-gap-btn" title="Show all {r.count} lines" onclick={() => expandAll(r.seg)}><Icon name="arrow-up" size={11} /><Icon name="arrow-down" size={11} /></button>
          {:else}
            <button class="dv-gap-btn" title="Expand up ({EXPAND_STEP} lines)" onclick={() => expandGap(r.seg, 'tail')}><Icon name="arrow-up" size={11} /></button>
            <button class="dv-gap-btn" title="Expand down ({EXPAND_STEP} lines)" onclick={() => expandGap(r.seg, 'head')}><Icon name="arrow-down" size={11} /></button>
          {/if}
        </span>
        <span class="dv-gap-line"></span>
        <button class="dv-gap-txt" title="Show all {r.count} lines" onclick={() => expandAll(r.seg)}>⋯ {r.count} unchanged line{r.count > 1 ? 's' : ''}</button>
        <span class="dv-gap-line"></span>
      </div>
    {:else if mode === 'unified'}
      {@const side = r.kind === 'del' ? 'old' : 'new'}
      {@const lineNo = r.kind === 'del' ? r.oldNo : r.newNo}
      {@const slot = slotFor(side, lineNo)}
      <div class="dv-row u {r.kind}" class:dv-inrange={inDraft(side, lineNo)}
           onpointerenter={() => overLine(side, lineNo)}>
        <span class="dv-no">{r.oldNo ?? ''}</span>
        <span class="dv-no">{r.newNo ?? ''}</span>
        <span class="dv-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
        {#if commentable}
          <button class="dv-plus" title="Comment — click a line or drag over several"
                  onpointerdown={(e) => startDrag(side, lineNo, e)}>+</button>
        {/if}
        <code class="dv-code">{@html hl(r.text)}</code>
      </div>
      {#if slot.list.length || slot.draft}
        {@render commentSlot(slot, side, lineNo)}
      {/if}
    {:else}
      <div class="dv-row s">
        <span class="dv-no">{r.left ? r.left.no : ''}</span>
        <span class="dv-cell {r.left ? (r.kind === 'change' ? 'del' : 'ctx') : 'empty'}" class:dv-inrange={r.left && inDraft('old', r.left.no)}
              onpointerenter={() => r.left && overLine('old', r.left.no)}>
          {#if commentable && r.left}<button class="dv-plus" title="Comment — click a line or drag over several" onpointerdown={(e) => startDrag('old', r.left.no, e)}>+</button>{/if}
          <code class="dv-code">{@html r.left ? hl(r.left.text) : ''}</code>
        </span>
        <span class="dv-no">{r.right ? r.right.no : ''}</span>
        <span class="dv-cell {r.right ? (r.kind === 'change' ? 'add' : 'ctx') : 'empty'}" class:dv-inrange={r.right && inDraft('new', r.right.no)}
              onpointerenter={() => r.right && overLine('new', r.right.no)}>
          {#if commentable && r.right}<button class="dv-plus" title="Comment — click a line or drag over several" onpointerdown={(e) => startDrag('new', r.right.no, e)}>+</button>{/if}
          <code class="dv-code">{@html r.right ? hl(r.right.text) : ''}</code>
        </span>
      </div>
      {@const ls = r.left ? slotFor('old', r.left.no) : { list: [], draft: false }}
      {@const rs = r.right ? slotFor('new', r.right.no) : { list: [], draft: false }}
      {#if ls.list.length || ls.draft}{@render commentSlot(ls, 'old', r.left.no)}{/if}
      {#if rs.list.length || rs.draft}{@render commentSlot(rs, 'new', r.right.no)}{/if}
    {/if}
  {/each}
</div>

{#snippet commentSlot(slot, side, lineNo)}
  <div class="dv-comments">
    {#each slot.list as c (c.id)}
      <div class="dv-bubble">
        <span class="dv-bubble-anchor">{rangeLabel(side, c.start, c.end)}</span>
        <span class="dv-bubble-text">{c.text}</span>
        {#if onDelete}<button class="dv-bubble-x" title="Remove comment" onclick={() => onDelete(c.id)}><Icon name="close" size={12} /></button>{/if}
      </div>
    {/each}
    {#if slot.draft}
      <div class="dv-editor">
        <div class="dv-editor-lbl">Comment on {rangeLabel(side, draft.start, draft.end)}{#if draft.start !== draft.end} · {draft.end - draft.start + 1} lines{/if}</div>
        <!-- svelte-ignore a11y_autofocus -->
        <textarea autofocus rows="2" bind:value={draft.text}
                  placeholder="Leave a comment…  (⌘/Ctrl+Enter to save · Esc to cancel)"
                  onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDraft(); } else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); } }}></textarea>
        <div class="dv-editor-bar">
          <button class="dv-btn" onclick={cancelDraft}>Cancel</button>
          <button class="dv-btn primary" onclick={commitDraft}>Comment</button>
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<style>
  .dv {
    font-family: var(--mono); font-size: 12px; line-height: 1.55;
    background: var(--code-bg); color: #c9cedb; overflow-x: hidden; position: relative;
  }
  .dv-row { display: grid; align-items: stretch; }
  .dv.unified .dv-row { grid-template-columns: 46px 46px 16px 1fr; }
  .dv.unified.commentable .dv-row { grid-template-columns: 46px 46px 16px 18px 1fr; }
  .dv.split .dv-row { grid-template-columns: 46px minmax(0, var(--dv-l, 1fr)) 46px minmax(0, var(--dv-r, 1fr)); }

  /* draggable old|new divider — sits on the boundary between the left cell and the right
     gutter, i.e. after the 46px gutter plus the old side's share of the remaining width. */
  .dv-split-grip {
    position: absolute; top: 0; bottom: 0; width: 9px; margin-left: -4px; z-index: 4;
    left: calc(46px + (100% - 92px) * var(--dv-k, .5)); cursor: col-resize; background: none;
  }
  .dv-split-grip:hover, .dv-split-grip:focus-visible { background: var(--accent); opacity: .5; outline: none; }

  .dv-no {
    text-align: right; padding: 0 8px; color: #5a6072; user-select: none;
    font-size: 10.5px; background: rgba(255,255,255,.02); white-space: nowrap;
  }
  .dv-sign { text-align: center; user-select: none; color: #5a6072; }
  /* long lines wrap (no horizontal scroll); in split, left/right share the grid row so their
     heights stay aligned even when wrapped. min-width:0 lets the 1fr tracks actually shrink. */
  .dv-code { padding: 0 10px 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; min-width: 0; }
  .dv.unified .dv-code { min-width: 0; }
  .dv-cell .dv-code { flex: 1 1 auto; }

  /* unified row tints */
  .dv.unified .dv-row.add { background: rgba(var(--success-rgb), .13); }
  .dv.unified .dv-row.add .dv-sign { color: var(--success); }
  .dv.unified .dv-row.del { background: rgba(var(--danger-rgb), .12); }
  .dv.unified .dv-row.del .dv-sign { color: var(--danger); }
  .dv.unified .dv-row:hover { background: rgba(255,255,255,.03); }
  .dv.unified .dv-row.add:hover { background: rgba(var(--success-rgb), .18); }
  .dv.unified .dv-row.del:hover { background: rgba(var(--danger-rgb), .17); }

  /* split cells */
  .dv-cell { position: relative; display: flex; min-width: 0; }
  .dv-cell.add { background: rgba(var(--success-rgb), .13); }
  .dv-cell.del { background: rgba(var(--danger-rgb), .12); }
  .dv-cell.empty { background: rgba(255,255,255,.015); }
  .dv.split .dv-no { background: rgba(255,255,255,.02); }

  /* inline-comment gutter "+" */
  .dv-plus {
    flex: 0 0 auto; width: 16px; height: 16px; margin: 1px 2px 0 2px; align-self: flex-start;
    border: none; border-radius: 4px; background: var(--accent); color: #fff;
    font-size: 12px; line-height: 1; cursor: pointer; padding: 0; opacity: 0; transition: opacity .1s;
  }
  .dv.unified .dv-plus { align-self: center; margin: 0; }
  .dv-row:hover .dv-plus, .dv-cell:hover .dv-plus { opacity: 1; }

  /* draft range highlight while dragging / composing a multi-line comment */
  .dv.unified .dv-row.dv-inrange { background: rgba(var(--accent-rgb), .16); box-shadow: inset 2px 0 0 var(--accent); }
  .dv-cell.dv-inrange { background: rgba(var(--accent-rgb), .16); box-shadow: inset 2px 0 0 var(--accent); }
  .dv.dv-dragging { user-select: none; cursor: ns-resize; }

  .dv-gap { display: flex; align-items: center; gap: 10px; padding: 2px 12px 2px 4px; background: rgba(var(--accent-rgb), .05); }
  .dv-gap-line { flex: 1; height: 1px; background: var(--border); }
  .dv-gap-btns { flex: 0 0 auto; display: flex; gap: 2px; }
  .dv-gap-btn {
    display: flex; align-items: center; justify-content: center; gap: 0;
    background: none; border: none; border-radius: 4px; padding: 2px 5px;
    color: var(--accent); cursor: pointer; line-height: 1;
  }
  .dv-gap-btn:hover { background: var(--accent); color: #fff; }
  .dv-gap-txt {
    background: none; border: none; padding: 1px 6px; border-radius: 4px;
    color: #6a7180; font-family: inherit; font-size: 10.5px; cursor: pointer;
  }
  .dv-gap-txt:hover { color: var(--accent); background: rgba(var(--accent-rgb), .12); }

  /* comments */
  .dv-comments { background: rgba(255,255,255,.02); padding: 4px 12px 4px 52px; font-family: var(--font); }
  .dv-bubble {
    display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; padding: 8px 10px;
    background: var(--surface); border: 1px solid var(--border2); border-left: 3px solid var(--accent);
    border-radius: 10px;
  }
  .dv-bubble-anchor { flex: 0 0 auto; font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--accent-d); margin-top: 1px; }
  .dv-bubble-text { flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
  .dv-bubble-x { flex: 0 0 auto; background: none; border: none; color: var(--muted); cursor: pointer; font-size: 12px; padding: 0 2px; }
  .dv-bubble-x:hover { color: var(--text); }
  .dv-editor {
    margin: 4px 0; padding: 8px; background: var(--surface); border: 1px solid var(--accent); border-radius: 10px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .dv-editor-lbl { font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--muted); }
  .dv-editor textarea {
    width: 100%; box-sizing: border-box; resize: vertical; min-height: 46px;
    background: var(--bg2, var(--surface)); color: var(--text); border: 1px solid var(--border2);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; line-height: 1.5; padding: 7px 9px;
  }
  .dv-editor textarea:focus { outline: none; border-color: var(--accent); }
  .dv-editor-bar { display: flex; gap: 6px; justify-content: flex-end; }
  .dv-btn {
    border: 1px solid var(--border2); background: transparent; color: var(--muted);
    border-radius: 8px; padding: 4px 12px; font-size: 12px; font-weight: 700; cursor: pointer; font-family: var(--mono);
  }
  .dv-btn.primary { border-color: var(--accent); background: var(--accent); color: #fff; }
  .dv-btn:hover { filter: brightness(1.08); }
</style>
