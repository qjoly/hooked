<script>
  // Custom diff renderer for the Ship lens (replaces @pierre/diffs there): light DOM, styled with
  // the app tokens, syntax-highlighted per line via the repo's own highlighter, unified or split,
  // with GitHub-style inline comments. Input is a single (oldStr → newStr) pair; the caller (Ship)
  // passes the NET original→final content so transient add-then-delete never shows.
  import { toSegments, unifiedRows, splitRows, langFromName, EXPAND_STEP } from '$lib/difflines.js';
  import { highlight } from '$lib/highlight.js';
  import { ago } from '$lib/format.js';
  import { reanchor } from '$lib/reviewAnchor.js';
  import Icon from '$lib/components/Icon.svelte';
  import Markdown from '$lib/components/Markdown.svelte';
  import { ui } from '$lib/state.svelte.js';
  import { untrack } from 'svelte';
  import { symbolUnderPointer, paintSymbol, paintRangeIn, clearSymbols, highlightsSupported } from '$lib/codeHit.js';
  import { localDeclaration, langOfPath } from '$lib/localDefs.js';
  import { peek, modHeld } from '$lib/peek.svelte.js';

  let {
    oldStr = '', newStr = '', name = 'file.txt', mode = 'split',
    compact = false,          // drop the context lines around each change
    commentable = false,
    // threads: [{ id, side, start, end, sent, messages: [{ author, text, ts }] }] —
    // GitHub-style conversations anchored to a line range. A thread with a single user message
    // and sent:false is a pending (batched, not yet sent) comment. ARCHIVED threads never reach
    // here: the lens keeps them out of `comments` (they live in the archives list of the panel),
    // so this component knows nothing about that state.
    // An entry may carry `lost: true` (+ `name`/`file`): its file is no longer in the diff at
    // all — the lens hands those to the FIRST file so they stay findable. They render in the
    // outdated block and are never re-anchored (their snippet belongs to ANOTHER file: a match
    // here would be a coincidence pinning the thread to a confidently wrong line).
    comments = [],
    onComment = null,         // ({ side, start, end, text, snippet }) => void — new thread
    onDelete = null,          // (id) => void — pending threads only
    onEdit = null,            // (id, text) => void — rewrite a pending thread's text
    onReply = null,           // (id, text) => void — follow-up inside a thread (sent instantly)
    onArchive = null,         // (id, archived) => void — archived threads leave the diff entirely
    // A thread to reveal, as { kind: 'thread', id } — fired blindly at every DiffView of the
    // file, only the one actually holding it reacts. A definition never lands here: it opens
    // a card in place (see `definitionAt`) rather than moving you somewhere else.
    focus = null,
    // ({ word, side, line, start, end, local }) => void — the modifier-click on a symbol.
    // `local` is the declaration already found in THIS file, if any, so the caller can answer
    // with no request at all. `start`/`end` locate the word in the line's text, so the caller
    // can hand them back as `markAt` and keep it underlined.
    // Null disables the gesture entirely (conversation diffs, read-only previews).
    onSymbol = null,
    // Le symbole cliqué, gardé marqué tant que sa carte est ouverte :
    // { side, line, start, end } — offsets dans le TEXTE de la ligne, donc ils survivent à un
    // re-rendu (ouverture d'un gap, arrivée d'un blame) là où une Range serait caduque.
    markAt = null,
    // Où insérer la carte de définition, et quoi y rendre. `definitionAt` = { side, line } :
    // la carte s'ouvre EN LIGNE, juste sous cette ligne, comme un « peek » d'IDE. Le contenu
    // arrive en snippet pour que ce composant n'ait à connaître ni la session, ni l'API, ni
    // DefPeek — il ne sait que la POSITION.
    definitionAt = null,
    definition = null,
    // Do the line numbers of this section match the FILE's? True for a whole-file diff (VCS,
    // Branch, a `write` op), false for a Claude `edit`, whose oldStr/newStr are fragments.
    // Gates both the local resolution and the jump: a fragment-relative number would send you
    // to a confidently wrong line.
    wholeFile = false,
    // git blame of the hovered line: { file, old, new, load } — `old`/`new` are the revisions
    // each side of this diff comes from ('' = working tree, null = don't blame that side), and
    // `load(rev)` fetches the blame of `file` at `rev`. Null disables the feature entirely.
    blame = null,
  } = $props();

  const lang = $derived(langFromName(name));
  // Pour symbolAt, on passe l'EXTENSION brute et pas `lang` : langFromName vise la COLORATION
  // et mappe .svelte sur 'html', une table sans aucun mot-clé — `function`, `return`, `import`
  // devenaient cliquables dans tout fichier Svelte. L'extension retombe sur SYMBOL_KW.svelte.
  const symLang = $derived(((name || '').split('.').pop() || '').toLowerCase());
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
  const oldLines = $derived((oldStr || '').split('\n'));
  const newLines = $derived((newStr || '').split('\n'));
  const src = (side) => (side === 'old' ? oldLines : newLines);
  function snippetFor(side, start, end) {
    return src(side).slice(Math.max(0, start - 1), Math.max(start, end)).join('\n');
  }
  const commentsAt = (side, endLine) => anchoredThreads.filter((c) => c.side === side && c.end === endLine);

  // GitHub-style click-drag range selection. Press the "+" on a line and drag over other lines of
  // the same side; releasing opens the comment editor for the whole range. A plain click (press +
  // release on one line) comments a single line.
  let draft = $state(null); // committed-open editor: { side, start, end, text }
  let drag = $state(null);  // active drag: { side, anchor, focus }
  function startDrag(side, lineNo, e) {
    if (!commentable || lineNo == null) return;
    // With the modifier held the click means "go to definition", not "comment". Bail BEFORE
    // arming `drag`: the window-level pointerup below would otherwise open a comment editor
    // on release, and the preventDefault would eat the click.
    if (e && modHeld(e)) return;
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
  // Focus the editor as it opens. The `autofocus` ATTRIBUTE could not be trusted here: a document
  // honours it only for the first autofocus element it ever processes, so every editor opened after
  // that one — the first comment on the next file, typically — came up unfocused and you had to
  // click into it. An action runs on every insertion instead. The rAF lets the rows around the
  // draft settle first, so focus is not taken by a textarea that is about to be re-created.
  function focusOnOpen(node) {
    const id = requestAnimationFrame(() => node.focus());
    return { destroy: () => cancelAnimationFrame(id) };
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

  // ── re-anchoring ── the code may have moved since a thread was created (typically: Claude's
  // fix, addressing the very comment, shifts the commented lines). Each thread's anchor is
  // verified against its stored snippet; a moved snippet drags its thread along, a vanished or
  // ambiguous one turns the thread `outdated` — shown at the head of the diff, never pinned to
  // a wrong line. Display-only: the stored anchor remains the historical truth.
  const threadView = $derived(comments.map((c) => (c.lost
    ? { ...c, outdated: true } // another file's thread: straight to the outdated block, no reanchor
    : { ...c, ...reanchor(c, src(c.side)) })));
  const anchoredThreads = $derived(threadView.filter((c) => !c.outdated));
  const outdatedThreads = $derived(threadView.filter((c) => c.outdated));
  const outdatedNote = $derived.by(() => {
    const lost = outdatedThreads.filter((c) => c.lost).length;
    if (!lost) return 'the code they were anchored to has changed';
    if (lost === outdatedThreads.length) return 'their file is no longer in this diff';
    return 'the code they were anchored to has changed or left this diff';
  });

  // Per-thread UI state: the open reply editor and the folded threads.
  //
  // Folding is manual and local: clicking the HEAD of a thread collapses it to a one-liner, and
  // clicking that one-liner opens it again. It replaces the fold that used to come for free with
  // the `resolved` state — nothing folds itself any more, a long thread you are done reading is
  // yours to put away, and it comes back on the next reload (a diff is not a filing cabinet;
  // archiving is, cf. the panel).
  let replyDraft = $state(null);      // { id, text } — one reply editor open at a time
  let folded = $state({});            // thread id → collapsed?
  const toggleFold = (id) => (folded = { ...folded, [id]: !folded[id] });
  function startReply(id) { replyDraft = { id, text: '' }; }
  function commitReply() {
    const d = replyDraft;
    if (d && d.text.trim() && onReply) onReply(d.id, d.text.trim());
    replyDraft = null;
  }
  // Editing a PENDING thread: its text has not gone to Claude yet, so it is still a draft. The
  // editor replaces the message in place, pre-filled; sent threads only get replies.
  let editDraft = $state(null);       // { id, text } — one edit open at a time
  function startEdit(c) { editDraft = { id: c.id, text: c.messages[0]?.text || '' }; }
  function commitEdit() {
    const d = editDraft;
    if (d && d.text.trim() && onEdit) onEdit(d.id, d.text.trim());
    editDraft = null;
  }

  // ── reveal a thread from the outside ─────────────────────────────────────────────────────
  // The review's comment list jumps to a thread by id: the lens switches to the right file and
  // hands the id down as `focus`. A file's diff is rendered as ONE DiffView per edit section, so
  // every section receives the same target and only the one actually holding the thread lights
  // up — no coordination needed upstream.
  // The card may be off-DOM: `compact` (and a plain collapsed gap) hides unchanged lines, and a
  // thread anchored to one of them renders nowhere. So: look, then open every gap of this view
  // and look again. Failing that the click stays a no-op — better than scrolling to a wrong line.
  const FLASH_MS = 2000;       // keep in step with the dv-flash keyframes
  let focused = $state(null);  // id of the thread flashing right now
  let focusTimer = 0;

  // The card may be off-DOM: `compact` (and a plain collapsed gap) hides unchanged lines, and
  // a thread anchored to one of them renders nowhere. So: look, then open every gap of this
  // view and look again. Failing that the click stays a no-op — better than scrolling to a
  // wrong line.
  function revealThread(tid, retry) {
    const node = root && root.querySelector(`[data-thread="${CSS.escape(tid)}"]`);
    if (node) {
      const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      node.scrollIntoView({ block: 'center', behavior: still ? 'auto' : 'smooth' });
      focused = tid;
      focusTimer = setTimeout(() => { focused = null; }, FLASH_MS);
      return;
    }
    if (!retry) return;
    const gaps = rows.filter((r) => r.kind === 'gap').map((r) => r.seg);
    if (!gaps.length) return;
    expand = { ...expand, ...Object.fromEntries(gaps.map((seg) => [seg, { all: true }])) };
    requestAnimationFrame(() => revealThread(tid, false));
  }

  // Tracks `focus` ONLY: the reads below are untracked because they are also written here
  // or would re-run the jump on every edit of the thread list.
  $effect(() => {
    const tid = focus?.id;
    clearTimeout(focusTimer);
    focused = null;
    if (!tid || !untrack(() => threadView).some((c) => c.id === tid)) return;
    // a folded thread is a one-liner — jumping to it is a request to READ it
    untrack(() => { if (folded[tid]) folded = { ...folded, [tid]: false }; });
    const raf = requestAnimationFrame(() => revealThread(tid, true));
    return () => { cancelAnimationFrame(raf); clearTimeout(focusTimer); };
  });

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

  // ── blame of the hovered line ────────────────────────────────────────────────────────────
  // Hovering a line asks the server for that side's blame (once per revision, then cached) and
  // annotates the hovered line INLINE — dimmed, at the end of the line, GitLens style. The
  // annotation sits BESIDE `.dv-code`, never inside it, so it stays out of the text selection
  // and out of the occurrence-echo walker below. The blame is keyed by LINE
  // NUMBER, so it is only trusted when the blamed line's text still matches the one on screen —
  // a diff can show content newer than the revision blamed (e.g. Claude's own uncommitted edit).
  let hover = $state(null);       // { side, line } — the line under the pointer
  let blameData = $state({});     // rev -> payload | 'loading' | 'error'
  $effect(() => { blame?.file; blameData = {}; hover = null; }); // new file → drop the blames

  const blameRev = (side) => {
    if (!blame || !blame.load) return null;
    const r = side === 'old' ? blame.old : blame.new;
    return typeof r === 'string' ? r : null;
  };
  function setHover(side, lineNo) {
    if (lineNo == null || !blame) { if (hover) hover = null; return; }
    if (hover && hover.side === side && hover.line === lineNo) return;
    hover = { side, line: lineNo };
  }
  $effect(() => {
    const h = hover;
    if (!h) return;
    const rev = blameRev(h.side);
    if (rev == null || blameData[rev] !== undefined) return;
    const file = blame.file;
    blameData = { ...blameData, [rev]: 'loading' };
    blame.load(rev)
      .then((r) => { if (blame.file === file) blameData = { ...blameData, [rev]: r || 'error' }; })
      .catch(() => { if (blame.file === file) blameData = { ...blameData, [rev]: 'error' }; });
  });

  // { state: 'loading' | 'ok', … } for the annotation; null when there is nothing to show.
  const hoverBlame = $derived.by(() => {
    const h = hover;
    if (!h) return null;
    const rev = blameRev(h.side);
    if (rev == null) return null;
    const d = blameData[rev];
    if (d === undefined || d === 'loading') return { state: 'loading' };
    if (d === 'error' || !d.supported || !d.lines?.length) return null;
    const rec = d.lines[h.line - 1];
    if (!rec) return null;
    const shown = (h.side === 'old' ? oldLines : newLines)[h.line - 1];
    if (shown === undefined || rec.t !== shown) return null; // stale blame → stay silent
    const c = d.commits[rec.c];
    if (!c) return null;
    return {
      state: 'ok', side: h.side, line: h.line,
      author: c.uncommitted ? 'Not committed yet' : (c.author || 'unknown'),
      uncommitted: c.uncommitted,
      when: c.time ? ago(new Date(c.time * 1000).toISOString()) : '',
      // for an uncommitted line git's "summary" is boilerplate ("Version of x from x") — drop it
      summary: c.uncommitted ? '' : (c.summary || ''),
      rev: c.rev || '',
    };
  });

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

  // ── go to definition ────────────────────────────────────────────────────────────────────
  // Holding the modifier turns the code into links. The hover is entirely LOCAL — it never
  // touches the server — and it says two different things (see app.css): a solid underline
  // means the declaration is in this very file, so the jump is certain and free; a dotted one
  // means it will have to be asked of the server, and may come back empty. Underlining
  // everything alike would promise a definition for every local variable and parameter.
  const SYM_ON = 'hooked-symbol', SYM_MAYBE = 'hooked-symbol-maybe';
  let symRaf = 0;
  let symHit = null;   // { word, side, line, local } — what a click would resolve

  // localDeclaration re-scans the whole side; memoise per (side, word) and drop it when the
  // content changes, exactly like hlCache.
  let localCache = new Map();
  $effect(() => { oldStr; newStr; name; localCache = new Map(); });
  function localFor(side, word) {
    if (!wholeFile) return null;   // fragment-relative numbers: a "line" here is not a file line
    const key = side + '\0' + word;
    if (!localCache.has(key)) localCache.set(key, localDeclaration(side === 'old' ? oldStr : newStr, langOfPath(name), word));
    return localCache.get(key);
  }

  function clearSym() {
    if (symHit) symHit = null;
    clearSymbols([SYM_ON, SYM_MAYBE]);
  }

  function trackSymbol(e) {
    symRaf = 0;
    if (!onSymbol || !peek.mod) return clearSym();
    const hit = symbolUnderPointer(e, { lineSelector: '.dv-code', lang: symLang });
    if (!hit) return clearSym();
    const cell = hit.lineEl.closest('[data-side]');
    const side = cell?.dataset.side, line = Number(cell?.dataset.line);
    if (!side) return clearSym();
    const local = localFor(side, hit.word);
    symHit = { word: hit.word, side, line: Number.isFinite(line) ? line : null, start: hit.start, end: hit.end, local };
    if (highlightsSupported()) {
      clearSymbols([SYM_ON, SYM_MAYBE]);
      paintSymbol(local ? SYM_ON : SYM_MAYBE, hit.range);
    }
  }

  // The caret hit-test is recomputed on every move rather than cached: when the blame lands
  // (async) `.dv-code` switches to `flex: 0 1 auto` and the box shrinks under the cursor.
  function onSymMove(e) {
    if (!onSymbol) return;
    if (!peek.mod) { if (symHit) clearSym(); return; }
    if (symRaf) return;
    symRaf = requestAnimationFrame(() => trackSymbol(e));
  }
  // Releasing the key must put the code back to normal without waiting for a mouse move.
  $effect(() => { if (!peek.mod) clearSym(); });
  $effect(() => () => { if (symRaf) cancelAnimationFrame(symRaf); clearSymbols([SYM_ON, SYM_MAYBE]); });

  function onSymDown(e) {
    // Keep the click from collapsing the selection (which would repaint the occurrence echo)
    // and from starting a text selection under the pointer.
    if (onSymbol && modHeld(e) && symHit) e.preventDefault();
  }
  function onSymClick(e) {
    if (!onSymbol || !modHeld(e)) return;
    if (!symHit) trackSymbol(e);      // clic sans survol préalable (clavier, tablette)
    if (!symHit) return;
    e.preventDefault();
    e.stopPropagation();
    onSymbol({ ...symHit });
  }

  // Marquage PERSISTANT du symbole cliqué : il reste souligné tant que sa carte est ouverte,
  // même après avoir relâché la touche, même après un scroll. Repeint à chaque re-rendu des
  // lignes (ouverture d'un gap, bascule unified/split) car la Range précédente est alors
  // caduque — d'où les offsets texte plutôt qu'une Range mémorisée.
  const SYM_PIN = 'hooked-symbol-pinned';
  $effect(() => {
    const m = markAt;
    rows; expand; mode;            // dépendances suivies : tout ce qui re-rend les lignes
    if (!m) { clearSymbols([SYM_PIN]); return; }
    const raf = requestAnimationFrame(() => {
      const cell = root && root.querySelector(`[data-side="${m.side}"][data-line="${m.line}"]`);
      const code = cell && cell.querySelector('.dv-code');
      if (!code || !paintRangeIn(SYM_PIN, code, m.start, m.end)) clearSymbols([SYM_PIN]);
    });
    return () => cancelAnimationFrame(raf);
  });
  $effect(() => () => clearSymbols([SYM_PIN]));
  const isDefAt = (side, lineNo) => !!definitionAt && !!definition && definitionAt.side === side && definitionAt.line === lineNo;

  // the inline annotation belongs to the hovered line only
  const blameOn = (side, lineNo) =>
    (hoverBlame && hover && hover.side === side && hover.line === lineNo) ? hoverBlame : null;

  const rangeLabel = (side, start, end) => {
    const p = side === 'old' ? '−' : '+';
    return start === end ? `${p}L${end}` : `${p}L${start}–${end}`;
  };
</script>

<svelte:window onpointerup={endDrag} />

<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<!-- The modifier-click on a symbol lives on the container, not on the lines: an identifier is
     usually a bare text node (highlight.js wraps only keywords, literals and calls), so there
     is nothing per-symbol to bind to. The keyboard path is the `goto-definition` binding on
     the current selection, handled by the lens. -->
<div class="dv {mode}" bind:this={root} class:commentable class:dv-dragging={!!drag}
     class:dv-mod={peek.mod && !!onSymbol}
     onpointerleave={() => { hover = null; clearSym(); }}
     onpointermove={onSymMove} onpointerdown={onSymDown} onclick={onSymClick}
     style={mode === 'split' ? `--dv-l:${ratio}fr;--dv-r:${1 - ratio}fr;--dv-k:${ratio}` : null}>
  {#if mode === 'split'}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions, a11y_no_noninteractive_tabindex -->
    <div class="dv-split-grip" role="separator" aria-label="Resize the diff columns" aria-orientation="vertical"
         tabindex="0" title="Drag to resize the two sides · double-click to reset"
         onpointerdown={startSplitDrag} ondblclick={() => (ui.diffRatio = RATIO.def)}
         onkeydown={nudgeSplit}></div>
  {/if}
  {#if outdatedThreads.length}
    <div class="dv-outdated">
      <div class="dv-outdated-head">
        <Icon name="warning" size={12} />
        {outdatedThreads.length} outdated comment{outdatedThreads.length > 1 ? 's' : ''} — {outdatedNote}
      </div>
      <div class="dv-comments">
        {#each outdatedThreads as c (c.id)}
          {@render threadCard(c, c.side)}
        {/each}
      </div>
    </div>
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
           data-side={side} data-line={lineNo}
           onpointerenter={() => { overLine(side, lineNo); setHover(side, lineNo); }}>
        <span class="dv-no">{r.oldNo ?? ''}</span>
        <span class="dv-no">{r.newNo ?? ''}</span>
        <span class="dv-sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ''}</span>
        {#if commentable}
          <button class="dv-plus" title="Comment — click a line or drag over several"
                  onpointerdown={(e) => startDrag(side, lineNo, e)}>+</button>
        {/if}
        <span class="dv-line">
          <code class="dv-code">{@html hl(r.text)}</code>
          {#if blameOn(side, lineNo)}{@render blameTag(blameOn(side, lineNo))}{/if}
        </span>
      </div>
      {#if slot.list.length || slot.draft}
        {@render commentSlot(slot, side, lineNo)}
      {/if}
      {#if isDefAt(side, lineNo)}<div class="dv-def">{@render definition()}</div>{/if}
    {:else}
      <div class="dv-row s">
        <span class="dv-no">{r.left ? r.left.no : ''}</span>
        <span class="dv-cell {r.left ? (r.kind === 'change' ? 'del' : 'ctx') : 'empty'}" class:dv-inrange={r.left && inDraft('old', r.left.no)}
              data-side={r.left ? 'old' : null} data-line={r.left ? r.left.no : null}
              onpointerenter={() => { if (r.left) { overLine('old', r.left.no); setHover('old', r.left.no); } }}>
          {#if commentable && r.left}<button class="dv-plus" title="Comment — click a line or drag over several" onpointerdown={(e) => startDrag('old', r.left.no, e)}>+</button>{/if}
          <code class="dv-code">{@html r.left ? hl(r.left.text) : ''}</code>
          {#if r.left && blameOn('old', r.left.no)}{@render blameTag(blameOn('old', r.left.no))}{/if}
        </span>
        <span class="dv-no">{r.right ? r.right.no : ''}</span>
        <span class="dv-cell {r.right ? (r.kind === 'change' ? 'add' : 'ctx') : 'empty'}" class:dv-inrange={r.right && inDraft('new', r.right.no)}
              data-side={r.right ? 'new' : null} data-line={r.right ? r.right.no : null}
              onpointerenter={() => { if (r.right) { overLine('new', r.right.no); setHover('new', r.right.no); } }}>
          {#if commentable && r.right}<button class="dv-plus" title="Comment — click a line or drag over several" onpointerdown={(e) => startDrag('new', r.right.no, e)}>+</button>{/if}
          <code class="dv-code">{@html r.right ? hl(r.right.text) : ''}</code>
          {#if r.right && blameOn('new', r.right.no)}{@render blameTag(blameOn('new', r.right.no))}{/if}
        </span>
      </div>
      {@const ls = r.left ? slotFor('old', r.left.no) : { list: [], draft: false }}
      {@const rs = r.right ? slotFor('new', r.right.no) : { list: [], draft: false }}
      {#if ls.list.length || ls.draft}{@render commentSlot(ls, 'old', r.left.no)}{/if}
      {#if rs.list.length || rs.draft}{@render commentSlot(rs, 'new', r.right.no)}{/if}
      {#if (r.left && isDefAt('old', r.left.no)) || (r.right && isDefAt('new', r.right.no))}
        <div class="dv-def">{@render definition()}</div>
      {/if}
    {/if}
  {/each}
</div>

{#snippet blameTag(b)}
  <span class="dv-blame" class:loading={b.state === 'loading'}>
    {#if b.state === 'loading'}
      …
    {:else}
      <span class="dv-blame-who" class:wip={b.uncommitted}>{b.author}</span>{#if b.when}, {b.when}{/if}{#if b.summary}
        <span class="dv-blame-sep">•</span> <span class="dv-blame-msg">{b.summary}</span>{/if}{#if b.rev && !b.uncommitted}
        <span class="dv-blame-rev">{b.rev}</span>{/if}
    {/if}
  </span>
{/snippet}

{#snippet threadCard(c, side)}
      {#if folded[c.id]}
        <button class="dv-thread-folded" data-thread={c.id} class:flash={focused === c.id}
                title="Open this comment again" onclick={() => toggleFold(c.id)}>
          <Icon name="chevron-right" size={12} /> {c.lost && c.name ? c.name + ' ' : ''}{rangeLabel(side, c.start, c.end)} ·
          {c.messages.length} message{c.messages.length > 1 ? 's' : ''}
          <span class="dv-thread-peek">{c.messages[0]?.text}</span>
        </button>
      {:else}
        <div class="dv-thread" data-thread={c.id} class:flash={focused === c.id}>
          <!-- The head folds the thread; the actions sit OUTSIDE that button, so archiving or
               deleting never doubles as a fold (and the nesting stays legal HTML). -->
          <div class="dv-thread-head">
            <button class="dv-thread-fold" title="Collapse this comment" onclick={() => toggleFold(c.id)}>
              <Icon name="chevron-down" size={12} />
              <span class="dv-bubble-anchor" title={c.lost ? c.file : null}>{c.outdated ? 'was ' : ''}{c.lost && c.name ? c.name + ' ' : ''}{rangeLabel(side, c.start, c.end)}</span>
              {#if c.lost}<span class="dv-thread-badge outdated">left the diff</span>
              {:else if c.outdated}<span class="dv-thread-badge outdated">outdated</span>{/if}
              {#if !c.sent}<span class="dv-thread-badge pending">pending</span>{/if}
            </button>
            <span class="dv-thread-actions">
              {#if c.sent && onArchive}
                <button class="dv-tbtn" title="Archive — it leaves the diff for the archives list"
                        onclick={() => onArchive(c.id, true)}>archive</button>
              {/if}
              {#if !c.sent && onEdit}
                <button class="dv-tbtn" title="Edit comment — it has not been sent yet" onclick={() => startEdit(c)}><Icon name="pencil" size={12} /></button>
              {/if}
              {#if !c.sent && onDelete}
                <button class="dv-tbtn" title="Remove comment" onclick={() => onDelete(c.id)}><Icon name="close" size={12} /></button>
              {/if}
            </span>
          </div>
          {#if c.outdated && c.snippet}<pre class="dv-thread-snip">{c.snippet}</pre>{/if}
          {#if editDraft && editDraft.id === c.id}
            <div class="dv-editor">
              <textarea use:focusOnOpen rows="2" bind:value={editDraft.text}
                        placeholder="Edit the comment…  (⌘/Ctrl+Enter to save · Esc to cancel)"
                        onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); editDraft = null; } }}></textarea>
              <div class="dv-editor-bar">
                <button class="dv-btn" onclick={() => (editDraft = null)}>Cancel</button>
                <button class="dv-btn primary" onclick={commitEdit}>Save</button>
              </div>
            </div>
          {:else}
            {#each c.messages as msg, mi (mi)}
              <div class="dv-msg {msg.author}">
                <span class="dv-msg-who">{msg.author === 'claude' ? 'Claude' : 'You'}</span>
                <!-- `md` is the global markdown skin (app.css); a <div>, not a <span>: the
                     rendered markdown carries block elements. -->
                <div class="dv-msg-text md"><Markdown text={msg.text} /></div>
              </div>
            {/each}
          {/if}
          {#if c.sent && onReply}
            {#if replyDraft && replyDraft.id === c.id}
              <div class="dv-editor">
                <textarea use:focusOnOpen rows="2" bind:value={replyDraft.text}
                          placeholder="Reply — sent to Claude immediately  (⌘/Ctrl+Enter to send · Esc to cancel)"
                          onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitReply(); } else if (e.key === 'Escape') { e.preventDefault(); replyDraft = null; } }}></textarea>
                <div class="dv-editor-bar">
                  <button class="dv-btn" onclick={() => (replyDraft = null)}>Cancel</button>
                  <button class="dv-btn primary" onclick={commitReply}>Reply</button>
                </div>
              </div>
            {:else}
              <button class="dv-reply-open" onclick={() => startReply(c.id)}>Reply…</button>
            {/if}
          {/if}
        </div>
      {/if}
{/snippet}

{#snippet commentSlot(slot, side, lineNo)}
  <div class="dv-comments">
    {#each slot.list as c (c.id)}
      {@render threadCard(c, side)}
    {/each}
    {#if slot.draft}
      <div class="dv-editor">
        <div class="dv-editor-lbl">Comment on {rangeLabel(side, draft.start, draft.end)}{#if draft.start !== draft.end} · {draft.end - draft.start + 1} lines{/if}</div>
        <textarea use:focusOnOpen rows="2" bind:value={draft.text}
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
  /* Modifier held: the grip is a 9px-wide overlay sitting ON the code at z-index 4, so a
     cmd+click within ~4px of the column boundary would never reach .dv-code. */
  .dv.dv-mod .dv-split-grip { pointer-events: none; }
  .dv.dv-mod .dv-code { cursor: pointer; }

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
  .dv-cell { position: relative; display: flex; min-width: 0; overflow: hidden; }
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


  /* inline blame — dimmed, right after the last character of the hovered line (GitLens style).
     It is a SIBLING of .dv-code: inside it, the text would join the selection and the occurrence
     echo. The code box shrink-wraps its text (flex: 0 1 auto) so the annotation starts exactly
     where the line ends; the annotation itself is a ZERO-WIDTH flex item whose content overflows
     to the right, so it takes no space in the layout and can never re-wrap the code under it.
     Whatever does not fit is simply clipped at the edge of the line's own box. */
  .dv-line { display: flex; align-items: baseline; min-width: 0; overflow: hidden; }
  .dv-line .dv-code, .dv-cell:has(.dv-blame) .dv-code { flex: 0 1 auto; }
  .dv-blame {
    flex: 0 0 auto; width: 0; pointer-events: none; user-select: none;
    color: #6a7180; font-size: 10.5px; font-style: italic; white-space: nowrap;
  }
  .dv-blame::before { content: ''; display: inline-block; width: 10px; } /* gap, outside the box */
  .dv-blame.loading { opacity: .55; }
  .dv-blame-who { color: #8b93a7; font-weight: 700; font-style: normal; }
  .dv-blame-who.wip { color: var(--accent); }
  .dv-blame-sep { opacity: .55; }
  .dv-blame-rev { opacity: .7; }

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

  /* carte de définition « peek », insérée sous la ligne cliquée — même gouttière que les
     commentaires, pour qu'un bloc inséré dans le flux du diff se lise toujours pareil */
  .dv-def { background: rgba(255,255,255,.02); padding: 4px 12px 4px 52px; font-family: var(--font); }

  /* comments */
  .dv-comments { background: rgba(255,255,255,.02); padding: 4px 12px 4px 52px; font-family: var(--font); }
  .dv-thread {
    margin: 4px 0; padding: 8px 10px;
    background: var(--surface); border: 1px solid var(--border2); border-left: 3px solid var(--accent);
    border-radius: 10px; display: flex; flex-direction: column; gap: 6px;
  }
  /* landing mark of a jump from the comment list — the scroll alone leaves you hunting for
     which card you were sent to. Only background/shadow animate: touching border-color would
     grey out the accent/success left bar for the length of the animation. */
  .dv-thread.flash, .dv-thread-folded.flash { animation: dv-flash 2s ease-out; }
  @keyframes dv-flash {
    0%, 55% { background: rgba(var(--accent-rgb), .13); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), .25); }
    100% { background: var(--surface); box-shadow: 0 0 0 3px rgba(var(--accent-rgb), 0); }
  }
  .dv-thread-head { display: flex; align-items: center; gap: 8px; }
  .dv-thread-fold {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;
    background: none; border: none; padding: 0; margin: 0; cursor: pointer; color: var(--muted);
    font: inherit; text-align: left;
  }
  .dv-thread-fold:hover { color: var(--text); }
  .dv-bubble-anchor { font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--accent-d); }
  .dv-thread-badge {
    font-family: var(--mono); font-size: 9.5px; font-weight: 700; text-transform: uppercase;
    padding: 1px 7px; border-radius: 999px; display: inline-flex; align-items: center; gap: 3px;
  }
  .dv-thread-badge.pending { background: rgba(var(--accent-rgb), .14); color: var(--accent-d); }
  .dv-thread-badge.outdated { background: color-mix(in srgb, var(--warning, #c98a1b) 16%, transparent); color: var(--warning, #c98a1b); }
  .dv-thread-actions { margin-left: auto; display: flex; gap: 6px; }
  .dv-tbtn {
    background: none; border: none; padding: 0 2px; cursor: pointer;
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  }
  .dv-tbtn:hover { color: var(--text); }
  .dv-msg { display: flex; gap: 8px; align-items: baseline; }
  .dv-msg-who { flex: 0 0 52px; font-family: var(--mono); font-size: 10px; font-weight: 700; color: var(--muted); text-align: right; }
  .dv-msg.claude .dv-msg-who { color: var(--accent-d); }
  /* No `white-space: pre-wrap` here: the text is rendered markdown (breaks:true already turns
     newlines into <br>), pre-wrap would re-render the whitespace BETWEEN the emitted tags. */
  .dv-msg-text { flex: 1 1 auto; min-width: 0; font-size: 12.5px; color: var(--text); word-break: break-word; overflow-wrap: anywhere; }
  /* markdown injected via {@html} → :global, same values as .bubble .md (see Plan.svelte). */
  .dv-msg-text :global(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .dv-msg-text :global(a:hover) { color: var(--accent-d); }
  .dv-msg-text :global(code) { font-family: var(--mono); font-size: 11.5px; }
  .dv-msg-text :global(:not(pre) > code) { background: var(--code-inline); padding: 1px 5px; border-radius: 5px; }
  .dv-msg-text :global(blockquote) { margin: 6px 0; padding: 2px 0 2px 12px; border-left: 3px solid rgba(var(--ink-rgb),.38); color: var(--muted); }
  .dv-msg-text :global(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; max-width: 100%; }
  .dv-msg-text :global(th), .dv-msg-text :global(td) { border: 1px solid rgba(var(--ink-rgb),.28); padding: 4px 9px; text-align: left; vertical-align: top; }
  .dv-msg-text :global(th) { background: rgba(var(--ink-rgb),.12); font-weight: 700; }
  .dv-reply-open {
    align-self: flex-start; margin-left: 60px; background: none; border: none; padding: 0;
    color: var(--muted); font-size: 11.5px; cursor: pointer; font-family: var(--font);
  }
  .dv-reply-open:hover { color: var(--accent-d); }
  .dv-thread-snip {
    margin: 0 0 0 60px; padding: 6px 9px; border-radius: 8px; overflow-x: auto;
    background: var(--code-bg); border: 1px solid var(--border2);
    font-family: var(--mono); font-size: 11px; line-height: 1.5; color: #8b93a7;
  }
  .dv-outdated { border-bottom: 1px solid var(--border); background: rgba(255,255,255,.015); padding-bottom: 2px; }
  .dv-outdated-head {
    display: flex; align-items: center; gap: 6px; padding: 6px 12px 2px;
    font-family: var(--mono); font-size: 10.5px; font-weight: 700; color: var(--warning, #c98a1b);
  }
  .dv-thread-folded {
    display: flex; align-items: center; gap: 6px; width: 100%; margin: 4px 0; padding: 5px 10px;
    background: var(--surface); border: 1px solid var(--border2); border-left: 3px solid var(--accent);
    border-radius: 10px; cursor: pointer; text-align: left;
    font-family: var(--mono); font-size: 10.5px; color: var(--muted);
  }
  .dv-thread-folded:hover { border-color: var(--border); color: var(--text); }
  .dv-thread-peek { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font); font-size: 11.5px; opacity: .8; }
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
