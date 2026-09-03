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
  import Icon from '$lib/components/Icon.svelte';
  import { toSegments, countStats } from '$lib/difflines.js';
  import { getVcsBranches, getVcsBranchDiff, getVcsBlame,
           getReviewThreads, postReviewComment, deleteReviewThread, replyReviewThread,
           resolveReviewThread, markReviewSent, reply as sendToSession } from '$lib/api.js';
  import { settings, ui } from '$lib/state.svelte.js';
  import { editorFor } from '$lib/editors.js';
  import { fingerprint, isReviewed as hasReview, toggleReviewed as tickReview,
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

  async function loadBranches(root = null, force = false) {
    if (meta.loading || (meta.loaded && !force && root === selectedRepo)) return;
    meta = { ...meta, loading: true, error: null };
    try {
      const r = await getVcsBranches(id, root);
      meta = { loaded: true, loading: false, error: null, vcs: r.vcs, branches: r.branches || [], def: r.default, repos: r.repos || [] };
      selectedRepo = root || r.root || null;
      const names = (r.branches || []).map((b) => b.name);
      if (!branch || !names.includes(branch)) branch = (r.branches || []).find((b) => b.current)?.name || r.default || names[0] || null;
      if (!base || !names.includes(base)) base = r.default || null;
      if (force) diffCache = {};
    } catch (_) {
      meta = { ...meta, loading: false, loaded: true, error: 'Failed to list the branches.' };
    }
  }
  $effect(() => { if (active) loadBranches(untrack(() => selectedRepo)); });

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

  async function loadDiff(key) {
    try {
      const r = await getVcsBranchDiff(id, branch, base, selectedRepo);
      diffCache = { ...diffCache, [key]: { changes: r.changes || [], mergeBase: r.mergeBase, merged: !!r.merged } };
    } catch (_) {
      diffCache = { ...diffCache, [key]: { changes: [], mergeBase: null, merged: false } };
    } finally {
      diffLoading = false;
    }
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

  // VCS entries are single old→new edits; key sections per branch pair so inline comments
  // never collide across branches (or with the Ship lens) on the same file.
  const fileDiffs = (c) => (c.ops || []).map((o, j) => ({ oldStr: o.old || '', newStr: o.new || '', opIndex: 'br:' + diffKey + ':' + j }));

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
  function reviewCurrent() {
    if (!activeFile) return;
    const wasReviewed = isReviewed(activeFile.file);
    toggleReviewed(activeFile.file);
    if (!wasReviewed && activeIdx < changes.length - 1) activeIdx += 1;
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

  const pendingThreads = $derived(threads.filter((t) => !t.sent));
  const pending = $derived(pendingThreads.length);
  async function addComment(file, opIndex, name, payload) {
    const r = await postReviewComment(id, { file, opIndex, name, ...payload });
    if (r && r.thread) threads = [...threads, r.thread];
  }
  async function delComment(tid) {
    threads = threads.filter((t) => t.id !== tid);
    try { await deleteReviewThread(id, tid); } catch (_) {}
  }
  async function resolveComment(tid, resolved) {
    threads = threads.map((t) => (t.id === tid ? { ...t, status: resolved ? 'resolved' : 'open' } : t));
    try { await resolveReviewThread(id, tid, resolved); } catch (_) {}
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
    threads.filter((c) => c.file === file && c.opIndex === opIndex)
      .map((c) => ({ id: c.id, side: c.side, start: c.start, end: c.end, snippet: c.snippet, status: c.status, sent: c.sent, messages: c.messages }));

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
          {#if activeFile.binary}
            <div class="sd-empty">Binary file — no diff.</div>
          {:else}
            {#each fileDiffs(activeFile) as d (d.opIndex)}
              <DiffView oldStr={d.oldStr} newStr={d.newStr} name={activeFile.name} mode={effMode} {compact}
                        blame={blameFor}
                        commentable={!!onReview}
                        comments={commentsFor(activeFile.file, d.opIndex)}
                        onComment={(p) => addComment(activeFile.file, d.opIndex, activeFile.name, p)}
                        onDelete={delComment} onReply={replyComment} onResolve={resolveComment} />
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
                title={canReview ? 'Send your inline comments to the session' : 'No live tmux session to send to'}>
          {#if sending}Sending…{:else}<Icon name="send" size={14} /> Send {pending} comment{pending > 1 ? 's' : ''} to Claude{/if}
        </button>
      {/if}

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
