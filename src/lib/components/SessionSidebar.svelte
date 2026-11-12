<script>
  // Collapsible left session menu (redesign). Expanded: a simple list (name + status pill), grouped
  // by project or flat per config, with Active / Archived tabs. Collapsed: a thin strip of clickable
  // status tiles so you can still switch sessions. Width is drag-resizable and persisted; open/closed
  // and width all live in ui (localStorage). Toggle via the ◀/▶ buttons or ⌘/Ctrl+B.
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ui, data, settings, sessionTitle, sessionTags, togglePin, openModal, isSessionArchived, isArchived, toggleArchive, isIncognito, toggleIncognito, addSplit, isInSplit, canSplit, groupUnits, isGroupArchived, groupName, isGrouped, dnd, snoozeUntil, snoozeSessionUntil, wakeSession } from '$lib/state.svelte.js';
  import { SECTIONS, sectionOf, snoozePresets, wakeLabel, hm } from '$lib/sidebarSections.js';
  import { onMount } from 'svelte';
  import { ago, agoShort, fmtSpan, tagColor, lotColor, isActiveSession as isActive, needsDecision, sessionDot as dotClass } from '$lib/format.js';
  import { cacheCountdown } from '$lib/promptCache.js';
  import { dragSession, dropSession, dropDetach } from '$lib/groupDnd.js';
  import Icon from '$lib/components/Icon.svelte';

  // Local clock: the elapsed time and the cache countdown move between two data refreshes.
  let nowMs = $state(Date.now());
  onMount(() => {
    const iv = setInterval(() => { nowMs = Date.now(); }, 15_000);
    return () => clearInterval(iv);
  });
  const cacheLeft = (s) => cacheCountdown(s.cache, settings.sidebarCache.windowMin, nowMs);
  const cacheReplacesAgo = $derived(settings.sidebarCache.display === 'replace');

  let tab = $state('active'); // 'active' | 'archived'
  const currentId = $derived(page.params.id || null);

  const pinnedSet = $derived(new Set(ui.pinned));
  const isPinned = (id) => pinnedSet.has(id);

  const toggleIn = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const matchesFilters = (s) =>
    ui.tagFilters.every((t) => sessionTags(s.id).includes(t)) &&
    (!ui.repoFilters.length || ui.repoFilters.includes(projectKey(s)));
  const filterCount = $derived(ui.tagFilters.length + ui.repoFilters.length);

  // Ordre de la liste. Les PALIERS (épinglées → en attente de décision → actives) sont les mêmes
  // dans les trois modes : c'est eux qui portent la garantie de la fenêtre de LIST_WINDOW lignes —
  // ce qui demande une action reste visible sans déplier. Seul le DÉPARTAGE final change, et
  // l'ordre des en-têtes de projet (cf. `groups`).
  const SORT_MODES = [
    { key: 'dynamic', label: 'Dynamic', hint: 'Awaiting you first, then most recent' },
    { key: 'alpha', label: 'Alphabetical', hint: 'Projects and sessions A→Z' },
    { key: 'alpha-project', label: 'Alphabetical (projects only)', hint: 'Project headers A→Z, sessions by activity' },
  ];
  // « projets uniquement » n'a de sens qu'avec le regroupement : sans en-tête, il n'y a rien à
  // ordonner. On le retire alors du menu et on retombe sur DYNAMIC. Chaque mode est un couple
  // (ordre des en-têtes, ordre des sessions) ; l'en-tête disparu, il ne reste que la seconde
  // composante, qui pour ce mode est justement l'activité. Retomber sur l'alphabétique global
  // garderait la composante qui vient de disparaître et réordonnerait les sessions sans qu'on l'ait
  // demandé. `ui.sortMode` n'est pas touché : réactiver le regroupement restitue le choix mémorisé.
  const storedSort = $derived(SORT_MODES.some((m) => m.key === ui.sortMode) ? ui.sortMode : 'dynamic');
  const LAYOUTS = [
    { key: 'status', label: 'By status', hint: 'Waiting, working, idle, snoozed, archived' },
    { key: 'project', label: 'By project', hint: 'One folder per repository' },
    { key: 'flat', label: 'Flat', hint: 'A single list' },
  ];
  const layout = $derived(LAYOUTS.some((l) => l.key === ui.sidebarLayout) ? ui.sidebarLayout : 'status');
  const byStatus = $derived(layout === 'status');
  const groupByProject = $derived(layout === 'project');
  const sortModes = $derived(SORT_MODES.filter((m) => m.key !== 'alpha-project' || groupByProject));
  const sortMode = $derived(storedSort === 'alpha-project' && !groupByProject ? 'dynamic' : storedSort);
  const byName = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });

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
    if (sortMode === 'alpha') return byName(sessionTitle(a), sessionTitle(b));
    return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  };

  function abbrev(s) {
    const t = (sessionTitle(s) || '').replace(/[^\p{L}\p{N} ]/gu, ' ').trim();
    const w = t.split(/\s+/).filter(Boolean);
    return ((w.length >= 2 ? w.slice(0, 3).map((x) => x[0]).join('') : t.slice(0, 3)) || '·').toUpperCase().slice(0, 3);
  }

  // `hideOld` (« hide > 24h ») : masque les sessions sans activité depuis plus de 24 h. Le réglage
  // existait avant la refonte inbox/cockpit, qui a retiré le filtre et sa case à cocher mais a laissé
  // la clé persistée — donc un réglage sauvegardé qui ne faisait plus rien. On restaure la sémantique
  // d'origine (seuil 24 h) plutôt que d'en inventer une autre.
  //
  // Trois catégories échappent au filtre, quel que soit leur âge : la session COURANTE (la faire
  // disparaître sous le curseur en cochant la case serait absurde), les ÉPINGLÉES (c'est le sens
  // d'une épingle) et celles qui ATTENDENT une décision — une question posée il y a 30 h reste une
  // question à traiter, la cacher est exactement le contraire du service rendu.
  const OLD_MS = 86400000;
  const keptDespiteAge = (s) => s.id === currentId || isPinned(s.id) || needsDecision(s);
  function passesAge(s, now) {
    if (!ui.hideOld || keptDespiteAge(s)) return true;
    return !s.lastActivity || (now - Date.parse(s.lastActivity)) <= OLD_MS;
  }

  // active list (hide archived/finished, keep current) vs archived list — both honour the tag filter.
  const activePool = $derived.by(() => {
    const now = Date.now();
    return data.sessions.filter((s) => (s.id === currentId || !isSessionArchived(s)) && passesAge(s, now));
  });
  const archivedPool = $derived.by(() => {
    const now = Date.now();
    return data.sessions.filter((s) => isSessionArchived(s) && passesAge(s, now));
  });
  const statusPool = $derived.by(() => {
    const now = Date.now();
    return data.sessions.filter((s) => passesAge(s, now));
  });
  const active = $derived(activePool.filter(matchesFilters).sort(byActivity));
  const archived = $derived(archivedPool.filter(matchesFilters).sort(byActivity));
  // Counted before filtering, so picking one tag or repo doesn't hide the others; picked values
  // stay listed so they can be unpicked.
  const filterPool = $derived(byStatus ? statusPool : tab === 'archived' ? archivedPool : activePool);
  function countBy(keysOf, picked, byCount) {
    const m = new Map(picked.map((k) => [k, 0]));
    for (const s of filterPool) for (const k of keysOf(s)) m.set(k, (m.get(k) || 0) + 1);
    return [...m].sort((a, b) => (byCount ? b[1] - a[1] : 0) || a[0].localeCompare(b[0]));
  }
  const tagOptions = $derived(countBy((s) => sessionTags(s.id), ui.tagFilters, false));
  const repoOptions = $derived(countBy((s) => [projectKey(s)], ui.repoFilters, true));
  const projectKey = (s) => s.repo || s.projectName || '—';

  // Session GROUPS are the list's unit: a group is one entry headed by its mother session, its
  // children indented below (a lone session is a one-member group and renders exactly as before).
  // Folded from the sorted session list, so a group ranks where its most pressing member would.
  const activeUnits = $derived(groupUnits(active));
  // Archived tab: only groups whose members are ALL archived — an archived child of a live group
  // stays reachable from its group (dimmed in the group's tabs).
  const archivedUnits = $derived(groupUnits(archived).filter((u) => isGroupArchived(u.key)));
  const shown = $derived(tab === 'archived' ? archivedUnits : activeUnits);
  const unitHas = (u, pred) => u.all.some(pred);
  // Collapsed group → its header dot summarizes the members (most pressing state wins).
  const DOT_RANK = ['attention', 'working', 'waiting', 'bgjob', 'idle', 'ended'];
  const unitDot = (u) => u.all.map(dotClass).sort((a, b) => DOT_RANK.indexOf(a) - DOT_RANK.indexOf(b))[0];
  const groupCollapsed = (u) => !!ui.collapsed['g:' + u.key];
  function toggleUnit(u) { ui.collapsed = { ...ui.collapsed, ['g:' + u.key]: !ui.collapsed['g:' + u.key] }; }

  // Fenêtrage de la liste. Sans ça, la sidebar montait UNE LIGNE PAR SESSION — 157 sur cette
  // instance, chacune avec ses trois boutons d'action au survol et sa rangée de tags.
  //
  // La fenêtre est GLOBALE, pas par groupe. Une première version coupait à 8 par groupe (comme la
  // vue Deck) : mesuré, ça ne retirait que ~25 % des lignes, parce que le plancher de 8 se multiplie
  // par le nombre de groupes — 48 ici, de médiane 1 session. La pile ne raccourcissait donc pas, ce
  // qui est précisément ce qu'on lui demandait. Un plafond global la borne quel que soit le nombre de
  // projets : on affiche les LIST_WINDOW sessions les plus pertinentes, les groupes ne servent qu'à
  // structurer ce qui est montré.
  //
  // On ne coupe jamais dans ce qui compte : le tri (byActivity) place déjà épinglées → en attente de
  // décision → actives → récentes, donc les premières lignes SONT les importantes, et la fenêtre
  // s'étend pour les prendre toutes s'il y en a plus que LIST_WINDOW.
  const LIST_WINDOW = 25;
  let expanded = $state(false);
  const windowSize = $derived.by(() => {
    // La session courante n'est VOLONTAIREMENT pas remontée en tête (cf. la note sur byActivity :
    // sélectionner une session ne doit pas réordonner la liste sous le curseur). Elle peut donc se
    // trouver au-delà de la fenêtre — on étend jusqu'à elle, sinon ouvrir une vieille session la
    // ferait disparaître de la liste au moment même où on la consulte.
    const cur = shown.findIndex((u) => unitHas(u, (x) => x.id === currentId));
    return Math.max(
      LIST_WINDOW,
      shown.filter((u) => unitHas(u, (x) => isPinned(x.id) || needsDecision(x) || isActive(x))).length,
      cur >= 0 ? cur + 1 : 0,
    );
  });
  // Liste effectivement rendue : c'est ELLE qui est groupée ensuite, pas l'inverse.
  const windowed = $derived(expanded ? shown : shown.slice(0, windowSize));
  const hiddenCount = $derived(Math.max(0, shown.length - windowed.length));

  const isSnoozed = (s) => snoozeUntil(s.id) > nowMs;
  const wakeOf = (u) => Math.min(...u.all.map((s) => snoozeUntil(s.id) || Infinity));
  const sections = $derived.by(() => {
    if (!byStatus) return [];
    const live = statusPool.filter((s) => !isSessionArchived(s) && matchesFilters(s)).sort(byActivity);
    const flags = { archived: isSessionArchived, snoozed: isSnoozed };
    const buckets = Object.fromEntries(SECTIONS.map((x) => [x.key, []]));
    for (const u of groupUnits(live)) buckets[sectionOf(u.all, flags)].push(u);
    buckets.archived = archivedUnits;
    buckets.snoozed.sort((a, b) => wakeOf(a) - wakeOf(b));
    return SECTIONS.map((x) => ({ ...x, units: buckets[x.key] })).filter((x) => x.units.length);
  });
  const sectionCollapsed = (x) => ui.collapsed['s:' + x.key] ?? !!x.folded;
  const listed = $derived(sections.filter((x) => !x.docked));
  const docked = $derived(sections.filter((x) => x.docked));
  function toggleSection(x) { ui.collapsed = { ...ui.collapsed, ['s:' + x.key]: !sectionCollapsed(x) }; }
  let openSections = $state({});
  const currentIndex = (units) => units.findIndex((u) => unitHas(u, (s) => s.id === currentId));
  function sectionItems(x) {
    const cur = currentIndex(x.units);
    if (sectionCollapsed(x)) return cur >= 0 ? [x.units[cur]] : [];
    if (!x.window || openSections[x.key]) return x.units;
    return x.units.slice(0, Math.max(x.window, cur + 1));
  }
  const railUnits = $derived(byStatus ? sections.filter((x) => x.key !== 'archived').flatMap((x) => x.units) : activeUnits);

  function popoverPosInSidebar(el, width) {
    const r = el.getBoundingClientRect();
    const box = el.closest('.ssb').getBoundingClientRect();
    const right = Math.max(4, Math.min(box.right - r.right, box.width - width - 4));
    return box.bottom - r.bottom < 280 ? { bottom: box.bottom - r.top + 4, right } : { top: r.bottom - box.top + 4, right };
  }
  let sortPos = $state({ top: 0, right: 0 });
  const placeStyle = (p) => (p.bottom != null ? `bottom:${p.bottom}px` : `top:${p.top}px`) + `;right:${p.right}px`;
  let snoozeMenu = $state(null);
  function openSnooze(e, s) {
    e.stopPropagation();
    snoozeMenu = snoozeMenu?.id === s.id ? null : { id: s.id, ...popoverPosInSidebar(e.currentTarget, 170), presets: snoozePresets() };
  }
  function pickSnooze(until) {
    if (until) snoozeSessionUntil(snoozeMenu.id, until); else wakeSession(snoozeMenu.id);
    snoozeMenu = null;
  }
  $effect(() => {
    if (!snoozeMenu) return;
    const away = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ssb-snooze')) snoozeMenu = null; };
    const esc = (e) => { if (e.key === 'Escape') snoozeMenu = null; };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  });

  const groups = $derived.by(() => {
    if (!groupByProject) return [{ key: '', label: null, items: windowed }];
    const g = new Map();
    // a group sits under its mother's project, even when its children work in other repos.
    for (const u of windowed) { const k = projectKey(u.mother); if (!g.has(k)) g.set(k, []); g.get(k).push(u); }
    const lastOf = (arr) => arr.reduce((m, u) => Math.max(m, ...u.all.map((s) => Date.parse(s.lastActivity || 0) || 0)), 0);
    // en-têtes : A→Z dans les deux modes alphabétiques, sinon projet le plus récemment actif d'abord.
    const byGroup = sortMode === 'dynamic' ? (a, b) => lastOf(g.get(b)) - lastOf(g.get(a)) : byName;
    return [...g.keys()].sort(byGroup)
      .map((proj) => ({ key: proj, label: proj, items: g.get(proj) }));
  });


  // Menu de tri : popover ancré sous son icône. Le `capture` sur pointerdown ferme AVANT que le
  // clic n'atteigne une ligne de session (sinon choisir « fermer » naviguerait vers une session).
  let sortOpen = $state(false);
  // Un clic sur l'entrée DÉJÀ active ne réécrit rien. Il ne changerait rien à l'écran, mais il
  // effacerait en silence un `alpha-project` mémorisé pendant que le regroupement est désactivé —
  // le menu y montre « Dynamic » coché, et rien ne signalerait la perte du réglage. Un clic qui
  // réordonne vraiment la liste, lui, prime et s'enregistre.
  function pickSort(k) { if (k !== sortMode) ui.sortMode = k; sortOpen = false; }
  function pickLayout(k) { ui.sidebarLayout = k; sortOpen = false; }
  let filterOpen = $state(false);
  let filterView = $state(null);
  let filterQuery = $state('');
  const picked = () => (filterView === 'repo' ? ui.repoFilters : ui.tagFilters);
  function openFilterView(view) { filterView = view; filterQuery = ''; }
  function togglePick(k) {
    if (filterView === 'repo') ui.repoFilters = toggleIn(ui.repoFilters, k);
    else ui.tagFilters = toggleIn(ui.tagFilters, k);
  }
  const pickerOptions = $derived.by(() => {
    if (!filterView) return [];
    const q = filterQuery.trim().toLowerCase().replace(/^#/, '');
    const hits = (filterView === 'repo' ? repoOptions : tagOptions).filter(([k]) => !q || k.toLowerCase().includes(q));
    const on = picked();
    return [...hits.filter(([k]) => on.includes(k)), ...hits.filter(([k]) => !on.includes(k))];
  });
  const summarize = (list, fmt, noun) => (!list.length ? 'Any' : list.length === 1 ? fmt(list[0]) : `${list.length} ${noun}`);
  const repoSummary = $derived(summarize(ui.repoFilters, (r) => r, 'repos'));
  const tagSummary = $derived(summarize(ui.tagFilters, (tg) => '#' + tg, 'tags'));
  const focusOnMount = (el) => { el.focus(); };
  let filterPos = $state({ top: 0, right: 0 });
  $effect(() => {
    if (!filterOpen) return;
    const away = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ssb-filter')) filterOpen = false; };
    const esc = (e) => { if (e.key === 'Escape') filterOpen = false; };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
  });
  $effect(() => {
    if (!sortOpen) return;
    const away = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.ssb-sort')) sortOpen = false; };
    const esc = (e) => { if (e.key === 'Escape') sortOpen = false; };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('keydown', esc); };
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
        {#if byStatus}
          <span class="ssb-tab ssb-title">Sessions <span class="ssb-count">{railUnits.length}</span></span>
        {:else}
          <button class="ssb-tab" class:on={tab === 'active'} onclick={() => (tab = 'active')}>Sessions <span class="ssb-count">{activeUnits.length}</span></button>
          <button class="ssb-tab" class:on={tab === 'archived'} onclick={() => (tab = 'archived')}>Archived <span class="ssb-count">{archivedUnits.length}</span></button>
        {/if}
      </div>
      <button class="ssb-icon" class:on={ui.hideOld} aria-label="Hide sessions idle for more than 24h"
              title={ui.hideOld ? 'Showing only the last 24h — click to show everything' : 'Show only sessions active in the last 24h (pinned, awaiting-decision and current sessions always stay)'}
              onclick={() => (ui.hideOld = !ui.hideOld)}><Icon name="clock" size={14} tint={false} /></button>
      <div class="ssb-filter">
        <button class="ssb-icon" class:on={filterCount > 0} aria-label="Filter by tag or repo"
                aria-haspopup="menu" aria-expanded={filterOpen}
                title={filterCount ? `${filterCount} filter${filterCount > 1 ? 's' : ''} on` : 'Filter by tag or repo'}
                onclick={(e) => { filterPos = popoverPosInSidebar(e.currentTarget, 260); filterView = null; filterOpen = !filterOpen; }}>
          <Icon name="filter" size={14} tint={false} />{#if filterCount}<span class="ssb-badge">{filterCount}</span>{/if}
        </button>
        {#if filterOpen}
          <div class="ssb-menu ssb-filter-menu" role="menu" aria-label="Filter" style={placeStyle(filterPos)}>
            {#if !filterView}
              {#each [['repo', 'Repo', repoSummary], ['tag', 'Tags', tagSummary]] as [view, label, summary] (view)}
                <button class="ssb-mi ssb-fsel" role="menuitem" onclick={() => openFilterView(view)}>
                  <span class="ssb-fsel-k">{label}</span>
                  <span class="ssb-fsel-v" class:any={summary === 'Any'}>{summary}</span>
                  <Icon name="chevron-right" size={12} tint={false} />
                </button>
              {/each}
              {#if filterCount}
                <button class="ssb-mi" role="menuitem" onclick={() => { ui.tagFilters = []; ui.repoFilters = []; }}>
                  <span class="ssb-mi-check"><Icon name="close" size={12} tint={false} /></span><span class="ssb-mi-txt"><span>Clear filters</span></span>
                </button>
              {/if}
            {:else}
              <div class="ssb-fhead">
                <button class="ssb-icon" aria-label="Back" onclick={() => (filterView = null)}><Icon name="arrow-left" size={13} /></button>
                <span>{filterView === 'repo' ? 'Repo' : 'Tags'}</span>
                <span class="ssb-mh-hint">{filterView === 'repo' ? 'any of' : 'all of'}</span>
              </div>
              <input class="ssb-fsearch" placeholder={filterView === 'repo' ? 'Search repos…' : 'Search tags…'}
                     bind:value={filterQuery} use:focusOnMount
                     onkeydown={(e) => { if (e.key === 'Enter' && pickerOptions[0]) togglePick(pickerOptions[0][0]); }} />
              <div class="ssb-flist">
                {#each pickerOptions as [k, n] (k)}
                  {@const on = picked().includes(k)}
                  <button class="ssb-mi" class:on role="menuitemcheckbox" aria-checked={on} onclick={() => togglePick(k)}>
                    <span class="ssb-mi-check">{#if on}<Icon name="check" size={12} tint={false} />{/if}</span>
                    <span class="ssb-mi-txt ssb-mi-row">
                      {#if filterView === 'repo'}
                        <span class="ssb-mi-repo" title={k}><span class="ssb-lot" style="--lot:{lotColor(k)}"></span><span class="ssb-ell">{k}</span></span>
                      {:else}
                        <span style="color:{tagColor(k)}">#{k}</span>
                      {/if}
                      <span class="ssb-mi-hint">{n}</span>
                    </span>
                  </button>
                {:else}
                  <div class="ssb-fempty">No match.</div>
                {/each}
              </div>
            {/if}
          </div>
        {/if}
      </div>
      <div class="ssb-sort">
        <button class="ssb-icon" class:on={sortMode !== 'dynamic'} aria-label="View options"
                aria-haspopup="menu" aria-expanded={sortOpen}
                title="{(LAYOUTS.find((l) => l.key === layout) || LAYOUTS[0]).label} · Sort: {(SORT_MODES.find((m) => m.key === sortMode) || SORT_MODES[0]).label}"
                onclick={(e) => { sortPos = popoverPosInSidebar(e.currentTarget, 220); sortOpen = !sortOpen; }}><Icon name="sort" size={14} /></button>
        {#if sortOpen}
          <div class="ssb-menu" role="menu" aria-label="View options" style={placeStyle(sortPos)}>
            <div class="ssb-mh">Group</div>
            {#each LAYOUTS as l (l.key)}
              <button class="ssb-mi" class:on={layout === l.key} role="menuitemradio"
                      aria-checked={layout === l.key} onclick={() => pickLayout(l.key)}>
                <span class="ssb-mi-check">{#if layout === l.key}<Icon name="check" size={12} tint={false} />{/if}</span>
                <span class="ssb-mi-txt"><span>{l.label}</span><span class="ssb-mi-hint">{l.hint}</span></span>
              </button>
            {/each}
            <div class="ssb-mh">Sort</div>
            {#each sortModes as m (m.key)}
              <button class="ssb-mi" class:on={sortMode === m.key} role="menuitemradio"
                      aria-checked={sortMode === m.key} onclick={() => pickSort(m.key)}>
                <span class="ssb-mi-check">{#if sortMode === m.key}<Icon name="check" size={12} tint={false} />{/if}</span>
                <span class="ssb-mi-txt"><span>{m.label}</span><span class="ssb-mi-hint">{m.hint}</span></span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
      <button class="ssb-icon" title="Collapse sidebar (⌘/Ctrl+B)" aria-label="Collapse sidebar"
              onclick={() => (ui.sideMenuOpen = false)}><Icon name="arrow-left" size={14} /></button>
    </div>
    <div class="ssb-list" onscroll={() => (snoozeMenu = null)}>
      {#if byStatus}
        {#each listed as x (x.key)}
          <button class="ssb-group ssb-sec" class:collapsed={sectionCollapsed(x)} onclick={() => toggleSection(x)}>
            <span class="ssb-chev"><Icon name="chevron-right" size={12} /></span><Icon name={x.icon} size={13} /><span class="ssb-gname">{x.label}</span><span class="ssb-gn">{x.units.length}</span>
          </button>
          {@render sectionBody(x)}
        {/each}
        {#if !listed.length}<div class="ssb-empty">No sessions.</div>{/if}
      {:else}
      {#each groups as g (g.key)}
        {#if g.label}
          <!-- a project header is a drop target too: dropping a grouped session on it detaches it -->
          <!-- the + is a sibling of the header button: a link cannot live inside a <button> -->
          <div class="ssb-ghead">
            <button class="ssb-group" class:collapsed={ui.collapsed[g.key]} onclick={() => toggleGroup(g.key)} use:dropDetach>
              <span class="ssb-chev"><Icon name="chevron-right" size={12} /></span><span class="ssb-lot" style="--lot:{lotColor(g.key)}"></span><span class="ssb-gname">{g.label}</span><span class="ssb-gn">{g.items.length}</span>
            </button>
            {#if g.items[0]?.mother.project}
              <a class="ssb-gplus" href={'/new?project=' + encodeURIComponent(g.items[0].mother.project)}
                 title="New session in this project" aria-label="New session in {g.label}"><Icon name="plus" size={13} /></a>
            {/if}
          </div>
        {/if}
        {#if !g.label || !ui.collapsed[g.key]}
          {#each g.items as u (u.key)}{@render unit(u)}{/each}
        {/if}
      {/each}
      <!-- Un SEUL expander, en bas de liste : la fenêtre est globale, donc la coupe l'est aussi. -->
      {#if hiddenCount}
        <button class="ssb-more" onclick={() => (expanded = true)}>
          <Icon name="plus" size={12} /> {hiddenCount} older session{hiddenCount > 1 ? 's' : ''}
        </button>
      {:else if expanded && shown.length > windowSize}
        <button class="ssb-more" onclick={() => (expanded = false)}>
          <Icon name="chevron-down" size={12} /> show less
        </button>
      {/if}
      {#if !shown.length}
        <div class="ssb-empty">{tab === 'archived' ? 'No archived sessions.' : 'No sessions.'}</div>
      {/if}
      {/if}
      {#if dnd.id && isGrouped(dnd.id)}
        <!-- shown only while a grouped session is being dragged: drop here to take it out -->
        <div class="ssb-detach" use:dropDetach><Icon name="unarchive" size={14} /> Drop here to detach from its group</div>
      {/if}
    </div>
    {#if byStatus && docked.length}
      <div class="ssb-dock">
        {#each docked as x (x.key)}
          {@const folded = sectionCollapsed(x)}
          {#if sectionItems(x).length}
            <div class="ssb-dock-list" onscroll={() => (snoozeMenu = null)}>{@render sectionBody(x)}</div>
          {/if}
          <button class="ssb-group ssb-sec ssb-dock-head" aria-expanded={!folded} onclick={() => toggleSection(x)}>
            <Icon name={x.icon} size={13} /><span class="ssb-gname">{x.label}</span><span class="ssb-gn">{x.units.length}</span>
            <Icon name={folded ? 'chevron-up' : 'chevron-down'} size={12} />
          </button>
        {/each}
      </div>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="ssb-resize" onpointerdown={startResize} title="Drag to resize"></div>
    {#if snoozeMenu}
      <div class="ssb-menu ssb-snooze ssb-snooze-menu" role="menu" aria-label="Snooze" style={placeStyle(snoozeMenu)}>
        {#if snoozeUntil(snoozeMenu.id) > nowMs}
          <button class="ssb-mi" role="menuitem" onclick={() => pickSnooze(null)}>
            <span class="ssb-mi-check"><Icon name="bell" size={12} tint={false} /></span>
            <span class="ssb-mi-txt"><span>Wake now</span><span class="ssb-mi-hint">Snoozed until {wakeLabel(snoozeUntil(snoozeMenu.id), nowMs)}</span></span>
          </button>
        {/if}
        {#each snoozeMenu.presets as p (p.label)}
          <button class="ssb-mi" role="menuitem" onclick={() => pickSnooze(p.until)}>
            <span class="ssb-mi-check"></span>
            <span class="ssb-mi-txt ssb-mi-row"><span>{p.label}</span><span class="ssb-mi-hint">{hm(new Date(p.until))}</span></span>
          </button>
        {/each}
      </div>
    {/if}
  </aside>
{:else}
  <!-- collapsed: a thin rail of clickable status tiles (one per group) so you can still switch -->
  <div class="ssb-collapsed">
    <button class="ssb-icon expand" title="Expand session sidebar (⌘/Ctrl+B)" aria-label="Expand sidebar"
            onclick={() => (ui.sideMenuOpen = true)}><Icon name="arrow-right" size={14} /></button>
    <div class="ssb-tiles">
      {#each railUnits as u (u.key)}
        {@const s = u.mother}
        <a class="ssb-tile" class:cur={unitHas(u, (x) => x.id === currentId)} class:dim={!unitHas(u, isActive)}
           href={'/session/' + encodeURIComponent(s.id)} title={u.children.length ? groupName(s.id) : sessionTitle(s)}>
          <span class="ssb-ab">{abbrev(s)}</span>
          <span class="state-dot ssb-dot d-{unitDot(u)}"></span>
        </a>
      {/each}
    </div>
  </div>
{/if}

{#snippet sectionBody(x)}
  {@const folded = sectionCollapsed(x)}
  {@const items = sectionItems(x)}
  {#each items as u (u.key)}{@render unit(u)}{/each}
  {#if !folded && x.window && x.units.length > items.length}
    <button class="ssb-more" onclick={() => (openSections = { ...openSections, [x.key]: true })}>
      <Icon name="plus" size={12} /> {x.units.length - items.length} more
    </button>
  {:else if !folded && openSections[x.key] && x.units.length > x.window}
    <button class="ssb-more" onclick={() => (openSections = { ...openSections, [x.key]: false })}>
      <Icon name="chevron-down" size={12} /> show less
    </button>
  {/if}
{/snippet}

{#snippet unit(u)}
  {@const collapsedU = groupCollapsed(u)}
  {@render row(u.mother, u.children.length ? u : null, collapsedU)}
  {#if u.children.length && !collapsedU}
    {#each u.children as c (c.id)}{@render row(c, null, false, true)}{/each}
  {/if}
{/snippet}

<!-- One session row. `unit` is set on the head of a multi-session group (chevron + member count,
     group name, summarized dot when collapsed); `child` indents a group member. Every row is
     draggable, and a drop target: dropping a session on it joins that row's group. -->
{#snippet row(s, unit, collapsedU, child = false)}
  {@const left = cacheLeft(s)}
  {@const wake = isSnoozed(s) ? snoozeUntil(s.id) : 0}
  <div class="ssb-row" class:cur={s.id === currentId} class:dim={wake || (unit ? !unitHas(unit, isActive) : !isActive(s))}
       class:child class:ghead={!!unit}
       role="button" tabindex="0" onclick={() => open(s)}
       use:dragSession={s.id} use:dropSession={s.id}
       onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}>
    <div class="ssb-line">
      {#if unit}
        <button class="ssb-gchev" class:open={!collapsedU} aria-label={collapsedU ? 'Expand group' : 'Collapse group'}
                onclick={(e) => { e.stopPropagation(); toggleUnit(unit); }}><Icon name="chevron-right" size={11} /></button>
      {/if}
      <span class="state-dot ssb-dot d-{unit && collapsedU ? unitDot(unit) : dotClass(s)}"></span>
      {#if isPinned(s.id)}<span class="ssb-pin-mark" title="Pinned"><Icon name="pin" size={11} /></span>{/if}
      <!-- Marqueur incognito : utile hors du mode (quelles sessions seront visibles) ; dans le
           mode, toutes les sessions listées le sont, l'afficher partout serait du bruit. -->
      {#if !ui.incognito && isIncognito(s.id)}<span class="ssb-pin-mark" title="Incognito"><Icon name="eye-off" size={11} /></span>{/if}
      {#if !groupByProject}<span class="ssb-lot" style="--lot:{lotColor(projectKey(s))}" title={projectKey(s)}></span>{/if}
      <span class="ssb-name" title={unit ? 'Group · mother session: ' + sessionTitle(s) : undefined}>{unit ? groupName(s.id) : sessionTitle(s)}</span>
      {#if unit}<span class="ssb-gcount" title="{unit.all.length} sessions in this group">{unit.all.length}</span>{/if}
      <!-- settings.sidebarCache: the countdown sits in a pill beside the elapsed time, or takes its
           place (the elapsed time then moves to the tooltip). -->
      {#if wake}
        <span class="ssb-wake" title="Snoozed until {new Date(wake).toLocaleString()}"><Icon name="snooze" size={10} />{wakeLabel(wake, nowMs)}</span>
      {:else if left != null}
        <span class="ssb-cache" class:pill={!cacheReplacesAgo} title="Prompt cache warm for {fmtSpan(left)} more — replying before then re-reads the conversation at the cached rate · last activity {ago(s.lastActivity, nowMs)}">
          <Icon name="clock" size={10} />{fmtSpan(left, '')}
        </span>
      {/if}
      {#if !wake && (left == null || !cacheReplacesAgo)}
        <span class="ssb-ago">{agoShort(s.lastActivity, nowMs)}</span>
      {/if}
      <!-- actions au survol : groupe · tag · pin · (split / unarchive) -->
      <span class="ssb-acts">
        <button class="ssb-act" title="Move to group…" aria-label="Move to group"
                onclick={(e) => { e.stopPropagation(); openModal('groupPicker', { mode: 'move', sessionId: s.id }); }}><Icon name="sessions" size={13} /></button>
        <button class="ssb-act" title="Edit tags" aria-label="Edit tags"
                onclick={(e) => { e.stopPropagation(); openModal('editTags', { sessionId: s.id }); }}><Icon name="tag" size={13} /></button>
        <button class="ssb-act" class:on={isPinned(s.id)} title={isPinned(s.id) ? 'Unpin' : 'Pin'} aria-label="Pin"
                onclick={(e) => { e.stopPropagation(); togglePin(s.id); }}><Icon name="pin" size={13} /></button>
        <button class="ssb-act" class:on={isIncognito(s.id)} aria-label="Incognito"
                title={isIncognito(s.id) ? 'Remove from incognito — hidden while incognito mode is on' : 'Mark incognito — keep it visible in incognito mode'}
                onclick={(e) => { e.stopPropagation(); toggleIncognito(s.id); }}><Icon name={isIncognito(s.id) ? 'eye-off' : 'eye'} size={13} /></button>
        {#if isArchived(s.id)}
          <button class="ssb-act" title="Unarchive" onclick={(e) => { e.stopPropagation(); toggleArchive(s.id); }}><Icon name="unarchive" size={13} /></button>
        {:else if byStatus || tab === 'active'}
          <button class="ssb-act ssb-snooze" class:on={!!wake} aria-label="Snooze" aria-haspopup="menu"
                  title={wake ? 'Snoozed until ' + wakeLabel(wake, nowMs) + ' — change or wake' : 'Snooze…'}
                  onclick={(e) => openSnooze(e, s)}><Icon name="snooze" size={13} /></button>
          {#if s.id !== currentId && !isInSplit(s.id) && canSplit()}
            <button class="ssb-act" title="Split beside the current session" onclick={(e) => { e.stopPropagation(); addSplit(s.id); }}><Icon name="pane" size={13} /></button>
          {/if}
          <button class="ssb-act" title="Archive" aria-label="Archive"
                  onclick={(e) => { e.stopPropagation(); toggleArchive(s.id); }}><Icon name="archive" size={13} /></button>
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
{/snippet}

<style>
  .ssb {
    position: relative; background: var(--bg2); border-right: 1px solid var(--border);
    display: flex; flex-direction: column; flex: 0 0 auto;
    /* La largeur est posée par la poignée, pas par la fenêtre : c'est elle que l'en-tête doit
       interroger, d'où un conteneur plutôt qu'une media query. */
    container-type: inline-size;
  }
  /* Les six commandes de l'en-tête réclament ~305px. En dessous, les outils passent sous les
     onglets au lieu de se marcher dessus — aucune n'est retirée, et une sidebar large retrouve
     la ligne unique toute seule. */
  @container (max-width: 312px) {
    .ssb-head { flex-wrap: wrap; row-gap: 2px; }
    .ssb-tabs { flex: 1 0 100%; }
    .ssb-head > .ssb-icon:first-of-type { margin-left: auto; }
  }
  :global(body.focus) .ssb, :global(body.focus) .ssb-collapsed { display: none; }
  .ssb-head { display: flex; align-items: center; gap: 4px; padding: 8px 8px 6px; border-bottom: 1px solid var(--border); }
  .ssb-tabs { display: flex; gap: 2px; flex: 1 1 auto; min-width: 0; overflow: hidden; }
  .ssb-tab {
    background: none; border: none; border-radius: 7px; padding: 4px 8px; cursor: pointer;
    font: inherit; font-size: var(--t-meta); font-weight: 700; color: var(--muted); white-space: nowrap;
    /* Sans ces trois-là, un onglet en nowrap sort de sa boîte rétrécie et passe sous les icônes
       au lieu de céder — c'est la superposition, pas un manque de place. */
    min-width: 0; overflow: hidden; text-overflow: ellipsis;
  }
  .ssb-tab:hover { color: var(--text); }
  .ssb-tab.on { background: var(--accent-soft); color: var(--accent-d); }
  .ssb-count { font-family: var(--mono); font-size: var(--t-micro); opacity: .8; font-weight: 600; }
  .ssb-icon {
    width: 26px; height: 24px; border: none; background: transparent; color: var(--muted); flex: 0 0 auto;
    border-radius: 7px; cursor: pointer; font-size: 12px; display: inline-flex; align-items: center; justify-content: center;
  }
  .ssb-icon:hover { background: var(--hover); color: var(--text); }
  /* état actif d'une bascule d'en-tête (« hide > 24h ») : sans marqueur visible, un filtre actif est
     invisible et on croit avoir perdu des sessions. */
  .ssb-icon.on { background: var(--accent-soft); color: var(--accent-d); }

  /* menu de tri : popover ancré à droite de son icône (la sidebar descend à 180px, il déborde
     donc vers la gauche plutôt que d'être tronqué). */
  .ssb-sort { display: inline-flex; flex: 0 0 auto; }
  .ssb-menu {
    position: absolute; z-index: 40;
    min-width: 220px; padding: 4px; display: flex; flex-direction: column; gap: 2px;
    background: var(--card); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow);
  }
  .ssb-mi {
    display: flex; align-items: flex-start; gap: 6px; width: 100%; padding: 6px 8px;
    border: none; background: transparent; border-radius: 7px; cursor: pointer;
    text-align: left; color: var(--text); font: inherit; font-size: var(--t-meta);
  }
  .ssb-mi:hover { background: var(--hover); }
  .ssb-mi.on { color: var(--accent-d); font-weight: 600; }
  .ssb-mi-check { flex: 0 0 12px; display: inline-flex; justify-content: center; padding-top: 2px; }
  .ssb-mi-txt { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .ssb-mi-hint { color: var(--muted); font-size: var(--t-micro); font-weight: 400; }
  .ssb-mh { padding: 6px 8px 2px; color: var(--muted); font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
  .ssb-snooze-menu { min-width: 170px; }
  .ssb-mi-row { white-space: nowrap; flex: 1; flex-direction: row; justify-content: space-between; align-items: baseline; gap: 12px; }
  .ssb-title { cursor: default; color: var(--text); }
  .ssb-title:hover { color: var(--text); }

  /* « +N older sessions » / « show less » : même bandeau discret que les en-têtes de groupe, pour
     que l'extension de la fenêtre se lise comme une ligne de structure et pas comme une session. */
  .ssb-more {
    /* `grid-column: 1 / -1` : la palette Datadog transforme `.ssb-list` en GRILLE
       (`grid-template-columns: max-content max-content minmax(0,1fr) max-content`, cf. app.css).
       Sans placement, ce bouton se posait tout seul dans la 1re colonne — dimensionnée en
       `max-content` — et son libellé (« + 13 older sessions ») devenait la largeur de cette colonne,
       écrasant celle du titre en `minmax(0,1fr)` : les noms de session tombaient à deux caractères.
       Hors grille (palettes par défaut), la déclaration est simplement inerte. */
    grid-column: 1 / -1;
    display: flex; align-items: center; gap: 6px; width: 100%; background: transparent; border: none;
    border-bottom: 1px solid var(--border);
    color: var(--muted); font: inherit; font-family: var(--mono); font-size: var(--t-micro); font-weight: 600;
    letter-spacing: .06em; padding: 6px 10px 6px 22px; cursor: pointer; text-align: left;
  }
  .ssb-more:hover { background: var(--hover); color: var(--text); }

  /* Side panel sans gap (anti-bulle) : liste affleurante — une ligne = un filet, group headers
     en bandeaux uppercase, session courante = rail accent 2px + fond de surface. */
  .ssb-list { flex: 1 1 auto; overflow-y: auto; padding: 0; }
  .ssb-empty { color: var(--muted); font-size: var(--t-meta); text-align: center; padding: 24px 8px; }
  .ssb-group {
    display: flex; align-items: center; gap: 7px; width: 100%; background: var(--bg2); border: none;
    border-bottom: 1px solid var(--border);
    color: var(--text); font: inherit; font-size: var(--t-meta); font-weight: 750;
    letter-spacing: .01em; padding: 10px 10px 6px; cursor: pointer; text-align: left;
  }
  .ssb-group .ssb-chev { color: var(--muted); }
  .ssb-lot { display: var(--lot-display, block); width: 14px; height: 7px; border-radius: 2px; background: var(--lot); flex: 0 0 auto; }
  .ssb-group:hover { color: var(--text); }
  .ssb-chev { transition: transform .12s; }
  .ssb-group:not(.collapsed) .ssb-chev { transform: rotate(90deg); }
  .ssb-dock { flex: 0 0 auto; display: flex; flex-direction: column; border-top: 1px solid var(--border); }
  .ssb-dock-list { max-height: 35vh; overflow-y: auto; border-bottom: 1px solid var(--border); }
  .ssb-dock-head { position: static; }
  .ssb-dock-head:last-child { border-bottom: none; }
  .ssb-sec { padding: 8px 10px 6px; font-size: var(--t-micro); text-transform: uppercase; letter-spacing: .06em; position: sticky; top: 0; z-index: 2; }
  .ssb-gname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ssb-gn { color: var(--muted); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ssb-ghead { position: relative; }
  /* the count slides left on hover to make room for the + */
  .ssb-ghead:hover .ssb-group, .ssb-ghead:focus-within .ssb-group { padding-right: 34px; }
  .ssb-gplus {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px;
    display: inline-flex; align-items: center; justify-content: center; border-radius: 6px;
    color: var(--muted); text-decoration: none; opacity: 0; transition: opacity .12s, background .12s, color .12s;
  }
  .ssb-ghead:hover .ssb-gplus, .ssb-gplus:focus-visible { opacity: 1; }
  .ssb-gplus:hover { background: var(--accent-soft); color: var(--accent); }
  @media (hover: none) { .ssb-gplus { opacity: 1; } .ssb-group { padding-right: 34px; } }

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
    font: 650 10.5px var(--font); line-height: 1.6; padding: 0 7px; border-radius: 999px;
    color: var(--c); background: color-mix(in srgb, var(--c) 14%, transparent);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .ssb-row:hover { background: var(--hover); }
  /* Current row: a latte wash and a bolder name, no coloured edge (the rail read as one more state). */
  .ssb-row.cur { background: var(--accent-soft); }
  .ssb-row.dim { opacity: .6; }
  .ssb-row.dim:hover { opacity: 1; }
  /* groups: indented children hang off a guide line; drag/drop feedback */
  .ssb-row.child { padding-left: 26px; }
  .ssb-row.child::before { content: ''; position: absolute; left: 14px; top: 0; bottom: 0; border-left: 1px solid var(--border2); }
  .ssb-row:global(.drop-over) { box-shadow: inset 0 0 0 2px var(--accent); background: var(--accent-soft); }
  .ssb-row:global(.dragging) { opacity: .4; }
  .ssb-gchev {
    width: 14px; height: 14px; margin-left: -4px; padding: 0; border: none; background: none; color: var(--muted);
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto; transition: transform .12s;
  }
  .ssb-gchev.open { transform: rotate(90deg); }
  .ssb-gcount { font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); flex: 0 0 auto; }
  .ssb-group:global(.drop-over) { box-shadow: inset 0 0 0 2px var(--accent); }
  .ssb-detach {
    position: sticky; bottom: 0; margin: 8px; padding: 12px 10px; display: flex; align-items: center; justify-content: center; gap: 7px;
    border: 1px dashed var(--border2); border-radius: 10px; background: var(--bg2); color: var(--muted); font-size: var(--t-meta); font-weight: 600;
  }
  .ssb-detach:global(.drop-over) { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-d); }
  .ssb-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-ui); }
  .ssb-row.cur .ssb-name { font-weight: 700; color: var(--accent-d); }
  .ssb-ago { flex: 0 0 auto; font-size: var(--t-micro); color: var(--muted); font-variant-numeric: tabular-nums; }
  .ssb-pin-mark { flex: 0 0 auto; font-size: var(--t-micro); line-height: 1; opacity: .8; }
  /* actions au survol : groupe ancré à droite, masqué au repos, révélé au hover de la ligne */
  /* The icons sit on the row's own colour, faded in from the left: a transparent strip let them
     draw straight over the title. */
  .ssb-acts {
    position: absolute; right: 0; top: 50%; transform: translateY(-50%); display: none; gap: 2px; padding-left: 22px;
    background: linear-gradient(to right, transparent, var(--acts-bg, var(--hover)) 20px);
  }
  .ssb-row.cur .ssb-acts { --acts-bg: var(--accent-soft); }
  .ssb-row:hover .ssb-acts { display: inline-flex; }
  .ssb-cache { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 2px; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); }
  /* Beside the elapsed time: a pill, so the countdown never reads as one more "time ago". */
  .ssb-cache.pill { padding: 0 5px; border: 1px solid rgba(var(--warn-rgb), .45); border-radius: 999px; color: var(--text); font-variant-numeric: tabular-nums; }
  .ssb-wake { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px; font-family: var(--mono); font-size: var(--t-micro); color: var(--info); font-variant-numeric: tabular-nums; }
  .ssb-row .ssb-lot { width: 3px; height: 12px; border-radius: 2px; }
  .ssb-row:hover .ssb-ago, .ssb-row:hover .ssb-cache, .ssb-row:hover .ssb-wake, .ssb-row:hover .ssb-gcount { visibility: hidden; }
  .ssb-act {
    width: 22px; height: 22px; border: none;
    background: transparent; color: var(--muted); border-radius: 6px; cursor: pointer; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .ssb-act:hover { background: var(--accent-soft); color: var(--accent-d); }
  .ssb-act.on { color: var(--accent-d); }

  .ssb-filter { display: inline-flex; flex: 0 0 auto; }
  .ssb-filter .ssb-icon { position: relative; }
  .ssb-badge {
    position: absolute; top: 0; right: 0; min-width: 12px; height: 12px; padding: 0 3px; border-radius: 6px;
    background: var(--accent); color: var(--bg); font: 700 9px/12px var(--mono);
  }
  .ssb-filter-menu { min-width: 0; width: min(260px, calc(100cqw - 8px)); }
  .ssb-fsel { align-items: center; gap: 8px; }
  .ssb-fsel-k { flex: 0 0 auto; font-weight: 600; }
  .ssb-fsel-v { flex: 1; min-width: 0; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--accent-d); }
  .ssb-fsel-v.any { color: var(--muted); }
  .ssb-fhead { display: flex; align-items: center; gap: 4px; padding: 2px 4px 4px 0; font-size: var(--t-meta); font-weight: 600; }
  .ssb-fsearch {
    margin: 0 4px 4px; padding: 5px 8px; border: 1px solid var(--border); border-radius: 7px;
    background: var(--bg2); color: var(--text); font: inherit; font-size: var(--t-meta); outline: none;
  }
  .ssb-fsearch:focus { border-color: var(--accent); }
  .ssb-flist { max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .ssb-fempty { padding: 8px; color: var(--muted); font-size: var(--t-meta); }
  .ssb-filter-menu .ssb-mi-txt { min-width: 0; }
  .ssb-filter-menu .ssb-mi-row > :first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .ssb-mh-hint { font-weight: 400; text-transform: none; letter-spacing: 0; }
  .ssb-ell { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ssb-mi-repo { display: flex; align-items: center; gap: 6px; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

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
  .ssb-ab { font-family: var(--mono); font-size: var(--t-micro); font-weight: 700; color: var(--muted); }
  .ssb-tile.cur .ssb-ab { color: var(--accent-d); }
  .ssb-tile .ssb-dot { position: absolute; top: -3px; right: -3px; width: 9px; height: 9px; border: 2px solid var(--bg2); }

  /* La liste ne s'efface que lorsqu'une session la recouvre : sinon elle EST l'écran. */
  @media (max-width: 900px) {
    :global(.layout.has-detail) .ssb, :global(.layout.has-detail) .ssb-collapsed { display: none; }
    /* `!important` parce que la largeur est posée en style inline : c'est une préférence de
       poignée de redimensionnement, qui n'a pas de sens quand la liste occupe tout l'écran. */
    .ssb { flex: 1 1 auto; width: 100% !important; min-width: 0 !important; border-right: none; }
  }
</style>
