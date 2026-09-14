<script>
  // Branch lens: the FULL diff of one branch vs a base (merge-base → branch head), like a PR's
  // "Files changed" view — same three-column model as Ship:
  //   • left rail  — changed files with per-file +N/−M and a review checkmark (J/K/V);
  //   • center     — ONE file's diff at a time, rendered by DiffView, with inline comments;
  //   • right panel — totals, the branch → base pair, and the batched-comments send button.
  // The branch picker defaults to the repo's current branch; the base defaults to the repo's
  // default branch (origin/HEAD, else main/master).
  import { untrack } from 'svelte';
  import DiffView from './DiffView.svelte';
  import Grip from './Grip.svelte';
  import ReviewComments from './ReviewComments.svelte';
  import DefPeek from './DefPeek.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { toSegments, countStats } from '$lib/difflines.js';
  import { getVcsBranches, getVcsBranchDiff, getVcsBlame,
           getReviewThreads, postReviewComment, editReviewThread, deleteReviewThread,
           replyReviewThread, archiveReviewThread, markReviewSent, reply as sendToSession } from '$lib/api.js';
  import { settings, ui } from '$lib/state.svelte.js';
  import { editorFor } from '$lib/editors.js';
  import { getSymbolDefs } from '$lib/api.js';
  import { fingerprint, isReviewed as hasReview, toggleReviewed as tickReview, nextUnreviewed,
           toMap as reviewedToMap, toEntries as reviewedToEntries } from '$lib/reviewState.js';
  import { loadDraft, saveDraft } from '$lib/reviewDraft.js';
  import { threadInstructions } from '$lib/reviewPrompt.js';
  import { getBinding, matchesEvent, formatKeys } from '$lib/shortcuts.js';

  let { s, id, onReview = null, canReview = true, active = false } = $props();

  const VCS_META = { git: { icon: 'git', label: 'Git' }, jj: { icon: 'jujutsu', label: 'Jujutsu' } };

  // ── branches (per repo) ─────────────────────────────────────────────────────────────────────
  let meta = $state({ loaded: false, loading: false, error: null, vcs: null, branches: [], def: null, repos: [] });
  let selectedRepo = $state(null);
  let branch = $state(null); // branch under review
  let base = $state(null);   // base branch the diff is computed against
  const vcsMeta = $derived(VCS_META[meta.vcs] || { icon: 'git', label: 'VCS' });

  let branchesRefreshing = false; // quiet reload in flight — plain var, nothing renders it
  async function loadBranches(root = null, force = false, quiet = false) {
    if (meta.loading || branchesRefreshing || (meta.loaded && !force && !quiet && root === selectedRepo)) return;
    // A QUIET reload keeps the current list on screen (no loading flash) and, on failure, keeps
    // the last good one: nobody asked for it, an error card would be worse than staleness.
    if (quiet) branchesRefreshing = true;
    else meta = { ...meta, loading: true, error: null };
    try {
      const r = await getVcsBranches(id, root);
      meta = { loaded: true, loading: false, error: null, vcs: r.vcs, branches: r.branches || [], def: r.default, repos: r.repos || [] };
      selectedRepo = root || r.root || null;
      const names = (r.branches || []).map((b) => b.name);
      if (!branch || !names.includes(branch)) branch = (r.branches || []).find((b) => b.current)?.name || r.default || names[0] || null;
      if (!base || !names.includes(base)) base = r.default || null;
      if (force) diffCache = {};
    } catch (_) {
      if (!quiet) meta = { ...meta, loading: false, loaded: true, error: 'Failed to list the branches.' };
    } finally {
      branchesRefreshing = false;
    }
  }
  $effect(() => {
    const a = active, stale = diffStale; // deps read BEFORE guards (Svelte 5 trap)
    if (!a) return;
    if (stale) untrack(() => { diffStale = false; lastQuietAt = Date.now(); refreshQuiet(); });
    else loadBranches(untrack(() => selectedRepo));
  });

  function selectRepo(root) {
    if (selectedRepo === root) return;
    branch = null;
    base = null;
    activeIdx = 0;
    loadBranches(root, true);
  }

  // ── the branch diff itself (cached per repo:base:branch) ───────────────────────────────────
  let diffCache = $state({}); // `${root}:${base}:${branch}` -> { changes, mergeBase }
  let diffLoading = $state(false);
  const diffKey = $derived(selectedRepo && branch && base ? selectedRepo + ':' + base + ':' + branch : null);

  // Keyed by repo:base:branch and DEDUPED by key: the effect below and a jump from the comment
  // list can both ask for the same diff in the same tick, and the jump has to await the very
  // fetch the effect started — two `git diff` for one key would be pure waste.
  const diffInFlight = new Map(); // key -> promise
  function loadDiff(key) {
    if (diffInFlight.has(key)) return diffInFlight.get(key);
    const p = (async () => {
      try {
        const r = await getVcsBranchDiff(id, branch, base, selectedRepo);
        diffCache = { ...diffCache, [key]: { changes: r.changes || [], mergeBase: r.mergeBase, merged: !!r.merged } };
      } catch (_) {
        diffCache = { ...diffCache, [key]: { changes: [], mergeBase: null, merged: false } };
      } finally {
        diffInFlight.delete(key);
        diffLoading = false;
      }
    })();
    diffInFlight.set(key, p);
    return p;
  }
  $effect(() => {
    const key = diffKey;
    if (!key || diffCache[key]) return;
    untrack(() => { diffLoading = true; loadDiff(key); });
  });
  const changes = $derived(diffKey ? (diffCache[diffKey]?.changes || []) : []);
  // Branch already merged into the base: the server recovered the HISTORICAL diff via the
  // merge commit (or nothing, for a squash/fast-forward merge) — worth a banner either way.
  const merged = $derived(diffKey ? !!diffCache[diffKey]?.merged : false);

  function pick(name) { branch = name; activeIdx = 0; }
  function pickBase(name) { base = name; activeIdx = 0; }
  function refresh() { loadBranches(selectedRepo, true); }

  // ── auto-refresh after Claude acts ── same contract as Ship's VCS view (see Ship.svelte).
  // A branch diff is NOT immutable (its head moves with every commit), so unlike Ship's
  // commitCache every cached pair goes stale with the turn: keep only the one on screen (still
  // readable while its replacement is fetched in place) and drop the rest — the loading effect
  // refetches them lazily if revisited. The branches list is reloaded too: ahead/behind counts,
  // a branch Claude created, the current-branch marker.
  function refreshQuiet() {
    loadBranches(selectedRepo, false, true);
    const key = diffKey;
    diffCache = key && diffCache[key] ? { [key]: diffCache[key] } : {};
    if (key) loadDiff(key);
  }
  const opCount = $derived((s?.changes || []).reduce((n, c) => n + (c.rawOps || c.ops || []).length, 0));
  let diffStale = $state(false);
  let lastOps = null, wasWorking = false, lastQuietAt = 0;
  const QUIET_EVERY_MS = 5000;
  $effect(() => {
    const ops = opCount;                    // tracked deps read BEFORE any guard (Svelte 5 trap)
    const working = s?.state === 'working';
    untrack(() => {
      const turnEnded = wasWorking && !working;
      const opsMoved = lastOps !== null && ops !== lastOps;
      lastOps = ops; wasWorking = working;
      if (!turnEnded && !opsMoved) return;
      if (!meta.loaded) return;             // never opened → the first loadBranches will be fresh
      if (!active) { diffStale = true; return; }
      if (!turnEnded && working && Date.now() - lastQuietAt < QUIET_EVERY_MS) return;
      lastQuietAt = Date.now();
      diffStale = false;
      refreshQuiet();
    });
  });

  // VCS entries are single old→new edits; key sections per branch pair so inline comments
  // never collide across branches (or with the Ship lens) on the same file.
  // wholeFile : une entrée de diff de branche est un old→new du fichier ENTIER (makeEntry,
  // vcsDiff.js), donc ses numéros de ligne SONT ceux du fichier — un saut à la ligne est sûr.
  const fileDiffs = (c) => (c.ops || []).map((o, j) => ({ oldStr: o.old || '', newStr: o.new || '', opIndex: 'br:' + diffKey + ':' + j, wholeFile: true }));

  // +N/−M per file, and totals across the branch.
  const fileStats = $derived.by(() => {
    const m = new Map();
    for (const c of changes) {
      let adds = 0, dels = 0;
      if (!c.binary) for (const d of fileDiffs(c)) { const st = countStats(toSegments(d.oldStr, d.newStr)); adds += st.adds; dels += st.dels; }
      m.set(c.file, { adds, dels });
    }
    return m;
  });
  const totals = $derived.by(() => {
    let adds = 0, dels = 0;
    for (const v of fileStats.values()) { adds += v.adds; dels += v.dels; }
    return { adds, dels, files: changes.length };
  });

  // active file (clamped to the visible list)
  let activeIdx = $state(0);
  $effect(() => { changes.length; untrack(() => { if (activeIdx >= changes.length) activeIdx = Math.max(0, changes.length - 1); }); });
  const activeFile = $derived(changes[activeIdx] || null);

  // Blame under the cursor: this diff runs from the fork point (merge-base, or the base branch
  // when there is none) to the branch head, so each side is blamed at that revision. DiffView
  // ignores the answer when the blamed line's text no longer matches the line on screen.
  const mergeBase = $derived(diffKey ? (diffCache[diffKey]?.mergeBase || null) : null);
  const blameFor = $derived.by(() => {
    if (!activeFile || activeFile.binary || meta.vcs === 'jj') return null;
    return {
      file: activeFile.file,
      old: mergeBase || base || null,
      new: branch || null,
      load: (rev) => getVcsBlame(id, activeFile.file, rev),
    };
  });

  // ── review ticks ── bound to the CONTENT reviewed, not just to the path ─────────────────
  // `fileFp` fingerprints the diff a file currently shows; a tick stores that fingerprint. So a
  // file edited after being ticked comes back un-ticked (rail AND the reviewed N/M counters),
  // while going back to a state already signed off shows its tick again.
  let reviewed = $state(new Map()); // file -> [fingerprint of each state signed off]
  const fps = $derived(new Map(changes.map((c) => [c.file, fileFp(c)])));
  const isReviewed = (f) => hasReview(reviewed, f, fps.get(f));
  function toggleReviewed(f) { reviewed = tickReview(reviewed, f, fps.get(f)); }
  // Marking (not un-marking) auto-advances to the next un-reviewed file; already-ticked
  // neighbours are skipped, and with nothing left ahead you stay put. J/K still walk every file.
  function reviewCurrent() {
    if (!activeFile) return;
    const wasReviewed = isReviewed(activeFile.file);
    toggleReviewed(activeFile.file);
    if (wasReviewed) return;
    const next = nextUnreviewed(changes, activeIdx, (c) => isReviewed(c.file));
    if (next !== -1) activeIdx = next;
  }
  const reviewedCount = $derived(changes.filter((c) => isReviewed(c.file)).length);

  // Branch entries are a single old→new edit per file; a base or branch swap changes them, and
  // with them the fingerprint.
  function fileFp(c) {
    return fingerprint((c.ops || []).flatMap((o) => [o.old || '', o.new || '']));
  }

  // diff style — shared with Ship (same localStorage keys: one preference for both lenses).
  let mode = $state((typeof localStorage !== 'undefined' && localStorage.getItem('hooked.shipDiff')) || 'split');
  $effect(() => { try { localStorage.setItem('hooked.shipDiff', mode); } catch {} });
  let compact = $state(typeof localStorage !== 'undefined' && localStorage.getItem('hooked.shipCompact') === '1');
  $effect(() => { try { localStorage.setItem('hooked.shipCompact', compact ? '1' : '0'); } catch {} });

  // Narrow mode: same rule as Ship — side columns collapse, diff forced unified.
  let wrapEl = $state(null);
  let narrow = $state(false);
  $effect(() => {
    if (!wrapEl) return;
    const ro = new ResizeObserver(() => { narrow = wrapEl.clientWidth < 760; });
    ro.observe(wrapEl);
    return () => ro.disconnect();
  });
  const effMode = $derived(narrow ? 'unified' : mode);

  // ── review threads — same protocol as Ship (server-side store, see Ship.svelte) ────────────
  let threads = $state([]);
  async function loadThreads() {
    if (!id) return;
    try { const r = await getReviewThreads(id); threads = r.threads || []; } catch (_) {}
  }
  $effect(() => { id; loadThreads(); });
  $effect(() => { ui.tick; if (active) loadThreads(); });

  // Archived comments are out of the batch: archiving a pending one is "keep the note, don't
  // send it".
  const pendingThreads = $derived(threads.filter((t) => !t.sent && t.status !== 'archived'));
  const pending = $derived(pendingThreads.length);
  async function addComment(file, opIndex, name, payload) {
    const r = await postReviewComment(id, { file, opIndex, name, ...payload });
    if (r && r.thread) threads = [...threads, r.thread];
  }
  async function delComment(tid) {
    const before = threads;
    threads = threads.filter((t) => t.id !== tid);
    // Optimiste, mais un refus ne doit PAS passer inaperçu : `jpost` ne lève pas sur un non-2xx
    // (il renvoie { ok:false }), donc un try/catch seul avalait l'échec — le thread revenait au
    // rafraîchissement suivant sans explication. On le remet en place tout de suite.
    let r = null;
    try { r = await deleteReviewThread(id, tid); } catch (_) {}
    if (!r || !r.ok) threads = before;
  }
  // Rewrite a comment that is still pending — the server refuses once it went to Claude. Same
  // optimistic-with-rollback shape as delComment.
  async function editComment(tid, text) {
    const before = threads;
    threads = threads.map((t) => (t.id === tid ? { ...t, messages: [{ ...t.messages[0], text }, ...t.messages.slice(1)] } : t));
    let r = null;
    try { r = await editReviewThread(id, tid, text); } catch (_) {}
    if (!r || !r.ok) threads = before;
  }
  // Archiving is the reviewer's "done": the thread leaves the diff (commentsFor drops it) and
  // shows up in the archives list of this panel, restorable. Claude has no tool for it — its
  // replies used to close the thread they answered, so the diff emptied itself.
  async function archiveComment(tid, archived) {
    threads = threads.map((t) => (t.id === tid ? { ...t, status: archived ? 'archived' : 'open' } : t));
    try { await archiveReviewThread(id, tid, archived); } catch (_) {}
  }
  async function replyComment(tid, text) {
    const t = threads.find((x) => x.id === tid);
    if (!t) return;
    threads = threads.map((x) => (x.id === tid ? { ...x, status: 'open', messages: [...x.messages, { author: 'user', text, ts: new Date().toISOString() }] } : x));
    try { await replyReviewThread(id, tid, text); } catch (_) {}
    if (!canReview) return;
    const prompt =
      `Follow-up on review thread ${tid} — ${t.file} (${anchorLabel(t)}):\n> ${text.replace(/\n/g, '\n> ')}\n` +
      threadInstructions(id);
    try { await sendToSession(id, prompt); } catch (_) {}
  }
  const commentsFor = (file, opIndex) =>
    threads.filter((c) => c.file === file && c.opIndex === opIndex && c.status !== 'archived')
      .map((c) => ({ id: c.id, side: c.side, start: c.start, end: c.end, snippet: c.snippet, sent: c.sent, messages: c.messages }));

  // ── jumping from the comment list ───────────────────────────────────────────────────────
  // Clicking a row opens the file the thread is anchored to AND scrolls to the thread itself:
  // `jumpTarget` goes down to every DiffView of that file and the one holding the thread reveals
  // + flashes it (see its `focus` prop).
  //
  // The BRANCH PAIR has to be restored first: `opIndex` is `br:<repo>:<base>:<branch>:<j>` (see
  // fileDiffs) and `commentsFor` hands a thread only to the section whose key matches exactly.
  // A comment left while comparing another pair is rendered nowhere on the current one, so the
  // click would open the file and stop there. Anything that is not a `br:` key belongs to the
  // Ship lens and cannot be shown here at all (cf. `jumpable`).
  function threadContext(opIndex) {
    // greedy repo root: a path may hold a colon, a git ref may not
    const m = /^br:(.+):([^:]+):([^:]+):\d+$/.exec(String(opIndex || ''));
    return m ? { root: m[1], base: m[2], branch: m[3] } : null;
  }
  const jumpable = (t) => !!threadContext(t.opIndex);

  async function restoreContext(ctx) {
    // the branch LIST is per-repo, and loadBranches resets base/branch to that repo's default →
    // switch repo first, pick the pair after.
    if (ctx.root && ctx.root !== selectedRepo) {
      selectedRepo = ctx.root;
      await loadBranches(ctx.root, true);
    }
    base = ctx.base;
    branch = ctx.branch;
    const key = ctx.root + ':' + ctx.base + ':' + ctx.branch;
    if (!diffCache[key]) { diffLoading = true; await loadDiff(key); }
  }

  let jumpTarget = $state(null); // { kind, …, idx } — cible à révéler, et le fichier où elle est
  // Returns false when the comment cannot be reached — the list says so rather than looking broken.
  async function jumpToComment(t) {
    const ctx = threadContext(t.opIndex);
    if (!ctx) return false;
    await restoreContext(ctx);
    // `changes` is derived, so it already reflects the restored branch pair here
    const i = changes.findIndex((c) => c.file === t.file);
    if (i < 0) return false;   // not in that diff after all (branch rewritten, file dropped)
    activeIdx = i;
    jumpTarget = { kind: 'thread', id: t.id, idx: i };
    return true;
  }
  // A jump is spent as soon as you navigate away. Without this the target would still be around
  // when J/K walks back to that file later, and re-mounting its DiffView would re-scroll and
  // re-flash a thread nobody asked for.
  $effect(() => { activeIdx; untrack(() => { if (jumpTarget && jumpTarget.idx !== activeIdx) jumpTarget = null; }); });

  // ── go to definition ────────────────────────────────────────────────────────────────────
  // Même modèle que Ship : la définition dans un fichier du diff de branche se révèle sur
  // place (rail + focus, avec le retry d'ouverture des gaps), sinon repli sur l'éditeur, à la
  // bonne LIGNE. Ici les révisions sont des noms de branche, pas des SHA (cf. blameFor).
  let symMsg = $state(null);
  let symTimer = 0;
  function saySym(text) {
    clearTimeout(symTimer);
    symMsg = text;
    symTimer = setTimeout(() => (symMsg = null), 4000);
  }
  const revForSide = (side) => {
    const b = blameFor;
    if (!b) return '';
    const r = side === 'old' ? b.old : b.new;
    return typeof r === 'string' ? r : '';
  };
  // Carte de définition ouverte EN LIGNE sous la ligne cliquée (cf. Ship, même modèle).
  let def = $state(null);
  $effect(() => { activeIdx; untrack(() => { def = null; }); });

  async function gotoDefinition(file, opIndex, { word, side, line, start, end, local }) {
    if (!activeFile) return;
    const rev = revForSide(side);
    const openHere = (t) => {
      symMsg = null;
      def = { opIndex, atSide: side, atLine: line, atStart: start, atEnd: end,
              file: t.file, rel: t.rel, line: t.line, rev, symbol: word, kind: t.kind };
    };

    // Une définition n'emmène JAMAIS ailleurs : elle s'ouvre en carte, sous la ligne cliquée.
    // Déplacer le rail et faire défiler jusqu'à un autre fichier, c'est faire perdre sa place
    // à quelqu'un qui voulait juste jeter un œil.
    // 1. déjà déclarée dans le fichier affiché → la carte s'ouvre sans la moindre requête.
    if (local) return openHere({ file, rel: activeFile.name, line: local.line, kind: local.kind });

    // 2. sinon on demande au dépôt.
    saySym('Looking up ' + word + '…');
    let r;
    try { r = await getSymbolDefs(id, word, file, rev); } catch (_) { r = null; }
    if (!r || !r.supported) return saySym(r && r.timedOut ? 'Lookup timed out.' : 'No repository to search.');
    if (r.origin) return saySym(word + ' comes from ' + r.origin.specifier + ' — not in this repo.');
    if (r.jump) return openHere(r.jump);
    // Ambigu ? La carte s'ouvre quand même, sur une LISTE — un toast qui dit « 2 déclarations
    // possibles » et disparaît est un échec du geste, pas une réponse. Les références seules
    // s'affichent aussi, titrées comme telles : on ne présente jamais une référence comme une
    // définition.
    const candidates = r.declarations.length ? r.declarations : r.references;
    if (!candidates.length) return saySym('No declaration found.');
    symMsg = null;
    def = { opIndex, atSide: side, atLine: line, atStart: start, atEnd: end,
            rev, symbol: word, candidates,
            refsOnly: !r.declarations.length, referenceCount: r.referenceCount };
  }

  const anchorLabel = (c) => {
    const p = c.side === 'old' ? '−L' : '+L';
    return c.start === c.end ? p + c.end : p + c.start + '–' + c.end;
  };
  function buildReviewPrompt() {
    const items = [];
    for (const c of changes) {
      const forFile = pendingThreads.filter((lc) => lc.file === c.file).sort((a, b) => String(a.opIndex).localeCompare(String(b.opIndex)) || a.start - b.start);
      for (const lc of forFile) {
        const snip = (lc.snippet || '').split('\n').map((l) => '   | ' + l).join('\n');
        const body = (lc.messages[0]?.text || '').replace(/\n/g, '\n   > ');
        items.push(`${items.length + 1}) ${c.file} (${anchorLabel(lc)}) [thread_id: ${lc.id}]\n   > ${body}\n   Relevant code:\n${snip}`);
      }
    }
    if (!items.length) return '';
    return `I reviewed the full diff of branch \`${branch}\` against \`${base}\` and left the following inline comments. Address each one, then, for each: ` +
      threadInstructions(id) + '\n\n' + items.join('\n\n');
  }

  let sending = $state(false);

  // ── draft persistence ── only the "reviewed" ticks still live client-side (comments are
  // server threads now). Same key/shape as before, comments left empty.
  const draftKey = $derived(id ? 'branch:' + id : null);
  $effect(() => {
    const k = draftKey;
    untrack(() => {
      const d = loadDraft(k);
      reviewed = reviewedToMap(d.reviewed);
    });
  });
  $effect(() => {
    const snap = { comments: [], reviewed: reviewedToEntries(reviewed) };
    untrack(() => saveDraft(draftKey, snap));
  });

  async function sendReview() {
    if (!onReview || !pending || sending) return;
    const prompt = buildReviewPrompt();
    if (!prompt) return;
    sending = true;
    const ids = pendingThreads.map((t) => t.id);
    try {
      await onReview(prompt);
      threads = threads.map((t) => (ids.includes(t.id) ? { ...t, sent: true } : t));
      await markReviewSent(id, ids);
    } finally { sending = false; }
  }

  // keyboard: J/K next/prev file, V mark reviewed — only while Branch is the active lens.
  const reviewKeys = getBinding('review-file');
  const reviewKey = formatKeys(reviewKeys);
  function onKey(e) {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); activeIdx = Math.min(changes.length - 1, activeIdx + 1); }
    else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); }
    else if (matchesEvent(reviewKeys, e)) {
      if (!activeFile) return;
      e.preventDefault();
      reviewCurrent();
    }
  }
  // ── panel sizing ── the rails resize through the shared <Grip>, on the SAME persisted
  // widths as the Ship lens so the two twin layouts stay in sync.
  const FILES_W = { min: 150, max: 520, def: 232 };
  const PANEL_W = { min: 200, max: 620, def: 288 };

</script>

<svelte:window onkeydown={onKey} />

<div class="branch-wrap" bind:this={wrapEl}>
  <!-- ── branch picker + base select ── chips = the branch under review (default: the current
       branch); the "vs" select = the base the diff is computed against (default: main). -->
  <div class="ship-turns">
    <span class="st-label">Branch</span>
    <div class="st-scroll">
      {#if meta.loading && !meta.branches.length}<span class="st-one">Loading branches…</span>{/if}
      {#each meta.branches as b (b.name)}
        <button class="st-chip st-branch" class:on={branch === b.name} title={b.name} onclick={() => pick(b.name)}>
          <Icon name="git-branch" size={11} /> {b.name}{#if b.current}<span class="st-cur">current</span>{/if}
        </button>
      {/each}
    </div>
    <label class="st-base">
      vs
      <select value={base} onchange={(e) => pickBase(e.currentTarget.value)} title="Base branch the diff is computed against (merge-base)">
        {#each meta.branches as b (b.name)}<option value={b.name}>{b.name}</option>{/each}
      </select>
    </label>
    <button class="st-refresh" title="Reload the branches and the diff" onclick={refresh}>
      <Icon name="rotate-cw" size={12} />
    </button>
  </div>
  <!-- ── repo picker (several repos detected) ── same behaviour as Ship's VCS mode. -->
  {#if meta.loaded && meta.repos.length > 1}
    <div class="ship-repos">
      <span class="st-label">Repository</span>
      <div class="st-scroll">
        {#each meta.repos as r (r.root)}
          <button class="st-chip" class:on={selectedRepo === r.root} title={r.root} onclick={() => selectRepo(r.root)}>
            <Icon name={(VCS_META[r.kind] || vcsMeta).icon} size={11} /> {r.label || r.root.split('/').pop()}
          </button>
        {/each}
      </div>
    </div>
  {/if}
  {#if meta.loading && !meta.loaded}
    <div class="ship-empty">Loading the branches…</div>
  {:else if meta.error}
    <div class="ship-empty">{meta.error}</div>
  {:else if meta.loaded && !meta.vcs}
    <div class="ship-empty">This project is not in a git or jj repository.</div>
  {:else if meta.loaded && !meta.branches.length}
    <div class="ship-empty">No local branches in this repository.</div>
  {:else if diffLoading}
    <div class="ship-empty">Loading the branch diff…</div>
  {:else if branch && branch === base}
    <div class="ship-empty">The branch and the base are the same — pick another base to compare against.</div>
  {:else if !changes.length && merged}
    <div class="ship-empty">Branch <b>{branch}</b> is already merged into <b>{base}</b> (squash or fast-forward — no historical diff to recover).</div>
  {:else if !changes.length}
    <div class="ship-empty">No difference between <b>{branch}</b> and <b>{base}</b> — the branch has no commits of its own yet.</div>
  {:else}
  {#if merged}
    <div class="br-merged">
      <Icon name="check" size={13} /> Already merged into <b>{base}</b> — showing the branch's historical diff, recovered from its merge commit.
    </div>
  {/if}
  <div class="ship" style="--ship-files-w:{ui.shipFilesWidth}px;--ship-panel-w:{ui.shipPanelWidth}px">
    <!-- ── file rail ── -->
    <aside class="ship-files">
      <div class="sf-head">
        <span class="sf-title">Files</span>
        <span class="sf-rev">reviewed {reviewedCount}/{changes.length}</span>
      </div>
      <div class="sf-list">
        {#each changes as c, i (c.file)}
          {@const st = fileStats.get(c.file) || { adds: 0, dels: 0 }}
          <button class="sf-item" class:on={i === activeIdx} onclick={() => (activeIdx = i)} title={c.file}>
            <span class="sf-dot" class:done={isReviewed(c.file)}>{#if isReviewed(c.file)}<Icon name="check" size={11} tint={false} />{/if}</span>
            <span class="sf-name">{c.name}</span>
            <span class="sf-stat">
              {#if c.binary}<span class="sf-bin">bin</span>{:else}<span class="sf-add">+{st.adds}</span> <span class="sf-del">−{st.dels}</span>{/if}
            </span>
          </button>
        {/each}
      </div>
      <div class="sf-foot">
        <div class="sf-prog"><i style="width:{changes.length ? Math.round((reviewedCount / changes.length) * 100) : 0}%"></i></div>
        <div class="sf-hint">J/K next file · {reviewKey} mark reviewed</div>
      </div>
    </aside>
    <Grip value={ui.shipFilesWidth} set={(w) => (ui.shipFilesWidth = w)}
          min={FILES_W.min} max={FILES_W.max} def={FILES_W.def} label="Resize the file list" />

    <!-- ── diff ── -->
    <div class="ship-diff">
      {#if activeFile}
        <div class="sd-head">
          <span class="sd-name">{activeFile.name}</span>
          <span class="sd-path" title={activeFile.file}>{activeFile.file}</span>
          <a class="sd-editor" href={editorFor(settings.editor).fileUrl(activeFile.file)} title={'Open in ' + editorFor(settings.editor).label}><Icon name="external" size={12} /> editor</a>
          <div class="sd-modes">
            <button class:on={effMode === 'unified'} onclick={() => (mode = 'unified')} title="Unified"><Icon name="menu" size={14} /></button>
            <button class:on={effMode === 'split'} onclick={() => (mode = 'split')} title="Side-by-side"><Icon name="pane" size={14} /></button>
          </div>
          <label class="sd-compact" title="Hide the unchanged context lines">
            <input type="checkbox" bind:checked={compact} /> compact
          </label>
          <button class="sd-review" class:done={isReviewed(activeFile.file)} onclick={reviewCurrent}
                  title="Mark this file reviewed ({reviewKey})">
            {#if isReviewed(activeFile.file)}<Icon name="check" size={14} /> Reviewed{:else}Mark reviewed{/if}
          </button>
        </div>
        <div class="sd-body">
          {#if symMsg}<div class="sd-sym">{symMsg}</div>{/if}
          {#if activeFile.binary}
            <div class="sd-empty">Binary file — no diff.</div>
          {:else}
            {#snippet defCard()}
              <DefPeek {id} target={def} onClose={() => (def = null)} />
            {/snippet}
            {#each fileDiffs(activeFile) as d (d.opIndex)}
              <DiffView oldStr={d.oldStr} newStr={d.newStr} name={activeFile.name} mode={effMode} {compact}
                        blame={blameFor}
                        wholeFile={!!d.wholeFile}
                        onSymbol={(p) => gotoDefinition(activeFile.file, d.opIndex, p)}
                        markAt={def && def.opIndex === d.opIndex ? { side: def.atSide, line: def.atLine, start: def.atStart, end: def.atEnd } : null}
                        definitionAt={def && def.opIndex === d.opIndex ? { side: def.atSide, line: def.atLine } : null}
                        definition={defCard}
                        commentable={!!onReview}
                        comments={commentsFor(activeFile.file, d.opIndex)}
                        focus={jumpTarget}
                        onComment={(p) => addComment(activeFile.file, d.opIndex, activeFile.name, p)}
                        onDelete={delComment} onEdit={editComment} onReply={replyComment} onArchive={archiveComment} />
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <Grip value={ui.shipPanelWidth} set={(w) => (ui.shipPanelWidth = w)}
          min={PANEL_W.min} max={PANEL_W.max} def={PANEL_W.def} invert label="Resize the side panel" />

    <!-- ── side panel ── -->
    <aside class="ship-panel">
      <div class="sp-card">
        <h4>Branch diff</h4>
        <div class="sp-check"><span class="sp-ico"><Icon name="git-branch" size={14} /></span> <span class="sp-mono">{branch}</span></div>
        <div class="sp-check"><span class="sp-ico"><Icon name="arrow-left" size={14} /></span> vs <span class="sp-mono">{base}</span></div>
        <div class="sp-check"><span class="sp-ico"><Icon name="diff" size={14} /></span> {totals.files} file{totals.files > 1 ? 's' : ''} · <span class="sf-add">+{totals.adds}</span> <span class="sf-del">−{totals.dels}</span></div>
        <div class="sp-check"><span class="sp-ico" class:ok={reviewedCount === changes.length}><Icon name={reviewedCount === changes.length ? 'checkbox-done' : 'circle'} size={14} /></span> reviewed {reviewedCount}/{changes.length} files</div>
        {#if pending}<div class="sp-check"><span class="sp-ico"><Icon name="pencil" size={14} /></span> {pending} comment{pending > 1 ? 's' : ''} pending</div>{/if}
      </div>

      {#if pending}
        <button class="sp-send" onclick={sendReview} disabled={sending || !canReview}
                title={canReview ? 'Send your inline comments to the session' : 'No live session to send to'}>
          {#if sending}Sending…{:else}<Icon name="send" size={14} /> Send {pending} comment{pending > 1 ? 's' : ''} to Claude{/if}
        </button>
      {/if}

      <ReviewComments {threads} onDelete={delComment} onJump={jumpToComment} canJump={jumpable}
                      onArchive={archiveComment} />

      {#if (s?.prLinks || []).length}
        <div class="sp-card">
          <h4>Pull request</h4>
          {#each s.prLinks as l}
            <a class="sp-pr" href={l} target="_blank" rel="noopener"><Icon name="pr" size={13} /> {l.replace(/^https?:\/\/github\.com\//, '')}</a>
          {/each}
        </div>
      {/if}
    </aside>
  </div>
  {/if}
</div>

<style>
  /* Same three-column skeleton as Ship — class names intentionally mirror Ship.svelte so the
     two lenses stay visually identical (Svelte scopes each copy; no leakage between them). */
  .ship-empty { padding: 40px 24px; color: var(--muted); font-size: 13px; }
  .branch-wrap { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; container-type: inline-size; }
  .ship { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; }

  /* merged-branch banner */
  .br-merged {
    flex: 0 0 auto; display: flex; align-items: center; gap: 7px; padding: 6px 14px;
    border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--success) 8%, transparent);
    color: var(--muted); font-size: 11.5px;
  }
  .br-merged b { color: var(--text); }

  /* branch picker bar */
  .ship-turns { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg2); min-width: 0; }
  .ship-repos { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-bottom: 1px solid var(--border); background: var(--bg2); min-width: 0; }
  .st-label { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); flex: 0 0 auto; }
  .st-scroll { display: flex; gap: 6px; overflow-x: auto; min-width: 0; padding-bottom: 2px; flex: 1 1 auto; }
  .st-one { font-size: 11.5px; color: var(--muted); }
  .st-chip {
    flex: 0 0 auto; max-width: 240px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--chip); border: 1px solid var(--border); border-radius: 999px;
    color: var(--muted); font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 11px; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .st-chip:hover { color: var(--text); }
  .st-chip.on { background: var(--accent-soft); border-color: rgba(var(--accent-rgb), .4); color: var(--accent-d); }
  .st-branch { font-family: var(--mono); }
  .st-cur { font-size: 9px; font-weight: 800; letter-spacing: .05em; text-transform: uppercase; opacity: .7; }
  .st-base { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
  .st-base select {
    background: var(--input); border: 1px solid var(--border); border-radius: 8px; color: var(--text);
    font: inherit; font-family: var(--mono); font-size: 11px; padding: 3px 6px; max-width: 180px; cursor: pointer;
  }
  .st-refresh {
    flex: 0 0 auto; display: inline-flex; align-items: center; background: none; border: 1px solid var(--border);
    border-radius: 999px; color: var(--muted); padding: 4px 8px; cursor: pointer;
  }
  .st-refresh:hover { color: var(--text); border-color: var(--muted); }

  /* file rail */
  .ship-files { width: var(--ship-files-w, 232px); min-width: var(--ship-files-w, 232px); border-right: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; }
  .sf-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px 7px; border-bottom: 1px solid var(--border); }
  .sf-title { font: 600 10px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .sf-rev { margin-left: auto; font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .sf-list { flex: 1 1 auto; overflow-y: auto; padding: 0; }
  .sf-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; border-bottom: 1px solid var(--border);
    background: none; border-radius: 0; cursor: pointer; text-align: left; font: inherit; color: var(--text);
  }
  .sf-item:hover { background: var(--hover); }
  .sf-item.on { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  .sf-dot {
    flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%; border: 1.5px solid var(--border2);
    display: flex; align-items: center; justify-content: center; font-size: 9px; color: #fff;
  }
  .sf-dot.done { background: var(--success); border-color: var(--success); }
  .sf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11.5px; }
  .sf-item.on .sf-name { font-weight: 700; color: var(--accent-d); }
  .sf-stat { flex: 0 0 auto; font-family: var(--mono); font-size: 10px; }
  .sf-add { color: var(--success); }
  .sf-del { color: var(--danger); }
  .sf-bin { color: var(--muted); }
  .sf-foot { border-top: 1px solid var(--border); padding: 10px 14px; }
  .sf-prog { height: 2px; border-radius: 0; background: var(--bg3); overflow: hidden; margin-bottom: 7px; }
  .sf-prog i { display: block; height: 100%; background: var(--success); transition: width .2s; }
  .sf-hint { font-family: var(--mono); font-size: 9.5px; color: var(--muted); }

  /* diff */
  .ship-diff { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--panel); }
  .sd-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .sd-name { font-family: var(--mono); font-size: 12.5px; font-weight: 700; }
  .sd-path { font-family: var(--mono); font-size: 10px; color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .sd-editor { font-family: var(--mono); font-size: 10.5px; color: var(--accent-d); text-decoration: none; flex: 0 0 auto; }
  .sd-editor:hover { text-decoration: underline; }
  .sd-modes { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; flex: 0 0 auto; }
  .sd-modes button { background: none; border: none; border-radius: 6px; color: var(--muted); font-size: 13px; padding: 2px 9px; cursor: pointer; }
  .sd-modes button.on { background: var(--accent-soft); color: var(--accent); }
  .sd-compact { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; cursor: pointer; font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
  .sd-compact input { accent-color: var(--accent); margin: 0; cursor: pointer; }
  .sd-review {
    flex: 0 0 auto; background: var(--bg3); border: 1px solid var(--border2); color: var(--text);
    border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
  }
  .sd-review.done { background: color-mix(in srgb, var(--success) 16%, transparent); border-color: var(--success); color: var(--success); }
  .sd-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; }
  /* retour bref du « go to definition » : rien à ouvrir, ou ouvert ailleurs */
  .sd-sym {
    padding: 5px 12px; font-family: var(--mono); font-size: 11px; color: var(--accent-d);
    background: rgba(var(--accent-rgb), .08); border-bottom: 1px solid var(--border);
  }
  .sd-empty { padding: 24px; color: var(--muted); font-size: 12.5px; }

  /* side panel */
  .ship-panel { width: var(--ship-panel-w, 288px); min-width: var(--ship-panel-w, 288px); border-left: 1px solid var(--border); background: var(--bg2); overflow-y: auto; padding: 0; display: flex; flex-direction: column; gap: 0; }
  .sp-card { border: none; border-radius: 0; background: transparent; border-bottom: 1px solid var(--border); padding: 12px 14px; }
  .sp-card h4 { margin: 0 0 9px; font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .sp-check { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; min-width: 0; }
  .sp-ico { flex: 0 0 auto; }
  .sp-mono { font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-send {
    background: var(--accent); color: var(--accent-fg); border: none; border-radius: 10px; padding: 9px 12px;
    font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer;
  }
  .sp-send:hover:not(:disabled) { background: var(--accent-d); }
  .sp-send:disabled { opacity: .5; cursor: default; }
  .sp-pr { display: block; font-size: 11.5px; color: var(--success); text-decoration: none; margin-bottom: 8px; word-break: break-all; }
  .sp-pr:hover { text-decoration: underline; }

  @media (max-width: 1100px) { .ship-panel { display: none; } }
  @media (max-width: 900px) { .ship-files { display: none; } }

  /* Narrow mode (split pane / small window): side columns give way to the diff. */
  @container (max-width: 760px) {
    .ship-panel { display: none; }
    .ship-files { width: min(var(--ship-files-w, 232px), 180px); min-width: min(var(--ship-files-w, 232px), 180px); }
  }
  @container (max-width: 560px) {
    .ship-files { display: none; }
  }
</style>
