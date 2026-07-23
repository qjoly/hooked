<script>
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ui, data, loadSessions, togglePin, sessionTitle, openModal, sessionTags, allTags } from '$lib/state.svelte.js';
  import { reply, deleteSession } from '$lib/api.js';
  import { ago, tagColor } from '$lib/format.js';

  // Réponse en 1 clic : options inline seulement pour une question unique à choix simple
  // (cas « permissions »). Multi-select / questions multiples → on ouvre la session.
  function quickOpts(q) {
    const qs = q && q.questions;
    if (!qs || qs.length !== 1 || qs[0].multiSelect) return null;
    return qs[0].options || [];
  }
  let sendingId = $state(null);
  let sentId = $state(null);
  async function quickReply(s, label) {
    if (sendingId) return;
    sendingId = s.id;
    const res = await reply(s.id, label).catch(() => ({ ok: false }));
    sendingId = null;
    if (res.ok) {
      sentId = s.id;
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
      setTimeout(() => { if (sentId === s.id) sentId = null; }, 2500);
    }
  }

  let deletingId = $state(null);
  function delSession(s) {
    if (deletingId) return;
    openModal('confirm', {
      title: 'Move to trash?',
      message: `"${sessionTitle(s)}"\n\nThe transcript is kept in bin/ (recoverable); the session leaves the dashboard.`,
      confirmLabel: '🗑 Move to trash', danger: true, onConfirm: () => doDelSession(s),
    });
  }
  async function doDelSession(s) {
    deletingId = s.id;
    const res = await deleteSession(s.id).catch(() => ({ ok: false }));
    deletingId = null;
    if (res.ok) { loadSessions(); ui.tick++; }
    else alert('✗ delete failed');
  }

  // Scope segmenté (Active / Needs you / Working / All). Défaut « Active » : tout ce qui est
  // vivant (attend une réponse OU travaille), sans le bruit des sessions terminées.
  const SCOPES = [
    { key: 'active', label: 'Active' },
    { key: 'needs', label: 'Needs you' },
    { key: 'working', label: 'Working' },
    { key: 'all', label: 'All' },
  ];
  let scope = $state('active');

  const needsReply = (s) => s.hasQuestion || s.hasPlan || s.state === 'waiting' || s.state === 'attention';
  const isWorking = (s) => s.state === 'working' || s.state === 'background';

  const pinnedSet = $derived(new Set(ui.pinned));

  // recherche + filtres de tags (ET logique) — appliqués avant le regroupement par statut.
  const matched = $derived.by(() => {
    const q = ui.search.toLowerCase().trim();
    return data.sessions.filter((s) => {
      const tags = sessionTags(s.id);
      if (ui.tagFilters.length && !ui.tagFilters.every((t) => tags.includes(t))) return false;
      if (q) {
        const hay = `${s.repo} ${s.projectName} ${s.title} ${s.lastPrompt} ${s.gitBranch} ${tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const cNeeds = $derived(matched.filter(needsReply).length);
  const cWorking = $derived(matched.filter((s) => isWorking(s) && !needsReply(s)).length);
  const cActive = $derived(cNeeds + cWorking);
  const cAll = $derived(matched.length);
  const scopeCount = (k) => (k === 'active' ? cActive : k === 'needs' ? cNeeds : k === 'working' ? cWorking : cAll);

  const byActivity = (a, b) => {
    const pa = pinnedSet.has(a.id), pb = pinnedSet.has(b.id);
    if (pa !== pb) return pa ? -1 : 1; // épinglées en tête
    return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  };

  // sections affichées selon le scope. « all » montre les trois ; « active » les deux vivantes ;
  // « needs »/« working » une seule.
  const sections = $derived.by(() => {
    const needs = matched.filter(needsReply).sort(byActivity);
    const working = matched.filter((s) => isWorking(s) && !needsReply(s)).sort(byActivity);
    const others = matched.filter((s) => !needsReply(s) && !isWorking(s)).sort(byActivity);
    const out = [];
    if (scope === 'needs') {
      out.push({ key: 'needs', label: 'Needs your reply', tone: 'warn', items: needs });
    } else if (scope === 'working') {
      out.push({ key: 'working', label: 'Working', tone: 'info', items: working });
    } else if (scope === 'active') {
      if (needs.length) out.push({ key: 'needs', label: 'Needs your reply', tone: 'warn', items: needs });
      if (working.length) out.push({ key: 'working', label: 'Working', tone: 'info', items: working });
    } else {
      if (needs.length) out.push({ key: 'needs', label: 'Needs your reply', tone: 'warn', items: needs });
      if (working.length) out.push({ key: 'working', label: 'Working', tone: 'info', items: working });
      if (others.length) out.push({ key: 'others', label: 'Idle & ended', tone: 'muted', items: others });
    }
    return out.filter((sec) => sec.items.length);
  });

  // Fenêtrage de la liste : sous « All » la section « Idle & ended » peut compter ~160 lignes.
  // On ne monte qu'une fenêtre de lignes (WINDOW), « Show more » en révèle STEP de plus — même
  // principe que le transcript du cockpit (MSG_WINDOW). Borne le DOM sans virtualisation fragile.
  const WINDOW = 60, STEP = 120;
  let shown = $state(WINDOW);
  // repart de la fenêtre initiale quand le filtrage change (scope / recherche / tags).
  $effect(() => { scope; ui.search; ui.tagFilters; untrack(() => { shown = WINDOW; }); });

  const totalRows = $derived(sections.reduce((n, sec) => n + sec.items.length, 0));
  // sections tronquées au budget « shown » (les entêtes de section vides disparaissent).
  const windowed = $derived.by(() => {
    let budget = shown;
    const out = [];
    for (const sec of sections) {
      if (budget <= 0) break;
      const items = sec.items.slice(0, budget);
      budget -= items.length;
      out.push({ ...sec, items });
    }
    return out;
  });
  const hiddenCount = $derived(Math.max(0, totalRows - shown));

  const tagList = $derived(allTags());
  function tagCount(t) {
    return data.sessions.filter((s) => sessionTags(s.id).includes(t)).length;
  }
  // filtre de tag : clic = bascule (un seul actif) ; Ctrl/⌘+clic = combine (ET logique).
  function selectTag(tag, e) {
    if (e.ctrlKey || e.metaKey) {
      ui.tagFilters = ui.tagFilters.includes(tag) ? ui.tagFilters.filter((t) => t !== tag) : [...ui.tagFilters, tag];
    } else {
      ui.tagFilters = ui.tagFilters.length === 1 && ui.tagFilters[0] === tag ? [] : [tag];
    }
  }

  const dotClass = (s) => (needsReply(s) ? 'warn' : isWorking(s) ? 'info' : 'muted');
</script>

<aside class="inbox">
  <div class="ibx-head">
    <div class="ibx-top">
      <h1 class="ibx-title">Inbox</h1>
      <button class="ibx-new" onclick={() => goto('/new')} title="New session">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        New
      </button>
    </div>

    <div class="ibx-search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      <input type="search" placeholder="Search sessions…" bind:value={ui.search} />
    </div>

    <div class="ibx-seg">
      {#each SCOPES as sc}
        <button class="seg" class:active={scope === sc.key} onclick={() => (scope = sc.key)}>
          {sc.label} <span class="seg-n">{scopeCount(sc.key)}</span>
        </button>
      {/each}
    </div>

    {#if tagList.length}
      <div class="ibx-tags">
        {#each tagList as t}
          {@const on = ui.tagFilters.includes(t)}
          <button class="tf" class:on style="--c:{tagColor(t)}" title="Click to filter · Ctrl/⌘+click to combine"
                  onclick={(e) => selectTag(t, e)}># {t} <span class="tf-n">{tagCount(t)}</span></button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="ibx-list">
    {#if !windowed.length}
      <div class="ibx-empty">
        {#if scope !== 'all' && cAll > 0}
          Nothing {scope === 'needs' ? 'needs your reply' : scope === 'working' ? 'working' : 'active'} right now.
          <button class="ibx-viewall" onclick={() => (scope = 'all')}>View all {cAll}</button>
        {:else}
          No sessions.
        {/if}
      </div>
    {:else}
      {#each windowed as sec (sec.key)}
        <div class="ibx-sec ibx-sec-{sec.tone}">{sec.label}</div>
        {#each sec.items as s (s.id)}{@render row(s)}{/each}
      {/each}
      {#if hiddenCount > 0}
        <button class="ibx-more" onclick={() => (shown += STEP)}>Show {Math.min(STEP, hiddenCount)} more · {hiddenCount} hidden</button>
      {/if}
    {/if}
  </div>
</aside>

{#snippet row(s)}
  <div class="pt-row" class:active={page.params.id === s.id}
       onclick={() => goto('/session/' + encodeURIComponent(s.id))}>
    <span class="pt-dot pt-dot-{dotClass(s)}"></span>
    <div class="pt-body">
      <div class="pt-titlerow">
        <div class="pt-titlewrap">
          {#if pinnedSet.has(s.id)}
            <svg class="pt-pin" width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M16 3l5 5-4 1-3 3 1 5-3-3-6 6-1-1 6-6-3-3 5-1 3-3z"/></svg>
          {/if}
          <span class="pt-name">{sessionTitle(s)}</span>
        </div>
        <span class="pt-time">{ago(s.lastActivity)}</span>
      </div>
      <div class="pt-sub">{s.repo || s.projectName || '—'}{#if s.gitBranch} · {s.gitBranch}{/if}</div>
      {#if s.state === 'working' && s.activity}
        <div class="pt-snip pt-working">✦ {s.activity}…</div>
      {:else if s.bgJobs && s.bgJobs.length}
        <div class="pt-snip pt-working">🌀 {s.bgJobs.length} background job{s.bgJobs.length > 1 ? 's' : ''}{#if s.bgJobs[0].label} · {s.bgJobs[0].label}{/if}</div>
      {:else if s.todo && s.todo.current}
        <div class="pt-snip">▶ {s.todo.current} <span class="pt-frac">{s.todo.done}/{s.todo.total}</span></div>
      {:else if s.lastPrompt}
        <div class="pt-snip">{s.lastPrompt}</div>
      {/if}
      {#if sessionTags(s.id).length}
        <div class="pt-pills">
          {#each sessionTags(s.id) as t}
            <span class="pt-pill" style="--c:{tagColor(t)}"># {t}</span>
          {/each}
        </div>
      {/if}
      {#if sentId === s.id}
        <div class="pt-sent">✓ reply sent</div>
      {:else if s.hasQuestion && quickOpts(s.question)}
        <div class="pt-quick">
          {#each quickOpts(s.question) as o}
            <button class="pt-quick-opt" disabled={sendingId === s.id} title={o.description || o.label}
                    onclick={(e) => { e.stopPropagation(); quickReply(s, o.label); }}>{o.label}</button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="pt-acts">
      <button class="pt-act" title="Edit tags" aria-label="Edit tags"
              onclick={(e) => { e.stopPropagation(); openModal('editTags', { sessionId: s.id }); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 13.4 12 22l-8-8V4h10z"/><circle cx="7.5" cy="7.5" r="1.2" fill="currentColor"/></svg>
      </button>
      <button class="pt-act" class:on={pinnedSet.has(s.id)} title={pinnedSet.has(s.id) ? 'Unpin' : 'Pin'} aria-label="Pin"
              onclick={(e) => { e.stopPropagation(); togglePin(s.id); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill={pinnedSet.has(s.id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-4 1-3 3 1 5-3-3-6 6-1-1 6-6-3-3 5-1 3-3z"/></svg>
      </button>
      <button class="pt-act" title="Move to trash (transcript kept in bin/)" aria-label="Delete" disabled={deletingId === s.id}
              onclick={(e) => { e.stopPropagation(); delSession(s); }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      </button>
    </div>
  </div>
{/snippet}

<style>
  .inbox {
    width: 326px; min-width: 326px; background: var(--bg2);
    border-right: 1px solid var(--border); display: flex; flex-direction: column;
    transition: width .18s ease, min-width .18s ease;
  }
  .ibx-head { padding: 15px; border-bottom: 1px solid var(--border); display: flex; flex-direction: column; gap: 11px; }
  .ibx-top { display: flex; align-items: center; justify-content: space-between; }
  .ibx-title { font-size: 18px; font-weight: 800; letter-spacing: -.01em; margin: 0; }
  .ibx-new {
    display: inline-flex; align-items: center; gap: 5px;
    background: var(--accent); color: var(--accent-fg); border: none; border-radius: 8px;
    padding: 7px 12px; font: inherit; font-size: 13px; font-weight: 700; cursor: pointer;
    transition: background .12s;
  }
  .ibx-new:hover { background: var(--accent-d); }

  .ibx-search { position: relative; display: flex; align-items: center; }
  .ibx-search svg { position: absolute; left: 11px; color: var(--muted); pointer-events: none; }
  .ibx-search input {
    width: 100%; box-sizing: border-box; background: var(--input); border: 1px solid var(--border);
    border-radius: 9px; padding: 9px 12px 9px 34px; font: inherit; font-size: 13px; color: var(--text);
  }
  .ibx-search input::placeholder { color: var(--muted); }
  .ibx-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  .ibx-seg { display: flex; gap: 2px; background: var(--input); border-radius: 9px; padding: 3px; }
  .seg {
    flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    background: transparent; border: none; border-radius: 7px; padding: 6px 2px; cursor: pointer;
    font: inherit; font-size: 11.5px; font-weight: 600; color: var(--muted); white-space: nowrap;
    transition: background .12s, color .12s;
  }
  .seg:hover { color: var(--text); }
  .seg.active { background: var(--bg2); color: var(--text); box-shadow: var(--shadow-sm); }
  .seg-n { font-size: 11px; opacity: .8; }

  .ibx-tags { display: flex; flex-wrap: wrap; gap: 5px; }
  .tf {
    display: inline-flex; align-items: center; gap: 4px;
    background: color-mix(in srgb, var(--c) 13%, transparent); color: var(--c);
    border: none; border-radius: 6px; padding: 3px 8px; cursor: pointer;
    font: inherit; font-family: var(--mono); font-size: 10.5px; font-weight: 600;
  }
  .tf:hover { filter: brightness(1.05); }
  .tf.on { background: var(--c); color: #fff; }
  .tf-n { opacity: .7; }
  .tf.on .tf-n { opacity: .85; }

  .ibx-list { flex: 1; overflow-y: auto; padding: 8px; }
  .ibx-empty { color: var(--muted); text-align: center; padding: 40px 12px; font-size: 13px; line-height: 1.6; }
  .ibx-viewall { display: inline; background: none; border: none; padding: 0; font: inherit; font-weight: 600; color: var(--accent); cursor: pointer; }
  .ibx-viewall:hover { text-decoration: underline; }
  .ibx-more {
    display: block; width: calc(100% - 4px); margin: 8px 2px 4px; padding: 8px;
    background: var(--bg2); border: 1px dashed var(--border); border-radius: 9px;
    color: var(--muted); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
    transition: background .12s, color .12s, border-color .12s;
  }
  .ibx-more:hover { background: var(--hover); color: var(--text); border-color: var(--accent); }
  .ibx-sec {
    font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    padding: 12px 8px 6px; font-family: var(--mono);
  }
  .ibx-sec-warn { color: var(--warn); }
  .ibx-sec-info { color: var(--info); }
  .ibx-sec-muted { color: var(--muted); }

  .pt-row {
    position: relative; display: flex; gap: 10px; align-items: flex-start;
    padding: 12px 10px; border-radius: 9px; cursor: pointer;
    transition: background .1s;
  }
  /* hairline separator between consecutive sessions (not after a section header) */
  .pt-row + .pt-row::before {
    content: ""; position: absolute; left: 30px; right: 4px; top: -1px;
    border-top: 1px solid var(--border);
  }
  .pt-row:hover, .pt-row.active { border-radius: 9px; }
  .pt-row:hover::before, .pt-row:hover + .pt-row::before,
  .pt-row.active::before, .pt-row.active + .pt-row::before { display: none; }
  .pt-row:hover { background: var(--hover); }
  .pt-row.active { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
  .pt-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
  .pt-dot-info { background: var(--info); }
  .pt-dot-warn { background: var(--warn); }
  .pt-dot-muted { background: var(--muted); }
  .pt-body { min-width: 0; flex: 1; }
  .pt-titlerow { display: flex; align-items: baseline; gap: 8px; }
  .pt-titlewrap { display: flex; align-items: center; gap: 5px; min-width: 0; flex: 1; }
  .pt-pin { color: var(--accent); flex: 0 0 auto; }
  .pt-name { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-row.active .pt-name { font-weight: 700; }
  .pt-time { font-family: var(--mono); font-size: 10.5px; color: var(--muted); flex: 0 0 auto; white-space: nowrap; }
  .pt-sub { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-snip { font-size: 11.5px; color: var(--muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pt-working { color: var(--info); font-style: italic; }
  .pt-frac { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .pt-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .pt-pill {
    font-family: var(--mono); font-size: 10px; font-weight: 600; line-height: 1.6;
    color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent);
    border-radius: 6px; padding: 0 6px;
  }
  .pt-sent { margin-top: 6px; font-size: 11.5px; font-weight: 600; color: var(--success); }
  .pt-quick { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .pt-quick-opt {
    background: var(--accent-soft); color: var(--accent); border: 1px solid var(--accent-soft);
    border-radius: 7px; padding: 3px 9px; font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background .12s, color .12s;
  }
  .pt-quick-opt:hover { background: var(--accent); color: var(--accent-fg); }
  .pt-quick-opt:disabled { opacity: .55; cursor: default; }

  .pt-acts {
    position: absolute; top: 8px; right: 8px; display: flex; gap: 2px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 2px;
    box-shadow: var(--shadow-sm); opacity: 0; transition: opacity .12s;
  }
  .pt-row:hover .pt-acts { opacity: 1; }
  .pt-act {
    width: 24px; height: 24px; display: flex; align-items: center; justify-content: center;
    background: transparent; border: none; border-radius: 6px; color: var(--muted); cursor: pointer; padding: 0;
    transition: background .12s, color .12s;
  }
  .pt-act:hover { background: var(--chip); color: var(--text); }
  .pt-act.on { color: var(--accent); background: var(--accent-soft); }
  .pt-act:disabled { opacity: .5; cursor: default; }

  @media (max-width: 900px) {
    .inbox { width: 100%; min-width: 0; border-right: none; border-bottom: 1px solid var(--border); }
  }
</style>
