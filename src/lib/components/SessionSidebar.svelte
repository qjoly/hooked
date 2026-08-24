<script>
  // Collapsible left session menu (redesign). Expanded: a simple list (name + status pill), grouped
  // by project or flat per config, with Active / Archived tabs. Collapsed: a thin strip of clickable
  // status tiles so you can still switch sessions. Width is drag-resizable and persisted; open/closed
  // and width all live in ui (localStorage). Toggle via the ◀/▶ buttons or ⌘/Ctrl+B.
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ui, data, sessionTitle, sessionTags, togglePin, allTags, tagUsage, openModal, isSessionArchived, isArchived, toggleArchive, addSplit, isInSplit, canSplit } from '$lib/state.svelte.js';
  import { ago, tagColor } from '$lib/format.js';
  import Icon from '$lib/components/Icon.svelte';

  let tab = $state('active'); // 'active' | 'archived'
  const currentId = $derived(page.params.id || null);
  const isActive = (s) => ['working', 'background', 'waiting', 'attention'].includes(s.state);
  const needsDecision = (s) => s.hasQuestion || s.hasPlan || s.state === 'attention' || s.state === 'waiting';
  const dotClass = (s) =>
    s.hasQuestion || s.hasPlan || s.state === 'attention' ? 'attention'
    : s.state === 'working' ? 'working'
    : s.state === 'background' ? 'bgjob'
    : s.state === 'waiting' ? 'waiting'
    : s.state === 'ended' ? 'ended' : 'idle';

  const pinnedSet = $derived(new Set(ui.pinned));
  const isPinned = (id) => pinnedSet.has(id);

  // tag filter (transient) : click = single tag; Ctrl/⌘+click = combine (AND). A session must
  // carry ALL active filter tags. The chip bar lists tags actually in use.
  const knownTags = $derived(allTags());
  function selectTag(tag, e) {
    if (e.ctrlKey || e.metaKey) {
      ui.tagFilters = ui.tagFilters.includes(tag) ? ui.tagFilters.filter((t) => t !== tag) : [...ui.tagFilters, tag];
    } else {
      ui.tagFilters = ui.tagFilters.length === 1 && ui.tagFilters[0] === tag ? [] : [tag];
    }
  }
  const matchesTagFilter = (s) => !ui.tagFilters.length || ui.tagFilters.every((t) => sessionTags(s.id).includes(t));

  // NOTE: the current session is NOT hoisted to the top — selecting a session must not reshuffle
  // the list under the cursor (it stays where it was, highlighted via `.cur`). Pinned sessions DO
  // rise to the top (that's the point of a pin), as they did before the rework.
  const byActivity = (a, b) => {
    const pa = isPinned(a.id), pb = isPinned(b.id);
    if (pa !== pb) return pa ? -1 : 1;
    const da = needsDecision(a), db = needsDecision(b);
    if (da !== db) return da ? -1 : 1;
    const aa = isActive(a), ab = isActive(b);
    if (aa !== ab) return aa ? -1 : 1;
    return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  };

  function abbrev(s) {
    const t = (sessionTitle(s) || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    const w = t.split(/\s+/).filter(Boolean);
    return ((w.length >= 2 ? w.slice(0, 3).map((x) => x[0]).join('') : t.slice(0, 3)) || '·').toUpperCase().slice(0, 3);
  }

  // active list (hide archived/finished, keep current) vs archived list — both honour the tag filter.
  const active = $derived(data.sessions.filter((s) => (s.id === currentId || !isSessionArchived(s)) && matchesTagFilter(s)).sort(byActivity));
  const archived = $derived(data.sessions.filter((s) => isSessionArchived(s) && matchesTagFilter(s)).sort(byActivity));
  const shown = $derived(tab === 'archived' ? archived : active);
  const projectKey = (s) => s.repo || s.projectName || '—';

  const groups = $derived.by(() => {
    if (!ui.groupByProject) return [{ key: '', label: null, items: shown }];
    const g = new Map();
    for (const s of shown) { const k = projectKey(s); if (!g.has(k)) g.set(k, []); g.get(k).push(s); }
    const lastOf = (arr) => arr.reduce((m, s) => Math.max(m, Date.parse(s.lastActivity || 0) || 0), 0);
    return [...g.keys()].sort((a, b) => lastOf(g.get(b)) - lastOf(g.get(a)))
      .map((proj) => ({ key: proj, label: proj, items: g.get(proj) }));
  });

  function toggleGroup(k) { ui.collapsed = { ...ui.collapsed, [k]: !ui.collapsed[k] }; }
  const open = (s) => goto('/session/' + encodeURIComponent(s.id));

  // drag-resize the panel width (persisted). Clamped to a sane range.
  function startResize(e) {
    e.preventDefault();
    const startX = e.clientX, startW = ui.sidebarWidth;
    const move = (ev) => { ui.sidebarWidth = Math.max(180, Math.min(460, startW + (ev.clientX - startX))); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

{#if ui.sideMenuOpen}
  <aside class="ssb" style="width:{ui.sidebarWidth}px;min-width:{ui.sidebarWidth}px">
    <div class="ssb-head">
      <div class="ssb-tabs">
        <button class="ssb-tab" class:on={tab === 'active'} onclick={() => (tab = 'active')}>Sessions <span class="ssb-count">{active.length}</span></button>
        <button class="ssb-tab" class:on={tab === 'archived'} onclick={() => (tab = 'archived')}>Archived <span class="ssb-count">{archived.length}</span></button>
      </div>
      <button class="ssb-icon" title="Group by project on/off" aria-label="Toggle grouping"
              onclick={() => (ui.groupByProject = !ui.groupByProject)}>{#if ui.groupByProject}<Icon name="folder-open" size={14} />{:else}<Icon name="menu" size={14} />{/if}</button>
      <button class="ssb-icon" title="Collapse sidebar (⌘/Ctrl+B)" aria-label="Collapse sidebar"
              onclick={() => (ui.sideMenuOpen = false)}><Icon name="arrow-left" size={14} /></button>
    </div>
    {#if knownTags.length}
      <div class="ssb-filters">
        {#each knownTags as t (t)}
          {@const on = ui.tagFilters.includes(t)}
          <button class="ssb-tf" class:on style="--c:{tagColor(t)}"
                  title="Filter by #{t} · Ctrl/⌘+click to combine" onclick={(e) => selectTag(t, e)}>
            #{t} <span class="ssb-tf-n">{tagUsage(t)}</span>
          </button>
        {/each}
        {#if ui.tagFilters.length}
          <button class="ssb-tf clear" title="Clear tag filter" onclick={() => (ui.tagFilters = [])}><Icon name="close" size={12} /></button>
        {/if}
      </div>
    {/if}
    <div class="ssb-list">
      {#each groups as g (g.key)}
        {#if g.label}
          <button class="ssb-group" class:collapsed={ui.collapsed[g.key]} onclick={() => toggleGroup(g.key)}>
            <span class="ssb-chev"><Icon name="chevron-right" size={12} /></span><span class="ssb-gname">{g.label}</span><span class="ssb-gn">{g.items.length}</span>
          </button>
        {/if}
        {#if !g.label || !ui.collapsed[g.key]}
          {#each g.items as s (s.id)}
            <div class="ssb-row" class:cur={s.id === currentId} class:dim={!isActive(s)}
                 role="button" tabindex="0" onclick={() => open(s)}
                 onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}>
              <div class="ssb-line">
                <span class="ssb-dot ssb-{dotClass(s)}"></span>
                {#if isPinned(s.id)}<span class="ssb-pin-mark" title="Pinned"><Icon name="pin" size={11} /></span>{/if}
                <span class="ssb-name">{sessionTitle(s)}</span>
                <span class="ssb-ago">{ago(s.lastActivity)}</span>
                <!-- actions au survol : tag · pin · (split / unarchive) -->
                <span class="ssb-acts">
                  <button class="ssb-act" title="Edit tags" aria-label="Edit tags"
                          onclick={(e) => { e.stopPropagation(); openModal('editTags', { sessionId: s.id }); }}><Icon name="tag" size={13} /></button>
                  <button class="ssb-act" class:on={isPinned(s.id)} title={isPinned(s.id) ? 'Unpin' : 'Pin'} aria-label="Pin"
                          onclick={(e) => { e.stopPropagation(); togglePin(s.id); }}><Icon name="pin" size={13} /></button>
                  {#if tab === 'archived' && isArchived(s.id)}
                    <button class="ssb-act" title="Unarchive" onclick={(e) => { e.stopPropagation(); toggleArchive(s.id); }}><Icon name="unarchive" size={13} /></button>
                  {:else if tab === 'active' && s.id !== currentId && !isInSplit(s.id) && canSplit()}
                    <button class="ssb-act" title="Split beside the current session" onclick={(e) => { e.stopPropagation(); addSplit(s.id); }}><Icon name="pane" size={13} /></button>
                  {/if}
                </span>
              </div>
              {#if sessionTags(s.id).length}
                <!-- tags (manuels + auto pr-approved / pr-changes-requested) : mini-pills compactes -->
                <div class="ssb-tags">
                  {#each sessionTags(s.id) as t (t)}<span class="ssb-tag" style="--c:{tagColor(t)}">#{t}</span>{/each}
                </div>
              {/if}
            </div>
          {/each}
        {/if}
      {/each}
      {#if !shown.length}
        <div class="ssb-empty">{tab === 'archived' ? 'No archived sessions.' : 'No sessions.'}</div>
      {/if}
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ssb-resize" onpointerdown={startResize} title="Drag to resize"></div>
  </aside>
{:else}
  <!-- collapsed: a thin rail of clickable status tiles so you can still switch sessions -->
  <div class="ssb-collapsed">
    <button class="ssb-icon expand" title="Expand session sidebar (⌘/Ctrl+B)" aria-label="Expand sidebar"
            onclick={() => (ui.sideMenuOpen = true)}><Icon name="arrow-right" size={14} /></button>
    <div class="ssb-tiles">
      {#each active as s (s.id)}
        <a class="ssb-tile" class:cur={s.id === currentId} class:dim={!isActive(s)}
           href={'/session/' + encodeURIComponent(s.id)} title={sessionTitle(s)}>
          <span class="ssb-ab">{abbrev(s)}</span>
          <span class="ssb-dot ssb-{dotClass(s)}"></span>
        </a>
      {/each}
    </div>
  </div>
{/if}

<style>
  .ssb {
    position: relative; background: var(--bg2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; flex: 0 0 auto;
  }
  :global(body.focus) .ssb, :global(body.focus) .ssb-collapsed { display: none; }
  .ssb-head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 6px; border-bottom: 1px solid var(--border); }
  .ssb-tabs { display: flex; gap: 2px; flex: 1 1 auto; min-width: 0; }
  .ssb-tab {
    background: none; border: none; border-radius: 7px; padding: 4px 8px; cursor: pointer;
    font: inherit; font-size: 12px; font-weight: 700; color: var(--muted); white-space: nowrap;
  }
  .ssb-tab:hover { color: var(--text); }
  .ssb-tab.on { background: var(--accent-soft); color: var(--accent-d); }
  .ssb-count { font-family: var(--mono); font-size: 9.5px; opacity: .8; font-weight: 600; }
  .ssb-icon {
    width: 26px; height: 24px; border: none; background: transparent; color: var(--muted); flex: 0 0 auto;
    border-radius: 7px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  }
  .ssb-icon:hover { background: var(--hover); color: var(--text); }

  /* Side panel sans gap (anti-bulle) : liste affleurante — une ligne = un filet, group headers
     en bandeaux uppercase, session courante = rail accent 2px + fond de surface. */
  .ssb-list { flex: 1 1 auto; overflow-y: auto; padding: 0; }
  .ssb-empty { color: var(--muted); font-size: 12px; text-align: center; padding: 24px 8px; }
  .ssb-group {
    display: flex; align-items: center; gap: 6px; width: 100%; background: var(--bg3); border: none;
    border-bottom: 1px solid var(--border);
    color: var(--muted); font: inherit; font-family: var(--mono); font-size: 10px; font-weight: 700;
    letter-spacing: .1em; text-transform: uppercase; padding: 5px 10px; cursor: pointer; text-align: left;
  }
  .ssb-group:hover { color: var(--text); }
  .ssb-chev { transition: transform .12s; }
  .ssb-group:not(.collapsed) .ssb-chev { transform: rotate(90deg); }
  .ssb-gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ssb-gn { color: var(--muted); }

  .ssb-row {
    position: relative; display: flex; flex-direction: column; align-items: stretch; gap: 3px;
    padding: 7px 10px; border-radius: 0;
    border-bottom: 1px solid var(--border);
    cursor: pointer; min-width: 0;
  }
  .ssb-line { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; }
  /* tags compacts : lisibles mais discrets, alignés sous le nom (décalés du dot) */
  .ssb-tags { display: flex; flex-wrap: wrap; gap: 3px; padding-left: 16px; min-width: 0; }
  .ssb-tag {
    font: 600 9px var(--mono); line-height: 1.6; padding: 0 5px; border-radius: 0;
    color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ssb-row:hover { background: var(--hover); }
  .ssb-row.cur { background: var(--panel); box-shadow: inset 2px 0 0 var(--accent); }
  .ssb-row.dim { opacity: .6; }
  .ssb-row.dim:hover { opacity: 1; }
  .ssb-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
  .ssb-working { background: var(--working); animation: ssb-pulse 1.6s ease-in-out infinite; }
  .ssb-waiting { background: var(--waiting); animation: ssb-pulse 1.6s ease-in-out infinite; }
  .ssb-attention { background: var(--attention); animation: ssb-pulse 1s ease-in-out infinite; }
  .ssb-bgjob { background: var(--background); animation: ssb-pulse 1.6s ease-in-out infinite; }
  .ssb-ended { background: var(--ended); }
  .ssb-idle { background: var(--idle); }
  @keyframes ssb-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
  .ssb-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .ssb-row.cur .ssb-name { font-weight: 700; color: var(--accent-d); }
  .ssb-ago { flex: 0 0 auto; font-family: var(--mono); font-size: 9.5px; color: var(--muted); }
  .ssb-pin-mark { flex: 0 0 auto; font-size: 9px; line-height: 1; opacity: .8; }
  /* actions au survol : groupe ancré à droite, masqué au repos, révélé au hover de la ligne */
  .ssb-acts { position: absolute; right: 4px; display: none; gap: 2px; background: transparent; padding-left: 4px; }
  .ssb-row:hover .ssb-acts { display: inline-flex; }
  .ssb-row:hover .ssb-ago { visibility: hidden; }
  .ssb-act {
    width: 22px; height: 22px; border: none;
    background: transparent; color: var(--muted); border-radius: 6px; cursor: pointer; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .ssb-act:hover { background: var(--accent-soft); color: var(--accent-d); }
  .ssb-act.on { color: var(--accent-d); }

  /* barre de filtre par tag (chips, comme l'ancienne inbox) */
  .ssb-filters { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--border); }
  .ssb-tf {
    font: 600 9.5px var(--mono); line-height: 1.6; padding: 1px 6px; border-radius: 0; cursor: pointer;
    color: var(--c); background: transparent; border: 1px solid color-mix(in srgb, var(--c) 40%, transparent);
  }
  .ssb-tf:hover { background: color-mix(in srgb, var(--c) 12%, transparent); }
  .ssb-tf.on { background: color-mix(in srgb, var(--c) 22%, transparent); border-color: var(--c); }
  .ssb-tf-n { opacity: .6; }
  .ssb-tf.clear { color: var(--muted); border-color: var(--border2); }

  /* drag handle on the right edge */
  .ssb-resize { position: absolute; top: 0; right: -3px; width: 6px; height: 100%; cursor: col-resize; z-index: 3; }
  .ssb-resize:hover { background: var(--accent); opacity: .5; }

  /* collapsed rail: expand button + status tiles */
  .ssb-collapsed {
    width: 50px; min-width: 50px; background: var(--bg2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 8px 0; overflow-y: auto;
  }
  .ssb-collapsed .expand { width: 30px; height: 26px; border: 1px solid var(--border); margin-bottom: 2px; }
  .ssb-tiles { display: flex; flex-direction: column; align-items: center; gap: 7px; }
  .ssb-tile {
    position: relative; width: 38px; height: 38px; flex: 0 0 auto; border-radius: 11px;
    background: var(--panel); border: 1px solid var(--border); text-decoration: none;
    display: flex; align-items: center; justify-content: center;
    transition: border-color .12s, box-shadow .12s, opacity .12s;
  }
  .ssb-tile:hover { border-color: var(--border2); box-shadow: var(--shadow-sm); }
  .ssb-tile.cur { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
  .ssb-tile.dim { opacity: .5; }
  .ssb-tile.dim:hover { opacity: 1; }
  .ssb-ab { font-family: var(--mono); font-size: 8.5px; font-weight: 700; color: var(--muted); }
  .ssb-tile.cur .ssb-ab { color: var(--accent-d); }
  .ssb-tile .ssb-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border: 2px solid var(--bg2); }

  @media (max-width: 900px) { .ssb, .ssb-collapsed { display: none; } }
</style>
