<script>
  /*
   * Renders a diff via @pierre/diffs (Shiki). The library is browser-only (customElements,
   * HTMLElement) and heavy (Shiki) → dynamic import in onMount + lazy mount by the caller.
   * The diff `<pre>` lives in the shadow root of <diffs-container> (the library's stylesheet is
   * adopted there, theme driven via setThemeType since `data-theme` does not cascade into shadow).
   *
   * `oldStr`/`newStr` = raw contents; pass old='' for a new file (Write/notebook).
   * `name` infers the highlighting language. `diffStyle`: 'split' (Files tab) or 'unified'.
   *
   * Line comments (GitHub-style), enabled by `commentable`:
   *   - the library's line selection + gutter "+" pick a line range (onGutterUtilityClick);
   *   - the annotation framework injects an inline editor / comment bubble under the line via a
   *     named <slot>. Annotation content is LIGHT DOM (child of <diffs-container>), so the app's
   *     CSS custom properties (var(--…)) inherit through the shadow boundary and focus works.
   *   - committed comments come from the parent via `comments`; a commit calls onCommit, a delete
   *     calls onDelete. The parent owns the batch; this component owns the transient draft editor.
   *
   * Annotation cache gotcha: the library reuses a rendered annotation element only when its
   * `metadata` is REFERENCE-equal (===). So we keep stable metadata refs (draftMeta + a per-id
   * map) — otherwise a rebuild would recreate the editor DOM and drop the textarea focus mid-type.
   */
  import { onMount } from 'svelte';
  import { themeType } from '$lib/theme.svelte.js';

  let {
    oldStr = '', newStr = '', name = 'file.txt', diffStyle = 'unified',
    commentable = false,
    comments = [],          // committed line comments: [{ id, side, start, end, text }]
    onCommit = null,        // (payload) => void  payload: { side, start, end, lineNumber, text, snippet }
    onDelete = null,        // (id) => void
  } = $props();

  const THEME = { dark: 'pierre-dark', light: 'pierre-light' };

  let host;               // host <div> (bind:this)
  let container = null;   // <diffs-container>
  let fd = null;          // FileDiff instance
  let ready = $state(false);

  // ----- line comment state -----
  let draft = null;             // { side, start, end } | null  (plain var; rebuilds are explicit)
  let draftMeta = null;         // stable metadata ref for the draft editor annotation
  const savedMeta = new Map();  // comment.id -> stable metadata ref (annotation cache needs ===)

  const clampLine = (n) => Math.max(1, Math.floor(n || 1));
  function extractSnippet(side, start, end) {
    const src = side === 'deletions' ? (oldStr || '') : (newStr || '');
    const lines = src.split('\n');
    return lines.slice(clampLine(start) - 1, Math.max(clampLine(start), clampLine(end))).join('\n');
  }

  function buildAnnotations() {
    const anns = [];
    const ids = new Set();
    for (const c of comments) {
      ids.add(c.id);
      let m = savedMeta.get(c.id);
      if (!m || m.text !== c.text || m.start !== c.start || m.end !== c.end || m.side !== c.side) {
        m = { kind: 'saved', id: c.id, side: c.side, start: c.start, end: c.end, text: c.text };
        savedMeta.set(c.id, m);
      }
      anns.push({ side: c.side, lineNumber: c.end, metadata: m });
    }
    for (const k of savedMeta.keys()) if (!ids.has(k)) savedMeta.delete(k);
    if (draft) anns.push({ side: draft.side, lineNumber: draft.end, metadata: draftMeta });
    return anns;
  }
  function rebuild() { if (ready && fd) fd.setLineAnnotations(buildAnnotations()); }

  function startDraft(range) {
    if (!commentable || !range) return;
    const side = range.endSide || range.side || 'additions';
    const start = clampLine(Math.min(range.start, range.end));
    const end = clampLine(Math.max(range.start, range.end));
    if (draft && draft.side === side && draft.start === start && draft.end === end) return; // already open
    draft = { side, start, end };
    draftMeta = { kind: 'draft' };
    rebuild();
  }
  function commitDraft(text) {
    const t = (text || '').trim();
    const d = draft;
    draft = null; draftMeta = null;
    try { fd?.setSelectedLines?.(null); } catch (_) {}
    if (t && d && onCommit) {
      onCommit({ side: d.side, start: d.start, end: d.end, lineNumber: d.end, text: t, snippet: extractSnippet(d.side, d.start, d.end) });
    }
    rebuild(); // remove the editor now; the saved bubble arrives via the `comments` prop
  }
  function cancelDraft() {
    draft = null; draftMeta = null;
    try { fd?.setSelectedLines?.(null); } catch (_) {}
    rebuild();
  }

  // ----- annotation DOM (light DOM, styled with inherited CSS custom properties) -----
  const styl = (el, css) => { for (const k in css) el.style[k] = css[k]; };
  const rangeLabel = (side, start, end) => {
    const p = side === 'deletions' ? '−' : '+';
    return start === end ? `${p}L${start}` : `${p}L${start}–${end}`;
  };
  function mkBtn(label, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    styl(b, {
      border: '1px solid ' + (primary ? 'var(--accent)' : 'var(--border2)'),
      background: primary ? 'var(--accent)' : 'transparent',
      color: primary ? '#fff' : 'var(--muted)',
      borderRadius: '8px', padding: '4px 12px', fontSize: '12px', fontWeight: '700',
      cursor: 'pointer', fontFamily: 'var(--mono)',
    });
    return b;
  }
  function renderAnnotation(ann) {
    const m = ann.metadata;
    return m.kind === 'draft' ? buildEditor() : buildBubble(m);
  }
  function buildEditor() {
    const d = draft;
    const wrap = document.createElement('div');
    styl(wrap, {
      margin: '6px 10px', padding: '8px', border: '1px solid var(--accent)', borderRadius: '10px',
      background: 'var(--surface)', display: 'flex', flexDirection: 'column', gap: '6px', whiteSpace: 'normal',
    });
    wrap.addEventListener('pointerdown', (e) => e.stopPropagation());
    const lbl = document.createElement('div');
    lbl.textContent = 'Comment on ' + rangeLabel(d.side, d.start, d.end);
    styl(lbl, { fontSize: '11px', fontWeight: '700', color: 'var(--muted)', fontFamily: 'var(--mono)' });
    const ta = document.createElement('textarea');
    ta.rows = 2;
    ta.placeholder = 'Leave a comment on these lines…  (⌘/Ctrl+Enter to save · Esc to cancel)';
    styl(ta, {
      width: '100%', boxSizing: 'border-box', resize: 'vertical', minHeight: '46px',
      background: 'var(--bg2, var(--surface))', color: 'var(--text)', border: '1px solid var(--border2)',
      borderRadius: '8px', fontFamily: 'var(--mono)', fontSize: '12px', lineHeight: '1.5', padding: '7px 9px',
    });
    ta.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDraft(ta.value); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
    });
    const bar = document.createElement('div');
    styl(bar, { display: 'flex', gap: '6px', justifyContent: 'flex-end' });
    const cancel = mkBtn('Cancel', false);
    cancel.addEventListener('click', (e) => { e.stopPropagation(); cancelDraft(); });
    const save = mkBtn('Comment', true);
    save.addEventListener('click', (e) => { e.stopPropagation(); commitDraft(ta.value); });
    bar.append(cancel, save);
    wrap.append(lbl, ta, bar);
    requestAnimationFrame(() => { try { ta.focus(); } catch (_) {} });
    return wrap;
  }
  function buildBubble(m) {
    const wrap = document.createElement('div');
    styl(wrap, {
      margin: '6px 10px', padding: '8px 10px', border: '1px solid var(--border2)',
      borderLeft: '3px solid var(--accent)', borderRadius: '10px', background: 'var(--surface)',
      display: 'flex', gap: '8px', alignItems: 'flex-start', whiteSpace: 'normal',
    });
    const body = document.createElement('div');
    styl(body, { flex: '1 1 auto', minWidth: '0' });
    const lbl = document.createElement('div');
    lbl.textContent = rangeLabel(m.side, m.start, m.end);
    styl(lbl, { fontSize: '10.5px', fontWeight: '700', color: 'var(--accent-d)', fontFamily: 'var(--mono)', marginBottom: '3px' });
    const txt = document.createElement('div');
    txt.textContent = m.text;
    styl(txt, { fontSize: '12.5px', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
    body.append(lbl, txt);
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '✕';
    del.title = 'Remove comment';
    styl(del, { flex: '0 0 auto', background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: '12px', fontWeight: '700', padding: '0 2px', lineHeight: '1.4' });
    del.addEventListener('click', (e) => { e.stopPropagation(); if (onDelete) onDelete(m.id); });
    wrap.append(body, del);
    return wrap;
  }

  const interactionOptions = () => (commentable ? {
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick: (range) => startDraft(range),
    renderAnnotation,
  } : {});

  const baseOptions = (tt) => ({
    diffStyle,
    disableFileHeader: true, // hooked already shows the file name above
    overflow: 'wrap',
    theme: THEME,
    themeType: tt,
    ...interactionOptions(),
  });

  onMount(() => {
    let alive = true;
    (async () => {
      const [{ FileDiff }] = await Promise.all([
        import('@pierre/diffs'),
        import('@pierre/diffs/web-components'), // side effect: registers <diffs-container> (vite alias)
      ]);
      if (!alive || !host) return;
      container = document.createElement('diffs-container');
      host.appendChild(container);
      fd = new FileDiff(baseOptions(themeType()));
      fd.hydrate({
        fileContainer: container,
        oldFile: { name, contents: oldStr ?? '' },
        newFile: { name, contents: newStr ?? '' },
        lineAnnotations: buildAnnotations(),
      });
      ready = true;
    })();
    return () => {
      alive = false;
      try { fd?.cleanUp?.(); } catch (_) {}
      fd = null;
      if (container?.parentNode) container.parentNode.removeChild(container);
      container = null;
    };
  });

  // Re-render when content or style changes (read the deps BEFORE the `ready` guard).
  // setOptions merges → theme AND interaction callbacks set at construction are preserved.
  $effect(() => {
    const o = { name, contents: oldStr ?? '' };
    const n = { name, contents: newStr ?? '' };
    const ds = diffStyle;
    if (!ready || !fd) return;
    fd.setOptions({ diffStyle: ds, disableFileHeader: true, overflow: 'wrap', theme: THEME, ...interactionOptions() });
    fd.render({ oldFile: o, newFile: n, forceRender: true, lineAnnotations: buildAnnotations() });
  });

  // Rebuild annotations when committed comments change (add/remove from the parent). The draft
  // (if any) is preserved because its metadata ref is stable → the library reuses its element.
  $effect(() => {
    comments; // reactive dep
    if (ready && fd) fd.setLineAnnotations(buildAnnotations());
  });

  // Theme toggle only (cheap, no diff re-parse).
  $effect(() => {
    const tt = themeType();
    if (ready && fd) fd.setThemeType(tt);
  });
</script>

<div class="pierre-diff" bind:this={host}></div>
