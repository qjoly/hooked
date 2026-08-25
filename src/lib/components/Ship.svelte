<script>
  // Ship lens (redesign): a focused code-review + shipping surface for Claude's changes.
  //   • left rail  — the changed files with per-file +N/−M and a review checkmark (J/K/V);
  //   • center     — ONE file's net diff at a time (original → final, so add-then-delete
  //                  cancels out), rendered by DiffView, with inline comments;
  //   • right panel — a "ready to ship?" checklist, PR links, and one-click actions that send
  //                  a prompt to the live session (batch review, or "open the PR").
  import { untrack } from 'svelte';
  import DiffView from './DiffView.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { toSegments, countStats, applyOp } from '$lib/difflines.js';
  import { fmtCost } from '$lib/format.js';
  import { getFileChangeFull, getVcsDiff, getVcsLog, getVcsCommit } from '$lib/api.js';
  import { settings } from '$lib/state.svelte.js';

  let { s, id, onReview = null, canReview = true, active = false } = $props();

  // Files whose content the server capped are flagged `truncated`; we load the FULL (uncapped)
  // entry on demand and override it here so the diff shows everything.
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

  // ── diff source: Claude (transcript) vs VCS (git/jj) ───────────────────────────────────────
  // The lens opens on the user's preference (settings.shipDefaultView); the toggle at the head
  // of the "Changes for" bar switches on the spot. In VCS mode the prompt chips become COMMIT
  // chips: "Uncommitted" (working tree, default) or one commit's diff (vs its parent).
  let view = $state(settings.shipDefaultView === 'vcs' ? 'vcs' : 'claude');
  // Track the preference until the user touches the toggle (settings may resolve after mount).
  let viewTouched = false;
  $effect(() => {
    const pref = settings.shipDefaultView === 'vcs' ? 'vcs' : 'claude';
    if (!viewTouched) untrack(() => { view = pref; });
  });
  function setView(v) { viewTouched = true; view = v; activeIdx = 0; }

  let vcs = $state({ loaded: false, loading: false, error: null, kind: null, workChanges: [], commits: [] });
  let selectedRev = $state(null);   // null = working tree ("Uncommitted")
  let commitCache = $state({});     // rev -> changes[]
  let commitLoading = $state(false);
  const VCS_META = { git: { icon: 'git', label: 'Git' }, jj: { icon: 'jujutsu', label: 'Jujutsu' } };
  const vcsMeta = $derived(VCS_META[vcs.kind] || { icon: 'git', label: 'VCS' });

  async function loadVcs(force = false) {
    if (!id || vcs.loading || (vcs.loaded && !force)) return;
    vcs = { ...vcs, loading: true, error: null };
    try {
      const [diff, log] = await Promise.all([getVcsDiff(id), getVcsLog(id)]);
      // Ship's rail is a flat file list → flatten every detected repo's changes together.
      const workChanges = (diff.repos || []).flatMap((r) => r.changes || []);
      vcs = { loaded: true, loading: false, error: null, kind: diff.vcs || log.vcs, workChanges, commits: log.commits || [] };
      if (force) commitCache = {};
    } catch (_) {
      vcs = { ...vcs, loading: false, loaded: true, error: 'Failed to load the VCS diff.' };
    }
  }
  $effect(() => { if (view === 'vcs') loadVcs(false); });

  async function selectCommit(rev) {
    selectedRev = rev;
    activeIdx = 0;
    if (!rev || commitCache[rev]) return;
    commitLoading = true;
    try {
      const r = await getVcsCommit(id, rev);
      commitCache = { ...commitCache, [rev]: r.changes || [] };
    } catch (_) {
      commitCache = { ...commitCache, [rev]: [] };
    } finally {
      commitLoading = false;
    }
  }
  const vcsChanges = $derived(selectedRev ? (commitCache[selectedRev] || []) : vcs.workChanges);

  // ── per-prompt filter ───────────────────────────────────────────────────────────────────────
  // Default = the whole conversation (net original→final). The user can restrict to one or more
  // turns (prompts); op→turn is resolved by timestamp against the session's prompt list.
  const turns = $derived([...(s?.changeTurns || [])].sort((a, b) => String(a.ts).localeCompare(String(b.ts))));
  let selected = $state(new Set()); // empty = all prompts
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

  // Diff sections for a file, honouring the current prompt filter.
  //   • no filter → the server's NET diff (c.ops), add-then-delete already cancelled;
  //   • filter + reconstructed original → replay rawOps and diff the span of the selected turns;
  //   • filter without an original → fall back to the selected raw ops, each its own section.
  function fileDiffs(c) {
    if (view === 'vcs') {
      // VCS entries are single old→new edits; key the sections per commit so inline comments
      // never collide with the Claude view (or another commit) on the same file.
      const key = 'vcs:' + (selectedRev || 'wt');
      return (c.ops || []).map((o, j) => ({ oldStr: o.old || '', newStr: o.new || '', opIndex: key + ':' + j, label: null }));
    }
    if (!filtering) {
      const ops = c.ops || [];
      return ops.map((o, j) => {
        if (o.kind === 'write') return { oldStr: '', newStr: o.content || '', opIndex: 'full:' + j, label: 'new file' };
        if (o.kind === 'notebook') return { oldStr: '', newStr: o.new || '', opIndex: 'full:' + j, label: 'notebook cell' };
        return { oldStr: o.old || '', newStr: o.new || '', opIndex: 'full:' + j, label: ops.length > 1 ? 'edit ' + (j + 1) : null };
      });
    }
    const raw = c.rawOps || [];
    const selIdx = raw.map((o, j) => (opSelected(o) ? j : -1)).filter((j) => j >= 0);
    if (!selIdx.length) return [];
    const key = 'sel:' + [...selected].sort().join(',');
    if (c.original != null) {
      // states[j] = content AFTER rawOps[0..j]; before[j] = content before op j.
      let text = c.original;
      const before = [], after = [];
      for (let j = 0; j < raw.length; j++) { before[j] = text; text = applyOp(text, raw[j]); after[j] = text; }
      const first = selIdx[0], lastS = selIdx[selIdx.length - 1];
      return [{ oldStr: before[first], newStr: after[lastS], opIndex: key, label: null }];
    }
    // no original → best-effort: each selected op as a section
    return selIdx.map((j) => {
      const o = raw[j];
      if (o.kind === 'write') return { oldStr: '', newStr: o.content || '', opIndex: key + ':' + j, label: 'new file' };
      return { oldStr: o.old || '', newStr: o.new || '', opIndex: key + ':' + j, label: 'edit ' + (j + 1) };
    });
  }

  // files shown: the VCS list (working tree or selected commit), or the Claude changes under
  // the current per-prompt filter (touched by at least one selected turn).
  const changes = $derived(
    view === 'vcs' ? vcsChanges
    : !filtering ? allChanges
    : allChanges.filter((c) => [...fileTurns(c)].some((t) => selected.has(t)))
  );

  // +N/−M per file (summed across its displayed sections).
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

  // active file (clamped to the visible list, which shrinks/grows with the filter)
  let activeIdx = $state(0);
  $effect(() => { changes.length; untrack(() => { if (activeIdx >= changes.length) activeIdx = Math.max(0, changes.length - 1); }); });
  const activeFile = $derived(changes[activeIdx] || null);

  // review tracking (per browser session, in-memory keyed by file path)
  let reviewed = $state(new Set());
  const isReviewed = (f) => reviewed.has(f);
  function toggleReviewed(f) {
    const next = new Set(reviewed);
    next.has(f) ? next.delete(f) : next.add(f);
    reviewed = next;
  }
  // "Mark reviewed" on the active file: marking it (not un-marking) auto-advances to the next
  // file — so you can review a diff, hit V / the button, and land on the next one.
  function reviewCurrent() {
    if (!activeFile) return;
    const wasReviewed = reviewed.has(activeFile.file);
    toggleReviewed(activeFile.file);
    if (!wasReviewed && activeIdx < changes.length - 1) activeIdx += 1;
  }
  const reviewedCount = $derived(changes.filter((c) => reviewed.has(c.file)).length);

  // diff style (persisted)
  let mode = $state((typeof localStorage !== 'undefined' && localStorage.getItem('hooked.shipDiff')) || 'split');
  $effect(() => { try { localStorage.setItem('hooked.shipDiff', mode); } catch {} });

  // Narrow mode (split pane / small window): Ship's 3 columns don't fit — the side columns
  // collapse (CSS container queries on .ship-wrap) and the diff is FORCED unified (a side-by-side
  // diff in a half-pane wraps every token onto its own line — unusable).
  let shipEl = $state(null);
  let narrow = $state(false);
  $effect(() => {
    if (!shipEl) return;
    const ro = new ResizeObserver(() => { narrow = shipEl.clientWidth < 760; });
    ro.observe(shipEl);
    return () => ro.disconnect();
  });
  const effMode = $derived(narrow ? 'unified' : mode);

  // ── inline comments (batched, sent to Claude) ──────────────────────────────────────────────
  let comments = $state([]); // { id, file, opIndex, name, side, start, end, text, snippet }
  const pending = $derived(comments.length);
  function addComment(file, opIndex, name, payload) {
    comments = [...comments, { id: crypto.randomUUID(), file, opIndex, name, ...payload }];
  }
  function delComment(cid) { comments = comments.filter((c) => c.id !== cid); }
  const commentsFor = (file, opIndex) =>
    comments.filter((c) => c.file === file && c.opIndex === opIndex).map((c) => ({ id: c.id, side: c.side, start: c.start, end: c.end, text: c.text }));

  const anchorLabel = (c) => {
    const p = c.side === 'old' ? '−L' : '+L';
    return c.start === c.end ? p + c.end : p + c.start + '–' + c.end;
  };
  function buildReviewPrompt() {
    const items = [];
    for (const c of changes) {
      const forFile = comments.filter((lc) => lc.file === c.file).sort((a, b) => a.opIndex - b.opIndex || a.start - b.start);
      for (const lc of forFile) {
        const snip = (lc.snippet || '').split('\n').map((l) => '   | ' + l).join('\n');
        const body = (lc.text || '').replace(/\n/g, '\n   > ');
        items.push(`${items.length + 1}) ${c.file} (${anchorLabel(lc)})\n   > ${body}\n   Relevant code:\n${snip}`);
      }
    }
    if (!items.length) return '';
    return 'I reviewed your changes and left the following inline comments. Please address each one:\n\n' + items.join('\n\n');
  }

  let sending = $state(false);
  async function sendReview() {
    if (!onReview || !pending || sending) return;
    const prompt = buildReviewPrompt();
    if (!prompt) return;
    sending = true;
    try { await onReview(prompt); comments = []; } finally { sending = false; }
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

  // keyboard: J/K next/prev file, V mark reviewed + advance — only while Ship is the active lens
  // and the user isn't typing in a field.
  function onKey(e) {
    if (!active || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'j' || e.key === 'J') { e.preventDefault(); activeIdx = Math.min(changes.length - 1, activeIdx + 1); }
    else if (e.key === 'k' || e.key === 'K') { e.preventDefault(); activeIdx = Math.max(0, activeIdx - 1); }
    else if (e.key === 'v' || e.key === 'V') {
      if (!activeFile) return;
      e.preventDefault();
      reviewCurrent();
    }
  }

  const tasksDone = $derived((s?.todos || []).filter((t) => t.status === 'completed').length);
  const tasksTotal = $derived((s?.todos || []).length);
</script>

<svelte:window onkeydown={onKey} />

<div class="ship-wrap" bind:this={shipEl}>
  <!-- ── source toggle + scope chips ── Claude: per-prompt filter (default: whole conversation);
       VCS: commit picker (default: the uncommitted working tree). -->
  <div class="ship-turns">
    <div class="st-toggle">
      <button class:on={view === 'claude'} onclick={() => setView('claude')} title="Changes reconstructed from Claude's edits">
        <Icon name="diff" size={12} /> Claude
      </button>
      <button class:on={view === 'vcs'} onclick={() => setView('vcs')} title="Changes as seen by the version control system (git / jj)">
        <Icon name={vcsMeta.icon} size={12} /> {vcsMeta.label}
      </button>
    </div>
    <span class="st-label">Changes for</span>
    {#if view === 'claude'}
      {#if turns.length > 1}
        <button class="st-chip" class:on={!filtering} onclick={clearTurns}>Whole conversation</button>
        <div class="st-scroll">
          {#each turns as t (t.turn)}
            <button class="st-chip st-prompt" class:on={selected.has(t.turn)} title={t.prompt}
                    onclick={() => toggleTurn(t.turn)}>
              <span class="st-n">P{t.turn + 1}</span>{t.prompt || '(prompt)'}
            </button>
          {/each}
        </div>
      {:else}
        <span class="st-one">Whole conversation</span>
      {/if}
    {:else}
      <button class="st-chip" class:on={!selectedRev} onclick={() => selectCommit(null)}>Uncommitted</button>
      <div class="st-scroll">
        {#each vcs.commits as c (c.rev)}
          <button class="st-chip st-prompt" class:on={selectedRev === c.rev}
                  title={(c.subject || '(no message)') + (c.author ? ' — ' + c.author : '') + (c.ts ? ' · ' + c.ts : '')}
                  onclick={() => selectCommit(c.rev)}>
            <span class="st-n">{c.rev.slice(0, 8)}</span>{c.subject || '(no message)'}
          </button>
        {/each}
      </div>
      <button class="st-refresh" title="Reload commits and the working-tree diff" onclick={() => loadVcs(true)}>
        <Icon name="rotate-cw" size={12} />
      </button>
    {/if}
  </div>
  {#if view === 'claude' && !allChanges.length}
    <div class="ship-empty">No file changes in this session yet.</div>
  {:else if view === 'vcs' && (vcs.loading || !vcs.loaded)}
    <div class="ship-empty">Loading the VCS diff…</div>
  {:else if view === 'vcs' && vcs.error}
    <div class="ship-empty">{vcs.error}</div>
  {:else if view === 'vcs' && !vcs.kind}
    <div class="ship-empty">This project is not in a git or jj repository.</div>
  {:else if view === 'vcs' && commitLoading}
    <div class="ship-empty">Loading the commit diff…</div>
  {:else if view === 'vcs' && !changes.length}
    <div class="ship-empty">{selectedRev ? 'This commit changes no files.' : 'No uncommitted changes in the working tree.'}</div>
  {:else}
  <div class="ship">
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
            <span class="sf-dot" class:done={isReviewed(c.file)}>{#if isReviewed(c.file)}<Icon name="check" size={11} />{/if}</span>
            <span class="sf-name">{c.name}</span>
            {#if c.tool === 'Bash'}<span class="sf-cmd" title="Changed by a bash command, not an edit tool">cmd</span>
            {:else if (c.rawOps || []).length && c.rawOps.every((o) => o.agent)}<span class="sf-cmd" title="Changed by a subagent">agent</span>{/if}
            <span class="sf-stat">
              {#if c.truncated}<span class="sf-trunc" title="Large file — capped, load full to see everything"><Icon name="warning" size={12} /></span>{/if}
              {#if c.binary}<span class="sf-bin">bin</span>{:else}<span class="sf-add">+{st.adds}</span> <span class="sf-del">−{st.dels}</span>{/if}
            </span>
          </button>
        {/each}
      </div>
      <div class="sf-foot">
        <div class="sf-prog"><i style="width:{changes.length ? Math.round((reviewedCount / changes.length) * 100) : 0}%"></i></div>
        <div class="sf-hint">J/K next file · V mark reviewed</div>
      </div>
    </aside>

    <!-- ── diff ── -->
    <div class="ship-diff">
      {#if activeFile}
        <div class="sd-head">
          <span class="sd-name">{activeFile.name}</span>
          <span class="sd-path" title={activeFile.file}>{activeFile.file}</span>
          <a class="sd-editor" href={'vscode://file' + activeFile.file} title="Open in VS Code"><Icon name="external" size={12} /> editor</a>
          <div class="sd-modes">
            <button class:on={mode === 'unified'} onclick={() => (mode = 'unified')} title="Unified"><Icon name="menu" size={14} /></button>
            <button class:on={mode === 'split'} onclick={() => (mode = 'split')} title="Side-by-side"><Icon name="pane" size={14} /></button>
          </div>
          <button class="sd-review" class:done={isReviewed(activeFile.file)} onclick={reviewCurrent}>
            {#if isReviewed(activeFile.file)}<Icon name="check" size={14} /> Reviewed{:else}Mark reviewed{/if}
          </button>
        </div>
        <div class="sd-body">
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
            {#each fileDiffs(activeFile) as d (d.opIndex)}
              {#if d.label}<div class="sd-oplabel">{d.label}</div>{/if}
              <DiffView oldStr={d.oldStr} newStr={d.newStr} name={activeFile.name} mode={effMode}
                        commentable={!!onReview}
                        comments={commentsFor(activeFile.file, d.opIndex)}
                        onComment={(p) => addComment(activeFile.file, d.opIndex, activeFile.name, p)}
                        onDelete={delComment} />
            {/each}
          {/if}
        </div>
      {/if}
    </div>

    <!-- ── ship panel ── -->
    <aside class="ship-panel">
      <div class="sp-card">
        <h4>Ready to ship?</h4>
        <div class="sp-check"><span class="sp-ico"><Icon name="diff" size={14} /></span> {totals.files} file{totals.files > 1 ? 's' : ''} · <span class="sf-add">+{totals.adds}</span> <span class="sf-del">−{totals.dels}</span></div>
        {#if s?.gitBranch}<div class="sp-check"><span class="sp-ico"><Icon name="git-branch" size={14} /></span> <span class="sp-mono">{s.gitBranch}</span></div>{/if}
        {#if tasksTotal}<div class="sp-check"><span class="sp-ico" class:ok={tasksDone === tasksTotal}><Icon name={tasksDone === tasksTotal ? 'checkbox-done' : 'checkbox'} size={14} /></span> {tasksDone}/{tasksTotal} tasks done</div>{/if}
        <div class="sp-check"><span class="sp-ico" class:ok={reviewedCount === changes.length}><Icon name={reviewedCount === changes.length ? 'checkbox-done' : 'circle'} size={14} /></span> reviewed {reviewedCount}/{changes.length} files</div>
        {#if pending}<div class="sp-check"><span class="sp-ico"><Icon name="pencil" size={14} /></span> {pending} comment{pending > 1 ? 's' : ''} pending</div>{/if}
      </div>

      {#if pending}
        <button class="sp-send" onclick={sendReview} disabled={sending || !canReview}
                title={canReview ? 'Send your inline comments to the session' : 'No live tmux session to send to'}>
          {#if sending}Sending…{:else}<Icon name="send" size={14} /> Send {pending} comment{pending > 1 ? 's' : ''} to Claude{/if}
        </button>
      {/if}

      <div class="sp-card">
        <h4>Pull request</h4>
        {#if (s?.prLinks || []).length}
          {#each s.prLinks as l}
            <a class="sp-pr" href={l} target="_blank" rel="noopener"><Icon name="pr" size={13} /> {l.replace(/^https?:\/\/github\.com\//, '')}</a>
          {/each}
        {:else}
          <p class="sp-hint">No PR yet. Let the session push the branch and draft the description.</p>
        {/if}
        <button class="sp-pr-btn" onclick={askPR} disabled={prBusy || !canReview}
                title={canReview ? 'Ask the session to open a PR' : 'No live tmux session to send to'}>
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
  .ship-empty { padding: 40px 24px; color: var(--muted); font-size: 13px; }
  /* container-type : les media queries ci-dessous mesurent la largeur RÉELLE de Ship
     (donc aussi celle d'un pane de split), pas le viewport. */
  .ship-wrap { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; container-type: inline-size; }
  .ship { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; }


  /* source toggle + scope chips bar */
  .ship-turns { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--border); background: var(--bg2); min-width: 0; }
  .st-toggle { display: flex; gap: 2px; background: var(--input); border-radius: 8px; padding: 2px; flex: 0 0 auto; }
  .st-toggle button {
    display: inline-flex; align-items: center; gap: 5px; background: none; border: none; border-radius: 6px;
    color: var(--muted); font: inherit; font-size: 11px; font-weight: 700; padding: 3px 9px; cursor: pointer;
  }
  .st-toggle button:hover { color: var(--text); }
  .st-toggle button.on { background: var(--accent-soft); color: var(--accent-d); }
  .st-one { font-size: 11.5px; color: var(--muted); }
  .st-refresh {
    flex: 0 0 auto; display: inline-flex; align-items: center; background: none; border: 1px solid var(--border);
    border-radius: 999px; color: var(--muted); padding: 4px 8px; cursor: pointer;
  }
  .st-refresh:hover { color: var(--text); border-color: var(--muted); }
  .st-label { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); flex: 0 0 auto; }
  .st-scroll { display: flex; gap: 6px; overflow-x: auto; min-width: 0; padding-bottom: 2px; }
  .st-chip {
    flex: 0 0 auto; max-width: 240px; display: inline-flex; align-items: center; gap: 6px;
    background: var(--chip); border: 1px solid var(--border); border-radius: 999px;
    color: var(--muted); font: inherit; font-size: 11.5px; font-weight: 600; padding: 4px 11px; cursor: pointer;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .st-chip:hover { color: var(--text); }
  .st-chip.on { background: var(--accent-soft); border-color: rgba(var(--accent-rgb), .4); color: var(--accent-d); }
  .st-prompt { max-width: 220px; }
  .st-n { font-family: var(--mono); font-size: 9.5px; font-weight: 800; opacity: .8; flex: 0 0 auto; }

  /* file rail */
  .ship-files { width: 232px; min-width: 232px; border-right: 1px solid var(--border); background: var(--bg2); display: flex; flex-direction: column; }
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
  .sf-cmd { color: var(--muted); font-size: 9px; border: 1px solid var(--border, currentColor); border-radius: 3px; padding: 0 3px; line-height: 1.4; flex: none; }
  .sf-trunc { color: var(--waiting); font-size: 10px; }
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
  .sd-review {
    flex: 0 0 auto; background: var(--bg3); border: 1px solid var(--border2); color: var(--text);
    border-radius: 8px; padding: 5px 11px; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
  }
  .sd-review.done { background: color-mix(in srgb, var(--success) 16%, transparent); border-color: var(--success); color: var(--success); }
  .sd-body { flex: 1 1 auto; min-height: 0; min-width: 0; overflow-y: auto; overflow-x: hidden; }
  .sd-oplabel { font-family: var(--mono); font-size: 10px; color: var(--muted); padding: 8px 14px 2px; text-transform: uppercase; letter-spacing: .06em; }
  .sd-trunc {
    display: flex; align-items: center; gap: 12px; margin: 10px 14px; padding: 9px 12px;
    border: 1px solid rgba(var(--waiting-rgb), .4); background: rgba(var(--waiting-rgb), .1);
    border-radius: 10px; font-size: 12.5px; color: var(--text);
  }
  .sd-trunc-btn {
    margin-left: auto; flex: 0 0 auto; background: var(--accent); color: var(--accent-fg); border: none;
    border-radius: 8px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer;
  }
  .sd-trunc-btn:hover:not(:disabled) { background: var(--accent-d); }
  .sd-trunc-btn:disabled { opacity: .6; cursor: default; }
  .sd-empty { padding: 24px; color: var(--muted); font-size: 12.5px; }

  /* ship panel */
  .ship-panel { width: 288px; min-width: 288px; border-left: 1px solid var(--border); background: var(--bg2); overflow-y: auto; padding: 0; display: flex; flex-direction: column; gap: 0; }
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
  .sp-send:disabled, .sp-pr-btn:disabled { opacity: .5; cursor: default; }
  .sp-hint { margin: 0 0 9px; font-size: 11.5px; color: var(--muted); line-height: 1.5; }
  .sp-pr { display: block; font-size: 11.5px; color: var(--success); text-decoration: none; margin-bottom: 8px; word-break: break-all; }
  .sp-pr:hover { text-decoration: underline; }
  .sp-pr-btn { display: block; width: 100%; background: var(--bg3); border: 1px solid var(--border2); color: var(--text); border-radius: 9px; padding: 7px 10px; font: inherit; font-size: 12px; font-weight: 700; cursor: pointer; }
  .sp-pr-btn:hover:not(:disabled) { background: var(--hover); }
  .sp-meta { font-size: 11px; color: var(--muted); padding: 2px 4px; }
  .sp-meta b { color: var(--text); }

  @media (max-width: 1100px) { .ship-panel { display: none; } }
  @media (max-width: 900px) { .ship-files { display: none; } }

  /* Mode étroit (pane de split / petite fenêtre) : les colonnes latérales cèdent la place au
     diff — d'abord le panneau « ready to ship », puis la liste de fichiers (J/K naviguent). */
  @container (max-width: 760px) {
    .ship-panel { display: none; }
    .ship-files { width: 180px; min-width: 180px; }
  }
  @container (max-width: 560px) {
    .ship-files { display: none; }
  }
</style>
