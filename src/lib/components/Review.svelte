<script module>
  // The scope a session's review was left on, remembered across remounts — display memory, like
  // SessionDetail's `lastLens`; the draft below is what persists the place across reloads.
  const lastScope = new Map(); // session id → 'session' | 'tree' | 'branch'
</script>

<script>
  // Review lens — one surface for every diff worth reviewing, in three SCOPES:
  //   • session       — Claude's edits reconstructed from the transcript (net original → final,
  //                     filterable per prompt);
  //   • working tree  — the uncommitted changes as git / jj sees them, every detected repo in;
  //   • branch        — the full diff of a branch vs a base (merge-base → head), narrowable to a
  //                     contiguous slice of its commits.
  // Same three columns whatever the scope: the changed files with a review checkmark (J/K/V), ONE
  // file's diff at a time rendered by DiffView with inline comment threads, and the side panel —
  // what the review covers, the batched Send, the review's comment list, the PR.
  // Threads live server-side and are keyed by the diff SECTION they were written on (fileDiffs
  // mints the keys, one family per scope), so a thread left in another scope is reached by
  // restoring that scope first (threadContext / restoreContext).
  import { untrack, tick, onDestroy } from 'svelte';
  import DiffView from './DiffView.svelte';
  import Grip from './Grip.svelte';
  import ReviewComments from './ReviewComments.svelte';
  import DefPeek from './DefPeek.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { toSegments, countStats, applyOp } from '$lib/difflines.js';
  import { fmtCost } from '$lib/format.js';
  import { getFileChangeFull, getVcsDiff, getVcsBranches, getVcsBranchDiff, getVcsBlame, getSymbolDefs,
           getReviewThreads, postReviewComment, editReviewThread, deleteReviewThread,
           replyReviewThread, archiveReviewThread, markReviewSent, startClaudeReview, reply as sendToSession } from '$lib/api.js';
  import { settings, ui, openModal } from '$lib/state.svelte.js';
  import { editorFor } from '$lib/editors.js';
  import { fingerprint, isReviewed as hasReview, toggleReviewed as tickReview, nextUnreviewed,
           toMap as reviewedToMap, toEntries as reviewedToEntries } from '$lib/reviewState.js';
  import { loadDraft, saveDraft } from '$lib/reviewDraft.js';
  import { threadInstructions, reviewRequestPrompt } from '$lib/reviewPrompt.js';
  import { getBinding, matchesEvent, formatKeys } from '$lib/shortcuts.js';

  let { s, id, onReview = null, canReview = true, active = false } = $props();

  // ── where the review was ── read HERE, before the state below is declared, so that the very
  // first branch fetch already targets the saved repo (an effect would fire after that fetch has
  // left, and its answer would put the default repo back). SessionDetail is keyed by session id,
  // so `id` never swaps for a mounted lens — a plain constant, read once.
  // svelte-ignore state_referenced_locally
  const draftKey = id ? 'review:' + id : null;
  const draft = loadDraft(draftKey);
  const saved = draft.view || {};

  const SCOPES = [
    { key: 'session', label: 'Session', icon: 'diff', title: "Claude's edits, reconstructed from the transcript" },
    { key: 'tree', label: 'Working tree', icon: 'git', title: 'The uncommitted changes, as the version control system sees them' },
    { key: 'branch', label: 'Branch', icon: 'git-branch', title: 'The full diff of a branch against a base' },
  ];
  // svelte-ignore state_referenced_locally
  let scope = $state(lastScope.get(id) || saved.scope || 'session');
  $effect(() => { const sc = scope; untrack(() => lastScope.set(id, sc)); });
  function setScope(k) { if (scope === k) return; scope = k; activeIdx = 0; }

  // ── session scope: Claude's edits ───────────────────────────────────────────────────────────
  // Files whose content the server capped are flagged `truncated`; the FULL (uncapped) entry is
  // loaded on demand and overrides the capped one so the diff shows everything.
  let fullOverride = $state({}); // file -> full change entry
  let loadingFull = $state({});  // file -> bool
  async function loadFull(file) {
    if (loadingFull[file] || fullOverride[file]) return;
    loadingFull = { ...loadingFull, [file]: true };
    try {
      const r = await getFileChangeFull(id, file);
      if (r && r.change) fullOverride = { ...fullOverride, [file]: r.change };
    } catch (_) {
    } finally {
      loadingFull = { ...loadingFull, [file]: false };
    }
  }
  const allChanges = $derived((s?.changes || []).map((c) => fullOverride[c.file] || c));

  // Per-prompt filter. Default = the whole conversation (net original→final). The user can
  // restrict to one or more turns (prompts); op→turn is resolved by timestamp against the
  // session's prompt list.
  const turns = $derived([...(s?.changeTurns || [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts))));
  let selected = $state(new Set(Array.isArray(saved.turns) ? saved.turns : [])); // empty = all prompts
  const filtering = $derived(selected.size > 0);
  function toggleTurn(t) {
    const next = new Set(selected);
    next.has(t) ? next.delete(t) : next.add(t);
    selected = next;
  }
  function clearTurns() { selected = new Set(); }
  // turn index an op belongs to: the last prompt whose ts is ≤ the op's ts (or the first prompt).
  function opTurn(o) {
    const ts = o.ts || '';
    let idx = turns.length ? turns[0].turn : 0;
    for (const t of turns) { if (String(t.ts) <= String(ts)) idx = t.turn; else break; }
    return idx;
  }
  const fileTurns = (c) => new Set((c.rawOps || []).map(opTurn));
  const opSelected = (o) => selected.has(opTurn(o));
  const promptLabels = $derived([...selected].sort((a, b) => a - b).map((t) => 'P' + (t + 1)).join(', '));
  // Each prompt with the number of files it touched — what the scope picker lists.
  const turnsInfo = $derived(turns.map((t) => ({ ...t, files: allChanges.filter((c) => fileTurns(c).has(t.turn)).length })));

  // ── working-tree scope: the uncommitted diff, every detected repo flattened ─────────────────
  const VCS_META = { git: { icon: 'git', label: 'Git' }, jj: { icon: 'jujutsu', label: 'Jujutsu' } };
  const repoName = (p) => (p || '').split('/').filter(Boolean).pop() || p;
  let vcs = $state({ loaded: false, loading: false, error: null, kind: null, workChanges: [], repos: [], truncated: false });
  let vcsRefreshing = false; // quiet reload in flight — plain var, nothing renders it
  async function loadVcs(force = false, quiet = false) {
    if (!id || vcs.loading || vcsRefreshing || (vcs.loaded && !force && !quiet)) return;
    // A QUIET reload keeps the current diff on screen (no loading flash) and, on failure, keeps the
    // last good one: nobody asked for it, an error card would be worse than staleness.
    if (quiet) vcsRefreshing = true;
    else vcs = { ...vcs, loading: true, error: null };
    try {
      const diff = await getVcsDiff(id);
      // The rail stays a flat list (activeIdx / J-K navigation), but with several detected repos
      // each entry carries its repo so the rail can render per-repo section headers.
      const repos = diff.repos || [];
      const multi = repos.length > 1;
      const repoMeta = repos.map((r) => ({ kind: r.kind, root: r.root, label: r.label || repoName(r.root), primary: r.primary }));
      const workChanges = repos.flatMap((r, ri) => (multi ? (r.changes || []).map((c) => ({ ...c, repo: repoMeta[ri] })) : (r.changes || [])));
      vcs = { loaded: true, loading: false, error: null, kind: diff.vcs || null, workChanges, repos: repoMeta, truncated: !!diff.truncated };
    } catch (_) {
      if (!quiet) vcs = { ...vcs, loading: false, loaded: true, error: 'Failed to load the working-tree diff.' };
    } finally {
      vcsRefreshing = false;
    }
  }

  // ── branch scope: a branch vs a base, optionally a slice of its commits ─────────────────────
  let meta = $state({ loaded: false, loading: false, error: null, vcs: null, branches: [], def: null, repos: [] });
  let selectedRepo = $state(saved.repo || null);
  let branch = $state(saved.branch || null); // branch under review
  let base = $state(saved.base || null);     // base branch the diff is computed against
  const vcsMeta = $derived(VCS_META[meta.vcs || vcs.kind] || { icon: 'git', label: 'VCS' });

  let branchesRefreshing = false; // quiet reload in flight — plain var, nothing renders it
  async function loadBranches(root = null, force = false, quiet = false) {
    if (meta.loading || branchesRefreshing || (meta.loaded && !force && !quiet && root === selectedRepo)) return;
    if (quiet) branchesRefreshing = true;
    else meta = { ...meta, loading: true, error: null };
    try {
      const r = await getVcsBranches(id, root);
      meta = { loaded: true, loading: false, error: null, vcs: r.vcs, branches: r.branches || [], def: r.default, repos: r.repos || [] };
      // The server's root, not the requested one: a repo that is gone (saved place, nested clone
      // removed) falls back to the primary, and the picker must say so.
      selectedRepo = r.root || root || null;
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
  function selectRepo(root) {
    if (selectedRepo === root) return;
    branch = null;
    base = null;
    picked = [];
    activeIdx = 0;
    loadBranches(root, true);
  }

  // Commit selection: which commits of the branch the review covers. Commits are TOGGLED; none
  // picked means the whole branch. The diff is always a CONTIGUOUS slice of the branch's history
  // — from the parent of the oldest picked commit to the newest — because non-contiguous picks do
  // not add up to one old→new per file. Picks are held as REVISIONS, oldest first: the commit list
  // is refetched with every diff, and a rewritten branch must drop a pick rather than shift it.
  let picked = $state(Array.isArray(saved.picked) ? saved.picked : []);
  let commitsCache = $state({}); // pairKeyOf(…) -> commits of the branch, newest first
  const pairKeyOf = (root, base, branch) => root + ':' + base + ':' + branch;
  const pairKey = $derived(selectedRepo && branch && base ? pairKeyOf(selectedRepo, base, branch) : null);
  const commits = $derived(pairKey ? (commitsCache[pairKey] || []) : []);
  const commitIndex = (rev) => commits.findIndex((c) => c.rev === rev);
  const selSpan = $derived.by(() => {
    const at = picked.map(commitIndex).filter((i) => i >= 0);
    return at.length ? { lo: Math.min(...at), hi: Math.max(...at) } : null; // newest first
  });
  // Until the commit list is in (a saved place, a comment's context), the picks are trusted as
  // given, so the first fetch is already the narrowed one. The server normalises and re-checks.
  const selRange = $derived(selSpan ? { from: commits[selSpan.hi].rev, to: commits[selSpan.lo].rev }
                                    : (picked.length && !commits.length ? { from: picked[0], to: picked[picked.length - 1] } : null));
  const isPicked = (rev) => picked.includes(rev);
  const inSelection = (i) => !!selSpan && i >= selSpan.lo && i <= selSpan.hi;
  function toggleCommit(rev) {
    const next = isPicked(rev) ? picked.filter((r) => r !== rev) : [...picked, rev];
    picked = next.filter((r) => commitIndex(r) >= 0).sort((x, y) => commitIndex(y) - commitIndex(x));
    activeIdx = 0;
  }
  function pickAllCommits() { picked = []; activeIdx = 0; }

  // The branch diff itself, cached per repo:base:branch and per selection, and DEDUPED by key: the
  // effect below and a jump from the comment list can ask for the same diff in the same tick.
  let diffCache = $state({}); // `${pairKey}[:@from..to]` -> { changes, mergeBase, merged, range }
  let diffLoading = $state(false);
  const diffKeyOf = (pair, range) => pair + (range ? ':@' + range.from + '..' + range.to : '');
  const diffKey = $derived(pairKey ? diffKeyOf(pairKey, selRange) : null);
  const diffReq = $derived({ root: selectedRepo, base, branch, range: selRange });
  const diffInFlight = new Map(); // key -> promise
  function loadDiff(key, req) {
    if (diffInFlight.has(key)) return diffInFlight.get(key);
    const p = (async () => {
      try {
        const r = await getVcsBranchDiff(id, req.branch, req.base, req.root, req.range);
        // The commit list belongs to the branch PAIR, not to the selection: cached apart so the
        // picker keeps standing (selection included) while a narrowed diff is being fetched.
        commitsCache = { ...commitsCache, [pairKeyOf(req.root, req.base, req.branch)]: r.commits || [] };
        diffCache = { ...diffCache, [key]: { changes: r.changes || [], mergeBase: r.mergeBase, merged: !!r.merged, range: r.range || null } };
      } catch (_) {
        diffCache = { ...diffCache, [key]: { changes: [], mergeBase: null, merged: false, range: null } };
      } finally {
        diffInFlight.delete(key);
        diffLoading = false;
      }
    })();
    diffInFlight.set(key, p);
    return p;
  }
  $effect(() => {
    const key = diffKey, req = diffReq; // deps read BEFORE the guard (Svelte 5 trap)
    if (!key || diffCache[key]) return;
    untrack(() => { diffLoading = true; loadDiff(key, req); });
  });
  const merged = $derived(scope === 'branch' && diffKey ? !!diffCache[diffKey]?.merged : false);
  const mergeBase = $derived(diffKey ? (diffCache[diffKey]?.mergeBase || null) : null);
  const diffRange = $derived(diffKey ? (diffCache[diffKey]?.range || null) : null);
  function pick(name) { branch = name; picked = []; activeIdx = 0; }
  function pickBase(name) { base = name; picked = []; activeIdx = 0; }
  // A branch diff is NOT immutable (its head moves with every commit): keep only the pair on
  // screen (still readable while its replacement is fetched in place) and drop the rest.
  function refreshQuiet() {
    loadBranches(selectedRepo, false, true);
    const key = diffKey;
    diffCache = key && diffCache[key] ? { [key]: diffCache[key] } : {};
    if (key) loadDiff(key, diffReq);
  }
  const repoLabelOf = (root) => meta.repos.find((x) => x.root === root)?.label || repoName(root);
  // The scope picker (ReviewScopeModal) edits THIS state live: getters onto it, plus the actions.
  // Accessor properties pass through Svelte's state proxy untouched, so the modal's reads stay
  // reactive — the diff, and with it the commit list, follows every pick as it does from the bar.
  const picker = {
    get scope() { return scope; },
    get turns() { return turnsInfo; },
    get selected() { return selected; },
    get filtering() { return filtering; },
    toggleTurn, clearTurns,
    get repos() { return meta.repos; },
    get repo() { return selectedRepo; },
    get branches() { return meta.branches; },
    get branch() { return branch; },
    get base() { return base; },
    get commits() { return commits; },
    get picked() { return picked; },
    get span() { return selSpan; },
    get loading() { return meta.loading || diffLoading; },
    selectRepo, pick, pickBase, toggleCommit, pickAllCommits, isPicked, inSelection,
  };
  const openScope = () => openModal('reviewScope', { picker });

  // ── auto-refresh after Claude acts ── the session scope is live (hooks feed s.changes as the
  // session works) but the VCS scopes are snapshots: they go stale the moment a turn edits or
  // commits anything. Two signals cover every case: the op count moves (an edit landed; throttled
  // mid-turn) and the turn ends (covers actions that change no tracked file, e.g. `git commit`).
  // Movements seen while a scope is off screen only mark it stale — coming back reloads once.
  const opCount = $derived(allChanges.reduce((n, c) => n + (c.rawOps || c.ops || []).length, 0));
  let treeStale = $state(false);
  let branchStale = $state(false);
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
      const throttled = !turnEnded && working && Date.now() - lastQuietAt < QUIET_EVERY_MS;
      if (vcs.loaded) {
        if (scope !== 'tree' || !active) treeStale = true;
        else if (!throttled) { lastQuietAt = Date.now(); treeStale = false; loadVcs(false, true); }
      }
      if (meta.loaded) {
        if (scope !== 'branch' || !active) branchStale = true;
        else if (!throttled) { lastQuietAt = Date.now(); branchStale = false; refreshQuiet(); }
      }
    });
  });
  $effect(() => {
    const sc = scope, a = active, stale = treeStale; // deps BEFORE guards (Svelte 5 trap)
    if (sc !== 'tree') return;
    if (a && stale) {
      untrack(() => { treeStale = false; lastQuietAt = Date.now(); });
      loadVcs(false, true);
    } else loadVcs(false);
  });
  $effect(() => {
    const sc = scope, a = active, stale = branchStale; // deps BEFORE guards (Svelte 5 trap)
    if (sc !== 'branch' || !a) return;
    if (stale) untrack(() => { branchStale = false; lastQuietAt = Date.now(); refreshQuiet(); });
    else loadBranches(untrack(() => selectedRepo));
  });

  // ── the files under review, and each file's diff sections ──────────────────────────────────
  const changes = $derived(
    scope === 'branch' ? (diffKey ? (diffCache[diffKey]?.changes || []) : [])
    : scope === 'tree' ? vcs.workChanges
    : !filtering ? allChanges
    : allChanges.filter((c) => [...fileTurns(c)].some((t) => selected.has(t)))
  );

  // Diff sections for a file. VCS entries (working tree, branch) are single old→new edits of the
  // WHOLE file, keyed per scope so inline comments never collide across scopes on the same file.
  // Session sections honour the prompt filter:
  //   • no filter → the server's NET diff (c.ops), add-then-delete already cancelled;
  //   • filter + reconstructed original → replay rawOps and diff the span of the selected turns;
  //   • filter without an original → fall back to the selected raw ops, each its own section.
  function fileDiffs(c) {
    if (scope === 'branch') return (c.ops || []).map((o, j) => ({ oldStr: o.old || '', newStr: o.new || '', opIndex: 'br:' + diffKey + ':' + j, label: null, wholeFile: true }));
    if (scope === 'tree') return (c.ops || []).map((o, j) => ({ oldStr: o.old || '', newStr: o.new || '', opIndex: 'vcs:wt:' + j, label: null, wholeFile: true }));
    if (!filtering) {
      const ops = c.ops || [];
      return ops.map((o, j) => {
        // wholeFile: only a `write` carries the whole content. An `edit` shows old_string/new_string
        // only, so its line numbers are NOT the file's — jumping to them would land on the wrong line.
        if (o.kind === 'write') return { oldStr: o.old || '', newStr: o.content || '', opIndex: 'full:' + j, label: o.old ? 'full rewrite' : 'new file', wholeFile: true };
        if (o.kind === 'notebook') return { oldStr: '', newStr: o.new || '', opIndex: 'full:' + j, label: 'notebook cell', wholeFile: false };
        return { oldStr: o.old || '', newStr: o.new || '', opIndex: 'full:' + j, label: ops.length > 1 ? 'edit ' + (j + 1) : null, wholeFile: false };
      });
    }
    const raw = c.rawOps || [];
    const selIdx = raw.map((o, j) => (opSelected(o) ? j : -1)).filter((j) => j >= 0);
    if (!selIdx.length) return [];
    const key = 'sel:' + [...selected].sort().join(',');
    if (c.original != null) {
      // before[j] = content before op j, after[j] = content after it; the replay restarts from
      // `c.original`, so the section IS the whole file.
      let text = c.original;
      const before = [], after = [];
      for (let j = 0; j < raw.length; j++) { before[j] = text; text = applyOp(text, raw[j]); after[j] = text; }
      const first = selIdx[0], lastS = selIdx[selIdx.length - 1];
      return [{ oldStr: before[first], newStr: after[lastS], opIndex: key, label: null, wholeFile: true }];
    }
    return selIdx.map((j) => {
      const o = raw[j];
      if (o.kind === 'write') return { oldStr: o.old || '', newStr: o.content || '', opIndex: key + ':' + j, label: o.old ? 'full rewrite' : 'new file', wholeFile: true };
      return { oldStr: o.old || '', newStr: o.new || '', opIndex: key + ':' + j, label: 'edit ' + (j + 1), wholeFile: false };
    });
  }

  // +N/−M per file (summed across its displayed sections), and totals.
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

  // active file (clamped to the visible list, which shrinks/grows with the scope and filter)
  let activeIdx = $state(0);
  $effect(() => { changes.length; untrack(() => { if (activeIdx >= changes.length) activeIdx = Math.max(0, changes.length - 1); }); });
  const activeFile = $derived(changes[activeIdx] || null);

  // ── blame under the cursor ── which revision each side of the shown diff comes from, so
  // DiffView can ask "who wrote this line?" for the line under the pointer:
  //   • session      — new side = the working tree, old side matches no revision → not blamed;
  //   • working tree — HEAD → working tree;
  //   • branch       — fork point (merge-base, else the base branch) → branch head, or the ends of
  //                    the selected commits when the review is narrowed to some.
  // DiffView drops the answer whenever the blamed line's text no longer matches the line shown.
  // `branchNewRev` is also where "Review with Claude" anchors its threads in the branch scope.
  const branchNewRev = $derived(scope === 'branch' && meta.vcs !== 'jj' ? (diffRange ? diffRange.to : (branch || null)) : null);
  const blameFor = $derived.by(() => {
    if (!activeFile || activeFile.binary) return null;
    const load = (rev) => getVcsBlame(id, activeFile.file, rev);
    if (scope === 'branch') {
      if (meta.vcs === 'jj') return null;
      return { file: activeFile.file, old: diffRange ? diffRange.parent : (mergeBase || base || null), new: branchNewRev, load };
    }
    return { file: activeFile.file, old: scope === 'tree' ? 'HEAD' : null, new: '', load };
  });

  // ── review ticks ── bound to the CONTENT reviewed, not just to the path ─────────────────
  // `fileFp` fingerprints the diff a file currently shows; a tick stores that fingerprint. So a
  // file edited after being ticked comes back un-ticked, while going back to a state already
  // signed off shows its tick again. Ticks written by the former Ship and Branch lenses are read
  // once, so an upgrade in the middle of a review keeps them.
  // svelte-ignore state_referenced_locally
  let reviewed = $state(reviewedToMap(draft.reviewed.length
    ? draft.reviewed
    : [...loadDraft(id ? 'ship:' + id : null).reviewed, ...loadDraft(id ? 'branch:' + id : null).reviewed]));
  const fps = $derived(new Map(changes.map((c) => [c.file, fileFp(c)])));
  const isReviewed = (f) => hasReview(reviewed, f, fps.get(f));
  function toggleReviewed(f) { reviewed = tickReview(reviewed, f, fps.get(f)); }
  // "Mark reviewed" on the active file: marking it (not un-marking) auto-advances to the next
  // un-reviewed file — already-ticked neighbours are skipped, and with nothing left ahead you
  // stay put. J/K still walk every file.
  function reviewCurrent() {
    if (!activeFile) return;
    const wasReviewed = isReviewed(activeFile.file);
    toggleReviewed(activeFile.file);
    if (wasReviewed) return;
    const next = nextUnreviewed(changes, activeIdx, (c) => isReviewed(c.file));
    if (next !== -1) activeIdx = next;
  }
  const reviewedCount = $derived(changes.filter((c) => isReviewed(c.file)).length);

  // The pieces a file's on-screen diff is built from — same inputs as fileDiffs(), minus the
  // replay, so fingerprinting the whole rail stays cheap. Each scope keeps the shape its former
  // lens used, so the ticks read above still apply.
  function fileFp(c) {
    if (scope === 'branch') return fingerprint((c.ops || []).flatMap((o) => [o.old || '', o.new || '']));
    const ops = (o) => o.flatMap((x) => [x.content || '', x.old || '', x.new || '']);
    if (scope === 'tree' || !filtering) return fingerprint(ops(c.ops || []));
    return fingerprint([c.original || '', ...ops((c.rawOps || []).filter(opSelected))]);
  }

  // Diff style and compact (hide the unchanged context around each change) live in `ui`,
  // persisted. A new file (no prior version — every section is pure additions) defaults to
  // unified: a side-by-side view of an all-green file is the same text twice. The toggle still
  // wins per file via `modeOverride`, which is keyed only for new files so it never touches `ui`.
  let modeOverride = $state({});
  const isNewFile = $derived.by(() => {
    if (!activeFile) return false;
    const ds = fileDiffs(activeFile);
    return ds.length > 0 && ds.every((d) => !d.oldStr);
  });
  const defaultMode = $derived(isNewFile ? 'unified' : ui.shipDiff);
  function chooseMode(m) {
    if (isNewFile && activeFile) modeOverride = { ...modeOverride, [activeFile.file]: m };
    else ui.shipDiff = m;
  }

  // Narrow mode (split pane / small window): the three columns don't fit — the side columns
  // collapse (CSS container queries on .review-wrap) and the diff is FORCED unified (a side-by-side
  // diff in a half-pane wraps every token onto its own line — unusable).
  let wrapEl = $state(null);
  let narrow = $state(false);
  $effect(() => {
    if (!wrapEl) return;
    const ro = new ResizeObserver(() => { narrow = wrapEl.clientWidth < 760; });
    ro.observe(wrapEl);
    return () => ro.disconnect();
  });
  const effMode = $derived(
    narrow ? 'unified'
    : (activeFile && activeFile.file in modeOverride) ? modeOverride[activeFile.file]
    : defaultMode
  );

  // ── review threads (GitHub-style, anchored in the diff) ─────────────────────────────────────
  // Threads live SERVER-side (HOOKED_DIR/reviews/<id>.json), not in component state: Claude
  // writes into them (MCP reply_review_comment) and every browser sees the same conversation.
  // Flow: a new comment is a `pending` thread (batched) → "Send N comments" ships the batch and
  // marks them `sent` → follow-ups inside a thread go to the session immediately.
  let threads = $state([]);
  async function loadThreads() {
    if (!id) return;
    try { const r = await getReviewThreads(id); threads = r.threads || []; } catch (_) {}
  }
  $effect(() => { id; loadThreads(); });
  // Live refresh while the lens is active: Claude's replies appear as they happen.
  $effect(() => { ui.tick; if (active) loadThreads(); });

  // Archived comments are out of the batch: archiving a pending one is "keep the note, don't
  // send it".
  const pendingThreads = $derived(threads.filter((t) => !t.sent && t.status !== 'archived'));
  const pending = $derived(pendingThreads.length);
  async function addComment(file, opIndex, name, payload) {
    const r = await postReviewComment(id, { file, opIndex, name, ...payload });
    if (r && r.thread) threads = [...threads, r.thread];
  }
  // Optimistic with rollback: `jpost` does not throw on a non-2xx (it returns { ok:false }), so a
  // refused delete/edit would otherwise come back at the next refresh with no explanation.
  async function delComment(tid) {
    const before = threads;
    threads = threads.filter((t) => t.id !== tid);
    let r = null;
    try { r = await deleteReviewThread(id, tid); } catch (_) {}
    if (!r || !r.ok) threads = before;
  }
  // Rewrite a comment that is still pending — the server refuses once it went to Claude.
  async function editComment(tid, text) {
    const before = threads;
    threads = threads.map((t) => (t.id === tid ? { ...t, messages: [{ ...t.messages[0], text }, ...t.messages.slice(1)] } : t));
    let r = null;
    try { r = await editReviewThread(id, tid, text); } catch (_) {}
    if (!r || !r.ok) threads = before;
  }
  // Archiving is the reviewer's "done": the thread leaves the diff (commentsFor drops it) and
  // shows up in the archives list of the panel, restorable. Claude has no tool for it.
  async function archiveComment(tid, archived) {
    threads = threads.map((t) => (t.id === tid ? { ...t, status: archived ? 'archived' : 'open' } : t));
    try { await archiveReviewThread(id, tid, archived); } catch (_) {}
  }
  // Follow-up inside a sent thread: stored, then pushed to the live session IMMEDIATELY (no
  // batch, no tab switch) with the thread id so Claude answers back into the same thread.
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
  const toView = (c) => ({ id: c.id, side: c.side, start: c.start, end: c.end, snippet: c.snippet, sent: c.sent, messages: c.messages });
  const commentsFor = (file, opIndex) =>
    threads.filter((c) => c.file === file && c.opIndex === opIndex && c.status !== 'archived').map(toView);

  // ── lost threads ── their FILE left the diff they were written on (typically: Claude committed
  // and the working-tree diff emptied under the comment). They render nowhere in the rail, so they
  // are handed to the FIRST file's first section flagged `lost`: DiffView shows them in its
  // outdated block — findable, archivable, deletable. Only threads of the CURRENT scope (and
  // filter / branch pair) qualify; one from elsewhere is not lost, its jump restores its context.
  // `keyBase` mirrors the section keys fileDiffs mints for the current scope.
  const keyBase = $derived(
    scope === 'branch' ? 'br:' + diffKey
    : scope === 'tree' ? 'vcs:wt'
    : filtering ? 'sel:' + [...selected].sort().join(',')
    : 'full'
  );
  const inKey = (op) => op === keyBase || String(op || '').startsWith(keyBase + ':');
  const lostThreads = $derived.by(() => {
    const here = new Set(changes.map((c) => c.file));
    return threads.filter((t) => t.status !== 'archived' && inKey(t.opIndex) && !here.has(t.file))
      .map((t) => ({ ...toView(t), lost: true, file: t.file, name: t.name || (t.file || '').split('/').pop() }));
  });
  // ── threads Claude opened ("Review with Claude") ── keyed to the whole SCOPE (`scopeKey`), not
  // to one of its sections: Claude anchors on the file as it is on disk, i.e. the new side. Each
  // goes to the section whose new side holds its snippet — in practice the only one, unless a
  // session file's history could not be merged — else to the first.
  const scopeKey = $derived(keyBase + ':*');
  const isScoped = (t) => String(t.opIndex || '').endsWith(':*');
  const scopedHere = $derived.by(() => {
    if (!activeFile) return [];
    const mine = threads.filter((t) => t.file === activeFile.file && t.opIndex === scopeKey && t.status !== 'archived');
    if (!mine.length) return [];
    const diffs = fileDiffs(activeFile);
    return mine.map((t) => ({ ...toView(t), di: Math.max(0, t.snippet ? diffs.findIndex((d) => d.newStr.includes(t.snippet)) : 0) }));
  });
  const commentsForSection = (di, opIndex) => {
    const own = [...commentsFor(activeFile.file, opIndex), ...scopedHere.filter((t) => t.di === di)];
    return activeIdx === 0 && di === 0 && lostThreads.length ? [...lostThreads, ...own] : own;
  };

  // ── jumping from the comment list ───────────────────────────────────────────────────────
  // Clicking a row opens the file the thread is anchored to AND scrolls to the thread itself:
  // `jumpTarget` goes down to every DiffView of that file and the one holding the thread reveals
  // + flashes it (see its `focus` prop). But the CONTEXT has to be restored first: a thread's
  // `opIndex` is the key of the diff section it was written on, so it also records which scope
  // (and prompt filter, or branch pair and commit slice) produced it — and `commentsFor` hands a
  // thread ONLY to the section whose key matches exactly.
  //   full:<j>                                — session, no prompt filter
  //   sel:<turns>[:<j>]                       — session, restricted to those prompts
  //   vcs:wt:<j>                              — the working tree
  //   br:<repo>:<base>:<branch>[:@from..to]:<j> — a branch pair, optionally a commit slice
  //   vcs:<repo>:<rev>:<j>                    — the retired per-commit view: nothing shows it
  //   <any of the above, section index `*`>   — a thread Claude opened, in any section of that scope
  function threadContext(opIndex) {
    const key = String(opIndex || '');
    if (key.startsWith('br:')) {
      // Parsed from the RIGHT: a repo path may hold a colon, a branch name may not, and the
      // optional selection segment is recognised by the '@' no branch name can carry.
      const parts = key.split(':');
      parts.shift();
      if (!/^(\d+|\*)$/.test(parts.pop() || '')) return null;
      let range = null;
      if (parts.length && parts[parts.length - 1].startsWith('@')) {
        const [from, to] = parts.pop().slice(1).split('..');
        if (!from || !to) return null;
        range = { from, to };
      }
      const br = parts.pop(), bs = parts.pop(), root = parts.join(':');
      return root && bs && br ? { scope: 'branch', root, base: bs, branch: br, range } : null;
    }
    if (key === 'vcs:wt' || key.startsWith('vcs:wt:')) return { scope: 'tree' };
    if (key.startsWith('full:')) return { scope: 'session', turns: [] };
    const m = /^sel:([\d,]*)/.exec(key);
    if (m) return { scope: 'session', turns: m[1] ? m[1].split(',').map(Number).filter(Number.isFinite) : [] };
    return null;
  }
  const jumpable = (t) => !!threadContext(t.opIndex);
  const sameTurns = (want, cur) => want.length === cur.size && want.every((t) => cur.has(t));

  // Fetch FIRST, flip the scope LAST: the loading branches of the markup replace the whole `.ship`
  // subtree, which destroys ReviewComments — its open/closed state is local, so the list would
  // slam shut in the middle of the jump. Loading while still on the previous scope keeps it alive.
  async function restoreContext(ctx) {
    if (ctx.scope === 'branch') {
      // the branch LIST is per-repo, and loadBranches resets base/branch to that repo's default →
      // switch repo first, pick the pair after.
      if (ctx.root && ctx.root !== selectedRepo) { selectedRepo = ctx.root; await loadBranches(ctx.root, true); }
      else if (!meta.loaded) await loadBranches(ctx.root || selectedRepo);
      base = ctx.base;
      branch = ctx.branch;
      picked = ctx.range ? [...new Set([ctx.range.from, ctx.range.to])] : [];
      const key = diffKeyOf(pairKeyOf(ctx.root, ctx.base, ctx.branch), ctx.range);
      if (!diffCache[key]) { diffLoading = true; await loadDiff(key, { root: ctx.root, base: ctx.base, branch: ctx.branch, range: ctx.range }); }
      if (scope !== 'branch') setScope('branch');
      return;
    }
    if (ctx.scope === 'tree') {
      await loadVcs(false);
      if (scope !== 'tree') setScope('tree');
      return;
    }
    if (!sameTurns(ctx.turns, selected)) selected = new Set(ctx.turns);
    if (scope !== 'session') setScope('session');
  }

  let jumpTarget = $state(null); // { kind, id, idx } — the thread to reveal, and the file it is in
  // Returns false when the comment cannot be reached — the list says so rather than looking broken.
  async function jumpToComment(t) {
    const ctx = threadContext(t.opIndex);
    if (!ctx) return false;
    await restoreContext(ctx);
    // `changes` is derived, so it already reflects the restored scope here
    let i = changes.findIndex((c) => c.file === t.file);
    if (i < 0) {
      // The file left this diff (committed since, deleted, filtered out): the thread is surfaced
      // as `lost` at the head of the FIRST file — land there instead of reporting a miss.
      if (!changes.length || !lostThreads.some((x) => x.id === t.id)) return false;
      activeIdx = 0;
      jumpTarget = { kind: 'thread', id: t.id, idx: 0 };
      return true;
    }
    // Session sections are minted from the diff we currently HOLD, and a CAPPED file yields
    // different ones (one per raw op instead of the merged span). A thread anchored on the full
    // diff then matches no section — so load the full file and look again.
    if (ctx.scope === 'session' && !isScoped(t) && !fileDiffs(changes[i]).some((d) => d.opIndex === t.opIndex)) {
      await loadFull(t.file);
      i = changes.findIndex((c) => c.file === t.file);
      if (i < 0) return false;
    }
    activeIdx = i;
    jumpTarget = { kind: 'thread', id: t.id, idx: i };
    return true;
  }
  // A jump is spent as soon as you navigate away: otherwise re-mounting that file's DiffView later
  // (J/K) would re-scroll and re-flash a thread nobody asked for.
  $effect(() => { activeIdx; untrack(() => { if (jumpTarget && jumpTarget.idx !== activeIdx) jumpTarget = null; }); });

  // ── go to definition ── a definition NEVER takes you elsewhere: it opens as a card under the
  // clicked line (DefPeek). Declared in the shown file → no request at all; otherwise the repo is
  // asked, at the revision of the clicked side (blameFor models it — the session scope's old side
  // matches no revision, so the server answers `approximate`).
  let symMsg = $state(null);   // brief feedback when there is nothing to open
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
  // The definition card open IN the diff: { opIndex, atSide, atLine, file, rel, line, rev, symbol, kind }.
  // Anchored to a line of a file, so changing file closes it, like jumpTarget.
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
    if (local) return openHere({ file, rel: activeFile.name, line: local.line, kind: local.kind });
    saySym('Looking up ' + word + '…');
    let r;
    try { r = await getSymbolDefs(id, word, file, rev); } catch (_) { r = null; }
    if (!r || !r.supported) return saySym(r && r.timedOut ? 'Lookup timed out.' : 'No repository to search.');
    if (r.origin) return saySym(word + ' comes from ' + r.origin.specifier + ' — not in this repo.');
    if (r.jump) return openHere(r.jump);
    // Ambiguous? The card still opens, on a LIST — a toast saying "2 possible declarations" that
    // fades away is a failed gesture, not an answer. References alone show too, titled as such.
    const candidates = r.declarations.length ? r.declarations : r.references;
    if (!candidates.length) return saySym('No declaration found.');
    symMsg = null;
    def = { opIndex, atSide: side, atLine: line, atStart: start, atEnd: end,
            rev, symbol: word, candidates,
            refsOnly: !r.declarations.length, referenceCount: r.referenceCount };
  }

  // ── the review prompt ── what the batch was made against, in Claude's words ─────────────────
  const shortRev = (rev) => String(rev || '').slice(0, 8);
  const reviewScope = $derived(
    scope === 'branch'
      ? (selRange
          ? `commits \`${shortRev(selRange.from)}\`…\`${shortRev(selRange.to)}\` of branch \`${branch}\` (based on \`${base}\`)`
          : `the full diff of branch \`${branch}\` against \`${base}\``)
    : scope === 'tree' ? 'the uncommitted changes in the working tree'
    : filtering ? `your changes for prompt${selected.size > 1 ? 's' : ''} ${promptLabels}`
    : 'your changes');
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
    return `I reviewed ${reviewScope} and left the following inline comments. Address each one, then, for each: ` +
      threadInstructions(id) + '\n\n' + items.join('\n\n');
  }
  let sending = $state(false);
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

  // ── "Review with Claude" ── the session reviews the diff on screen and opens its findings as
  // threads in it. The scope is recorded first, so those threads land under it; the request then
  // goes straight to the session with no tab switch: the threads show up here as they come.
  let asking = $state(false);
  async function askReview() {
    if (!canReview || asking || !changes.length) return;
    asking = true;
    try {
      await startClaudeReview(id, scopeKey, branchNewRev);
      const brief = (t) => ({ file: t.file, anchor: anchorLabel(t), text: t.messages[0]?.text || '' });
      const here = threads.filter((t) => inKey(t.opIndex));
      await sendToSession(id, reviewRequestPrompt(id, {
        scope: reviewScope, rev: branchNewRev, files: changes.map((c) => c.file),
        open: here.filter((t) => t.status !== 'archived').map(brief),
        dismissed: here.filter((t) => t.status === 'archived').map(brief),
      }));
    } finally { asking = false; }
  }

  const PR_PROMPT =
    'Open a pull request for the current branch:\n' +
    '1. push the branch;\n' +
    "2. write a concise PR description — WHAT it does and HOW to test, not the code details;\n" +
    '3. add exactly one label: ":bookmark::bug: FIX" (bugfix), ":hammer: Technical" (technical only), ' +
    'or ":bookmark::sparkles: Feature" (new feature);\n' +
    '4. give me the PR URL when done.';
  let prBusy = $state(false);
  async function askPR() {
    if (!onReview || prBusy) return;
    prBusy = true;
    try { await onReview(PR_PROMPT); } finally { prBusy = false; }
  }

  // ── draft ── the "reviewed" ticks and the PLACE (scope, prompt filter, branch pair and commit
  // slice, open file, scroll), so the lens comes back exactly as it was left. The branch place
  // is only overwritten once a pair is known — before the branches are in, nulls would erase it.
  const view = $derived({
    scope, turns: [...selected], file: activeFile ? activeFile.file : pendingFile, scroll: bodyScroll,
    ...(selectedRepo && branch && base
      ? { repo: selectedRepo, branch, base, picked }
      : { repo: saved.repo || null, branch: saved.branch || null, base: saved.base || null, picked: saved.picked || [] }),
  });
  const snapshot = () => ({ reviewed: reviewedToEntries(reviewed), view });
  // Debounced: the scroll position is part of the snapshot and a wheel notch is many events.
  // Leaving (another session, a reload) flushes, so the last notch is not the one that is lost.
  let saveTimer = 0;
  $effect(() => {
    const snap = snapshot();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveDraft(draftKey, snap), 200);
  });
  function flushDraft() { clearTimeout(saveTimer); saveDraft(draftKey, snapshot()); }
  onDestroy(flushDraft);

  // ── landing back ── the file that was open and the scroll inside it. The file is found again
  // by PATH once the restored scope's diff is in (its index may have moved) — one shot, then the
  // user's own moves take over. The scroll goes back after that landing and every time the lens
  // becomes active again: a hidden pane is `display: none`, which has no scroll position.
  let pendingFile = $state(saved.file || null);
  let pendingScroll = saved.scroll || 0;
  let bodyEl = $state(null);
  let bodyScroll = $state(saved.scroll || 0);
  function onBodyScroll() { if (active && bodyEl) bodyScroll = bodyEl.scrollTop; }
  function restoreScroll() { tick().then(() => { if (bodyEl && active) bodyEl.scrollTop = pendingScroll; }); }
  $effect(() => {
    const list = changes, file = pendingFile;
    if (!list.length || !file) return;
    untrack(() => {
      pendingFile = null;
      const i = list.findIndex((c) => c.file === file);
      if (i >= 0) activeIdx = i;
      restoreScroll();
    });
  });
  let wasActive = false;
  $effect(() => {
    const a = active;
    untrack(() => {
      if (!a && wasActive) pendingScroll = bodyScroll;
      if (a && !wasActive) restoreScroll();
      wasActive = a;
    });
  });

  // keyboard: J/K next/prev file, V mark reviewed + advance — only while Review is the active lens
  // and the user isn't typing in a field.
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

  // ── panel sizing ── the two side rails are drag-resizable through the shared <Grip> (widths
  // persisted in `ui`); the diff column takes what's left.
  const FILES_W = { min: 150, max: 520, def: 232 };
  const PANEL_W = { min: 200, max: 620, def: 288 };
</script>

<svelte:window onkeydown={onKey} onpagehide={flushDraft} />

<div class="review-wrap" bind:this={wrapEl}>
  <!-- ── scope bar ── which diff is under review, then that scope's own controls -->
  <div class="ship-turns">
    <div class="st-toggle">
      {#each SCOPES as sc (sc.key)}
        <button class:on={scope === sc.key} onclick={() => setScope(sc.key)} title={sc.title}><Icon name={sc.icon} size={12} /> {sc.label}</button>
      {/each}
    </div>
    <button class="st-ask" onclick={askReview} disabled={asking || !canReview || !changes.length}
            title={canReview ? 'Ask Claude to review this diff — its findings open as threads here' : 'No live session to send to'}>
      <Icon name="bot" size={12} /> {asking ? 'Asking…' : 'Review with Claude'}
    </button>
    {#if scope === 'session'}
      <span class="st-label">Changes for</span>
      {#if turns.length > 1}
        <!-- One control: which prompts' changes are under review; the modal picks them. -->
        <button class="st-scope" onclick={openScope} title="Pick the prompts whose changes are under review">
          <Icon name="converse" size={11} />
          {filtering ? `prompt${selected.size > 1 ? 's' : ''} ${promptLabels}` : 'Whole conversation'}
          · {changes.length} file{changes.length === 1 ? '' : 's'}
          <Icon name="pencil" size={11} />
        </button>
      {:else}
        <span class="st-one">Whole conversation</span>
      {/if}
    {:else if scope === 'tree'}
      {#if vcs.loaded && !vcs.error && vcs.kind}
        <span class="st-one st-right">{vcs.workChanges.length} file{vcs.workChanges.length === 1 ? '' : 's'} · uncommitted</span>
      {/if}
      <button class="st-refresh" title="Reload the working-tree diff" onclick={() => loadVcs(true)}>
        <Icon name="rotate-cw" size={12} />
      </button>
    {:else}
      <span class="st-label">Branch</span>
      {#if !meta.loaded}
        <span class="st-one">{meta.loading ? 'Loading branches…' : ''}</span>
      {:else if !meta.branches.length}
        <span class="st-one">No local branches.</span>
      {:else}
        <!-- One control: what the scope currently diffs; the modal changes any part of it. -->
        <button class="st-scope" onclick={openScope} title="Change the repository, branch, base or commits under review">
          <Icon name="git-branch" size={11} />
          {#if branch}<span class="st-mono">{branch}</span> → <span class="st-mono">{base}</span>{:else}Choose a branch…{/if}
          {#if commits.length} · {selSpan ? `${selSpan.hi - selSpan.lo + 1} of ${commits.length}` : `all ${commits.length}`} commit{commits.length > 1 ? 's' : ''}{/if}
          {#if meta.repos.length > 1} · {repoLabelOf(selectedRepo)}{/if}
          <Icon name="pencil" size={11} />
        </button>
      {/if}
      <button class="st-refresh st-end" title="Reload the branches and the diff" onclick={() => loadBranches(selectedRepo, true)}>
        <Icon name="rotate-cw" size={12} />
      </button>
    {/if}
  </div>

  {#if scope === 'session' && !allChanges.length}
    <div class="ship-empty">No file changes in this session yet.</div>
  {:else if scope === 'tree' && (vcs.loading || !vcs.loaded)}
    <div class="ship-empty">Loading the working-tree diff…</div>
  {:else if scope === 'tree' && vcs.error}
    <div class="ship-empty">{vcs.error}</div>
  {:else if scope === 'tree' && !vcs.kind}
    <div class="ship-empty">This project is not in a git or jj repository.</div>
  {:else if scope === 'tree' && !changes.length}
    <div class="ship-empty">No uncommitted changes in the working tree.</div>
  {:else if scope === 'branch' && meta.error}
    <div class="ship-empty">{meta.error}</div>
  {:else if scope === 'branch' && !meta.loaded}
    <div class="ship-empty">Loading the branches…</div>
  {:else if scope === 'branch' && !meta.vcs}
    <div class="ship-empty">This project is not in a git or jj repository.</div>
  {:else if scope === 'branch' && !meta.branches.length}
    <div class="ship-empty">No local branches in this repository.</div>
  {:else if scope === 'branch' && diffLoading}
    <div class="ship-empty">Loading the branch diff…</div>
  {:else if scope === 'branch' && branch && branch === base}
    <div class="ship-empty">The branch and the base are the same — pick another base to compare against.</div>
  {:else if scope === 'branch' && !changes.length && selSpan}
    <div class="ship-empty">The selected commit{selSpan.lo === selSpan.hi ? '' : 's'} change no file — pick another slice of <b>{branch}</b>.</div>
  {:else if scope === 'branch' && !changes.length && merged}
    <div class="ship-empty">Branch <b>{branch}</b> is already merged into <b>{base}</b> (squash or fast-forward — no historical diff to recover).</div>
  {:else if scope === 'branch' && !changes.length}
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
          {#if c.repo && changes[i - 1]?.repo?.root !== c.repo.root}
            <div class="sf-repo" title={c.repo.root}>
              <Icon name={(VCS_META[c.repo.kind] || vcsMeta).icon} size={11} />
              <span class="sf-repo-name">{c.repo.label}</span>
            </div>
          {/if}
          <button class="sf-item" class:on={i === activeIdx} onclick={() => (activeIdx = i)} title={c.file}>
            <span class="sf-dot" class:done={isReviewed(c.file)}>{#if isReviewed(c.file)}<Icon name="check" size={11} tint={false} />{/if}</span>
            <span class="sf-name">{c.name}</span>
            {#if c.tool === 'Bash'}<span class="sf-cmd" title="Changed by a bash command, not an edit tool">cmd</span>
            {:else if (c.rawOps || []).length && c.rawOps.every((o) => o.agent)}<span class="sf-cmd" title="Changed by a subagent">agent</span>{/if}
            <span class="sf-stat">
              {#if c.truncated}<span class="sf-trunc" title="Large file — capped, load full to see everything"><Icon name="warning" size={12} /></span>{/if}
              {#if c.binary}<span class="sf-bin">bin</span>{:else}<span class="sf-add">+{st.adds}</span> <span class="sf-del">−{st.dels}</span>{/if}
            </span>
          </button>
        {/each}
        {#if scope === 'tree' && vcs.truncated}
          <div class="sf-truncnote">File limit reached — some repositories are truncated.</div>
        {/if}
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
            <button class:on={effMode === 'unified'} onclick={() => chooseMode('unified')} title="Unified"><Icon name="menu" size={14} /></button>
            <button class:on={effMode === 'split'} onclick={() => chooseMode('split')} title="Side-by-side"><Icon name="pane" size={14} /></button>
          </div>
          <label class="sd-compact" title="Hide the unchanged context lines">
            <input type="checkbox" bind:checked={ui.shipCompact} /> compact
          </label>
          <button class="sd-review" class:done={isReviewed(activeFile.file)} onclick={reviewCurrent}
                  title="Mark this file reviewed ({reviewKey})">
            {#if isReviewed(activeFile.file)}<Icon name="check" size={14} /> Reviewed{:else}Mark reviewed{/if}
          </button>
        </div>
        <div class="sd-body" bind:this={bodyEl} onscroll={onBodyScroll}>
          {#if symMsg}<div class="sd-sym">{symMsg}</div>{/if}
          {#if activeFile.truncated}
            <div class="sd-trunc">
              <span><Icon name="warning" size={14} /> Large file — this diff is capped and may be missing lines.</span>
              <button class="sd-trunc-btn" disabled={loadingFull[activeFile.file]} onclick={() => loadFull(activeFile.file)}>
                {loadingFull[activeFile.file] ? 'Loading…' : 'Load the full diff'}
              </button>
            </div>
          {/if}
          {#if activeFile.binary}
            <div class="sd-empty">Binary file — no diff.</div>
          {:else}
            {#snippet defCard()}
              <DefPeek {id} target={def} onClose={() => (def = null)} />
            {/snippet}
            {#each fileDiffs(activeFile) as d, di (d.opIndex)}
              {#if d.label}<div class="sd-oplabel">{d.label}</div>{/if}
              <DiffView oldStr={d.oldStr} newStr={d.newStr} name={activeFile.name} mode={effMode} compact={ui.shipCompact}
                        blame={blameFor}
                        wholeFile={!!d.wholeFile}
                        onSymbol={(p) => gotoDefinition(activeFile.file, d.opIndex, p)}
                        markAt={def && def.opIndex === d.opIndex ? { side: def.atSide, line: def.atLine, start: def.atStart, end: def.atEnd } : null}
                        definitionAt={def && def.opIndex === d.opIndex ? { side: def.atSide, line: def.atLine } : null}
                        definition={defCard}
                        commentable={!!onReview}
                        comments={commentsForSection(di, d.opIndex)}
                        focus={jumpTarget}
                        onComment={(p) => addComment(activeFile.file, d.opIndex, activeFile.name, p)}
                        onDelete={delComment} onEdit={editComment} onReply={replyComment} onArchive={archiveComment} />
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <Grip value={ui.shipPanelWidth} set={(w) => (ui.shipPanelWidth = w)}
          min={PANEL_W.min} max={PANEL_W.max} def={PANEL_W.def} invert label="Resize the review panel" />

    <!-- ── side panel ── what this review covers, the batch to send, the comment list, the PR -->
    <aside class="ship-panel">
      <div class="sp-card">
        <h4>This review</h4>
        <div class="sp-check"><span class="sp-ico"><Icon name="diff" size={14} /></span> {totals.files} file{totals.files > 1 ? 's' : ''} · <span class="sf-add">+{totals.adds}</span> <span class="sf-del">−{totals.dels}</span></div>
        {#if scope === 'session'}
          <div class="sp-check"><span class="sp-ico"><Icon name="converse" size={14} /></span> {filtering ? `prompt${selected.size > 1 ? 's' : ''} ${promptLabels}` : 'whole conversation'}</div>
        {:else if scope === 'tree'}
          <div class="sp-check"><span class="sp-ico"><Icon name="git-branch" size={14} /></span> {#if s?.gitBranch}<span class="sp-mono">{s.gitBranch}</span> · {/if}uncommitted</div>
        {:else}
          <div class="sp-check"><span class="sp-ico"><Icon name="git-branch" size={14} /></span> <span class="sp-mono">{branch} → {base}</span></div>
          {#if commits.length}
            <div class="sp-check"><span class="sp-ico"><Icon name="git" size={14} /></span> {selSpan ? `${selSpan.hi - selSpan.lo + 1} of ${commits.length}` : `all ${commits.length}`} commit{commits.length > 1 ? 's' : ''}</div>
          {/if}
        {/if}
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

      <div class="sp-card">
        <h4>Pull request</h4>
        {#if (s?.prLinks || []).length}
          {#each s.prLinks as l}
            <a class="sp-pr" href={l} target="_blank" rel="noopener"><Icon name="pr" size={13} /> {l.replace(/^https?:\/\/[^/]+\//, '')}</a>
          {/each}
        {:else}
          <p class="sp-hint">No PR yet. Let the session push the branch and draft the description.</p>
        {/if}
        <button class="sp-pr-btn" onclick={askPR} disabled={prBusy || !canReview}
                title={canReview ? 'Ask the session to open a PR' : 'No live session to send to'}>
          {#if prBusy}Asking…{:else}<Icon name="pr" size={13} /> Ask Claude to open the PR{/if}
        </button>
      </div>

      {#if s?.cost != null}
        <div class="sp-meta">Session cost so far: <b>{fmtCost(s.cost)}</b></div>
      {/if}
    </aside>
  </div>
  {/if}
</div>

<style>
  .ship-empty { padding: 40px 24px; color: var(--muted); font-size: var(--t-ui); }
  /* container-type: the queries below measure the lens's REAL width (a split pane's too), not the viewport. */
  .review-wrap { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; container-type: inline-size; }
  .ship { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; }

  /* merged-branch banner */
  .br-merged {
    flex: 0 0 auto; display: flex; align-items: center; gap: 7px; padding: 6px 14px;
    border-bottom: 1px solid var(--border); background: color-mix(in srgb, var(--success) 8%, transparent);
    color: var(--muted); font-size: var(--t-meta);
  }
  .br-merged b { color: var(--text); }

  /* scope bar + its controls */
  .ship-turns { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg2); min-width: 0; }
  .st-toggle { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; flex: 0 0 auto; }
  .st-toggle button {
    display: inline-flex; align-items: center; gap: 5px; background: none; border: none; border-radius: 6px;
    color: var(--muted); font: inherit; font-size: var(--t-micro); font-weight: 700; padding: 3px 9px; cursor: pointer;
  }
  .st-toggle button:hover { color: var(--text); }
  .st-toggle button.on { background: var(--accent-soft); color: var(--accent-d); }
  .st-ask {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 5px; background: none;
    border: 1px solid var(--accent); border-radius: 999px; color: var(--accent-d); font: inherit;
    font-size: var(--t-micro); font-weight: 700; padding: 4px 10px; cursor: pointer;
  }
  .st-ask:hover:not(:disabled) { background: var(--accent-soft); }
  .st-ask:disabled { opacity: .5; cursor: default; }
  .st-label { font-family: var(--mono); font-size: var(--t-micro); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); flex: 0 0 auto; }
  .st-one { font-size: var(--t-meta); color: var(--muted); }
  .st-right { margin-left: auto; font-family: var(--mono); font-size: var(--t-micro); }
  .st-end { margin-left: auto; }
  .st-scope {
    flex: 0 1 auto; min-width: 0; display: inline-flex; align-items: center; gap: 6px;
    background: var(--chip); border: 1px solid var(--border); border-radius: 999px;
    color: var(--text); font: inherit; font-size: var(--t-meta); font-weight: 600; padding: 4px 11px; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .st-scope:hover { border-color: var(--accent); color: var(--accent-d); }
  .st-mono { font-family: var(--mono); font-size: var(--t-micro); }
  .st-refresh {
    flex: 0 0 auto; display: inline-flex; align-items: center; background: none; border: 1px solid var(--border);
    border-radius: 999px; color: var(--muted); padding: 4px 8px; cursor: pointer;
  }
  .st-refresh:hover { color: var(--text); border-color: var(--muted); }

  /* file rail */
  .ship-files { width: var(--ship-files-w, 232px); min-width: var(--ship-files-w, 232px); border-right: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; }
  .sf-head { display: flex; align-items: baseline; gap: 8px; padding: 10px 14px 7px; border-bottom: 1px solid var(--border); }
  .sf-title { font: 600 10px var(--mono); letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .sf-rev { margin-left: auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
  .sf-list { flex: 1 1 auto; overflow-y: auto; padding: 0; }
  .sf-item {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 12px; border: none; border-bottom: 1px solid var(--border);
    background: none; border-radius: 0; cursor: pointer; text-align: left; font: inherit; color: var(--text);
  }
  .sf-item:hover { background: var(--hover); }
  .sf-item.on { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  .sf-dot {
    flex: 0 0 auto; width: 15px; height: 15px; border-radius: 50%; border: 1.5px solid var(--border2);
    display: flex; align-items: center; justify-content: center; font-size: var(--t-micro); color: #fff;
  }
  .sf-dot.done { background: var(--success); border-color: var(--success); }
  .sf-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: var(--t-meta); }
  .sf-item.on .sf-name { font-weight: 700; color: var(--accent-d); }
  .sf-stat { flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); }
  .sf-add { color: var(--success); }
  .sf-del { color: var(--danger); }
  .sf-bin { color: var(--muted); }
  .sf-cmd { color: var(--muted); font-size: var(--t-micro); border: 1px solid var(--border, currentColor); border-radius: 3px; padding: 0 3px; line-height: 1.4; flex: none; }
  .sf-trunc { color: var(--waiting); font-size: var(--t-micro); }
  /* per-repo section header (working tree, several repos detected) */
  .sf-repo {
    display: flex; align-items: center; gap: 6px; padding: 9px 12px 4px;
    font-family: var(--mono); font-size: var(--t-micro); color: var(--muted);
    letter-spacing: .05em; text-transform: uppercase;
    position: sticky; top: 0; z-index: 1; background: var(--bg2);
  }
  .sf-repo-name { font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sf-truncnote { padding: 8px 12px; font-family: var(--mono); font-size: var(--t-micro); font-style: italic; color: var(--muted); }
  .sf-foot { border-top: 1px solid var(--border); padding: 10px 14px; }
  .sf-prog { height: 2px; border-radius: 0; background: var(--bg3); overflow: hidden; margin-bottom: 7px; }
  .sf-prog i { display: block; height: 100%; background: var(--success); transition: width .2s; }
  .sf-hint { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }

  /* diff */
  .ship-diff { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; background: var(--panel); }
  .sd-head { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .sd-name { font-family: var(--mono); font-size: var(--t-ui); font-weight: 700; }
  .sd-path { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .sd-editor { font-family: var(--mono); font-size: var(--t-micro); color: var(--accent-d); text-decoration: none; flex: 0 0 auto; }
  .sd-editor:hover { text-decoration: underline; }
  .sd-modes { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; flex: 0 0 auto; }
  .sd-modes button { background: none; border: none; border-radius: 6px; color: var(--muted); font-size: var(--t-ui); padding: 2px 9px; cursor: pointer; }
  .sd-modes button.on { background: var(--accent-soft); color: var(--accent); }
  .sd-compact { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; cursor: pointer; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
  .sd-compact input { accent-color: var(--accent); margin: 0; cursor: pointer; }
  .sd-review {
    flex: 0 0 auto; background: var(--bg3); border: 1px solid var(--border2); color: var(--text);
    border-radius: 8px; padding: 5px 11px; font: inherit; font-size: var(--t-meta); font-weight: 600; cursor: pointer;
  }
  .sd-review.done { background: color-mix(in srgb, var(--success) 16%, transparent); border-color: var(--success); color: var(--success); }
  .sd-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; }
  /* brief "go to definition" feedback: nothing to open, or opened elsewhere */
  .sd-sym {
    padding: 5px 12px; font-family: var(--mono); font-size: var(--t-micro); color: var(--accent-d);
    background: rgba(var(--accent-rgb), .08); border-bottom: 1px solid var(--border);
  }
  .sd-oplabel { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); padding: 8px 14px 2px; text-transform: uppercase; letter-spacing: .06em; }
  .sd-trunc {
    display: flex; align-items: center; gap: 12px; margin: 10px 14px; padding: 9px 12px;
    border: 1px solid rgba(var(--waiting-rgb), .4); background: rgba(var(--waiting-rgb), .1);
    border-radius: 10px; font-size: var(--t-ui); color: var(--text);
  }
  .sd-trunc-btn {
    margin-left: auto; flex: 0 0 auto; background: var(--accent); color: var(--accent-fg); border: none;
    border-radius: 8px; padding: 5px 12px; font: inherit; font-size: var(--t-meta); font-weight: 700; cursor: pointer;
  }
  .sd-trunc-btn:hover:not(:disabled) { background: var(--accent-d); }
  .sd-trunc-btn:disabled { opacity: .6; cursor: default; }
  .sd-empty { padding: 24px; color: var(--muted); font-size: var(--t-ui); }

  /* side panel */
  .ship-panel { width: var(--ship-panel-w, 288px); min-width: var(--ship-panel-w, 288px); border-left: 1px solid var(--border); background: var(--bg2); overflow-y: auto; padding: 0; display: flex; flex-direction: column; gap: 0; }
  .sp-card { border: none; border-radius: 0; background: transparent; border-bottom: 1px solid var(--border); padding: 12px 14px; }
  .sp-card h4 { margin: 0 0 9px; font-family: var(--mono); font-size: var(--t-micro); font-weight: 700; letter-spacing: .09em; text-transform: uppercase; color: var(--muted); }
  .sp-check { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: var(--t-ui); min-width: 0; }
  .sp-ico { flex: 0 0 auto; }
  .sp-mono { font-family: var(--mono); font-size: var(--t-micro); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sp-send {
    background: var(--accent); color: var(--accent-fg); border: none; border-radius: 10px; padding: 9px 12px;
    font: inherit; font-size: var(--t-ui); font-weight: 700; cursor: pointer;
  }
  .sp-send:hover:not(:disabled) { background: var(--accent-d); }
  .sp-send:disabled, .sp-pr-btn:disabled { opacity: .5; cursor: default; }
  .sp-hint { margin: 0 0 9px; font-size: var(--t-meta); color: var(--muted); line-height: 1.5; }
  .sp-pr { display: block; font-size: var(--t-meta); color: var(--success); text-decoration: none; margin-bottom: 8px; word-break: break-all; }
  .sp-pr:hover { text-decoration: underline; }
  .sp-pr-btn { display: block; width: 100%; background: var(--bg3); border: 1px solid var(--border2); color: var(--text); border-radius: 9px; padding: 7px 10px; font: inherit; font-size: var(--t-meta); font-weight: 700; cursor: pointer; }
  .sp-pr-btn:hover:not(:disabled) { background: var(--hover); }
  .sp-meta { font-size: var(--t-micro); color: var(--muted); padding: 8px 14px; }
  .sp-meta b { color: var(--text); }

  /* the rail handles are <Grip> — styled globally in app.css (`.ship-grip`, out of this scope) */
  @media (max-width: 1100px) { .ship-panel { display: none; } }
  @media (max-width: 900px) { .ship-files { display: none; } }

  /* Narrow mode (split pane / small window): the side columns give way to the diff — first the
     panel, then the file list (J/K still navigate). */
  @container (max-width: 760px) {
    .ship-panel { display: none; }
    .ship-files { width: min(var(--ship-files-w, 232px), 180px); min-width: min(var(--ship-files-w, 232px), 180px); }
  }
  @container (max-width: 560px) {
    .ship-files { display: none; }
  }
</style>
