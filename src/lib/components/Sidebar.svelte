<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ui, data, loadSessions, togglePin, sessionTitle, openModal, sessionTags, setSessionTags, allTags } from '$lib/state.svelte.js';
  import { reply, deleteSession } from '$lib/api.js';
  import { STATUS_FILTERS, filterMatches, filterMatchesAny, ago } from '$lib/format.js';

  // Réponse en 1 clic : on n'affiche les options inline que pour une question unique à choix
  // simple (le cas des « permissions »). Multi-select / questions multiples → on ouvre la session.
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
  async function delSession(s) {
    if (deletingId) return;
    if (!confirm(`Move to trash: "${sessionTitle(s)}"?\nThe transcript is moved to bin/ (recoverable), the session leaves the dashboard.`)) return;
    deletingId = s.id;
    const res = await deleteSession(s.id).catch(() => ({ ok: false }));
    deletingId = null;
    if (res.ok) { loadSessions(); ui.tick++; }
    else alert('✗ delete failed');
  }

  // Sélection de filtre : clic simple = remplace ; Ctrl/⌘+clic = ajoute/retire (multi-sélection).
  function selectFilter(key, e) {
    if (e.ctrlKey || e.metaKey) {
      const next = ui.statusFilters.includes(key)
        ? ui.statusFilters.filter((k) => k !== key)
        : [...ui.statusFilters, key];
      ui.statusFilters = next.length ? next : ['all'];
    } else {
      ui.statusFilters = [key];
    }
  }

  function count(f) {
    return f.states === null ? data.sessions.length : data.sessions.filter((s) => filterMatches(f, s.state)).length;
  }

  // couleur stable dérivée du texte : hash → teinte. Même texte ⇒ même couleur.
  function tagHue(t) {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    return h % 360;
  }

  const tagList = $derived(allTags());
  // filtre de tag : clic simple = remplace ; Ctrl/⌘+clic = ajoute/retire (multi-sélection, ET logique).
  function selectTag(tag, e) {
    if (e.ctrlKey || e.metaKey) {
      ui.tagFilters = ui.tagFilters.includes(tag) ? ui.tagFilters.filter((t) => t !== tag) : [...ui.tagFilters, tag];
    } else {
      ui.tagFilters = ui.tagFilters.length === 1 && ui.tagFilters[0] === tag ? [] : [tag];
    }
  }
  // édition des tags d'une session (comma-separated). Repli le plus simple qui marche.
  function editTags(s, e) {
    e.stopPropagation();
    const next = prompt(`Tags for "${sessionTitle(s)}" (comma-separated):`, sessionTags(s.id).join(', '));
    if (next != null) setSessionTags(s.id, next.split(','));
  }

  // liste filtrée (statut + tags + masquer > 24h + recherche). La recherche matche aussi les tags.
  const filtered = $derived.by(() => {
    const q = ui.search.toLowerCase().trim();
    const now = Date.now();
    return data.sessions.filter((s) => {
      if (!filterMatchesAny(ui.statusFilters, s.state)) return false;
      const tags = sessionTags(s.id);
      if (ui.tagFilters.length && !ui.tagFilters.every((t) => tags.includes(t))) return false;
      if (ui.hideOld && s.lastActivity && (now - Date.parse(s.lastActivity)) > 86400000) return false;
      if (q) {
        const hay = `${s.repo} ${s.projectName} ${s.title} ${s.lastPrompt} ${s.gitBranch} ${tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  const pinnedSet = $derived(new Set(ui.pinned));

  // sessions épinglées (toutes projets confondus), remontées en tête de sidebar
  const pinnedItems = $derived(
    filtered
      .filter((s) => pinnedSet.has(s.id))
      .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))),
  );

  // regroupe par dépôt GitHub (owner/repo), à défaut par nom de dossier (hors dépôt git),
  // hors épinglées, trié par activité la plus récente
  const groups = $derived.by(() => {
    const g = {};
    for (const s of filtered) {
      if (pinnedSet.has(s.id)) continue;
      const key = s.repo || s.projectName || '?';
      (g[key] = g[key] || []).push(s);
    }
    const lastOf = (arr) => Math.max(...arr.map((s) => Date.parse(s.lastActivity || 0) || 0));
    const order = Object.keys(g).sort((a, b) => lastOf(g[b]) - lastOf(g[a]));
    return order.map((proj) => ({
      proj,
      items: g[proj].slice().sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''))),
    }));
  });

  function projFlag(items) {
    if (items.some((s) => s.state === 'attention')) return 'a';
    if (items.some((s) => s.state === 'waiting' || s.state === 'working')) return 'w';
    return '';
  }
  function toggle(proj) {
    ui.collapsed = { ...ui.collapsed, [proj]: !ui.collapsed[proj] };
  }
</script>

<aside class="sidebar">
  <div class="side-head">
    <div class="side-actions">
      <button class="ov-btn" onclick={() => goto('/')}>🏠 Overview</button>
      <button class="new-btn" onclick={() => goto('/new')}>＋ New session</button>
    </div>
    <input id="search" type="search" placeholder="Search…" bind:value={ui.search} />
    <div class="status-filter">
      {#each STATUS_FILTERS.filter((f) => f.key === 'all' || count(f) > 0 || ui.statusFilters.includes(f.key)) as f}
        <button class="sf-chip" class:active={ui.statusFilters.includes(f.key)} title="Ctrl/⌘+click to combine filters" onclick={(e) => selectFilter(f.key, e)}>
          {f.label}<span class="sf-n">{count(f)}</span>
        </button>
      {/each}
    </div>
    {#if tagList.length}
      <div class="tag-filter">
        {#each tagList as t}
          <button class="tf-chip" class:active={ui.tagFilters.includes(t)} style="--h:{tagHue(t)}" title="Ctrl/⌘+click to combine tags" onclick={(e) => selectTag(t, e)}>🏷 {t}</button>
        {/each}
        {#if ui.tagFilters.length}<button class="tf-chip tf-clear" onclick={() => (ui.tagFilters = [])}>✕ clear</button>{/if}
      </div>
    {/if}
    <label class="chk"><input type="checkbox" bind:checked={ui.hideOld} /> hide &gt; 24h</label>
  </div>

  <div class="side-list">
    {#if !groups.length && !pinnedItems.length}
      <div class="empty">No sessions.</div>
    {:else}
      {#if pinnedItems.length}
        <div class="pgroup">
          <div class="phead phead-pin">
            <span class="pname">📌 Pinned</span>
            <span class="pcount">{pinnedItems.length}</span>
          </div>
          <div class="plist">
            {#each pinnedItems as s (s.id)}{@render srow(s)}{/each}
          </div>
        </div>
      {/if}
      {#each groups as g (g.proj)}
        <div class="pgroup" class:collapsed={ui.collapsed[g.proj]}>
          <div class="phead" onclick={() => toggle(g.proj)}>
            <span class="parrow">▾</span>
            <span class="pname">{g.proj}</span>
            {#if projFlag(g.items)}<span class="pflag {projFlag(g.items)}"></span>{/if}
            <span class="pcount">{g.items.length}</span>
            <button class="pnew" title="New session in this project"
                    onclick={(e) => { e.stopPropagation(); goto('/new?project=' + encodeURIComponent(g.items[0].project)); }}>＋</button>
          </div>
          <div class="plist">
            {#each g.items as s (s.id)}{@render srow(s)}{/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>

  <div class="side-foot">
    <button class="ov-btn trash-btn" onclick={() => openModal('trash')}
            title="View trash (deleted sessions, recoverable)">🗑 Trash</button>
  </div>
</aside>

{#snippet srow(s)}
  <div class="srow s-{s.state}" class:has-q={s.hasQuestion || s.hasPlan} class:active={page.params.id === s.id}
       onclick={() => goto('/session/' + encodeURIComponent(s.id))}>
    <span class="sdot"></span>
    <div class="srow-main">
      <div class="srow-title">
        {#if s.hasQuestion}<span class="q-flag" title="Claude is awaiting your reply">⌨</span>{/if}{#if s.hasPlan}<span class="q-flag" title="Plan awaiting approval">📋</span>{/if}{sessionTitle(s)}
      </div>
      <div class="srow-sub">{#if s.gitBranch}{s.gitBranch} · {/if}{ago(s.lastActivity)}</div>
      {#if s.state === 'working' && s.activity}
        <div class="srow-activity" title="Claude is working">✻ {s.activity}…</div>
      {/if}
      {#if sessionTags(s.id).length}
        <div class="srow-tags">{#each sessionTags(s.id) as t}<span class="stag" style="--h:{tagHue(t)}">{t}<button class="stag-x" title="Remove tag" onclick={(e) => { e.stopPropagation(); setSessionTags(s.id, sessionTags(s.id).filter((x) => x !== t)); }}>✕</button></span>{/each}</div>
      {/if}
      {#if s.todo && s.todo.current}
        <div class="srow-todo" title="Current task (TodoWrite)">▶ {s.todo.current}<span class="todo-frac">{s.todo.done}/{s.todo.total}</span></div>
      {/if}
      {#if sentId === s.id}
        <div class="q-quick-sent">✓ reply sent</div>
      {:else if s.hasQuestion && quickOpts(s.question)}
        <div class="q-quick">
          {#each quickOpts(s.question) as o}
            <button class="q-quick-opt" disabled={sendingId === s.id} title={o.description || o.label}
                    onclick={(e) => { e.stopPropagation(); quickReply(s, o.label); }}>{o.label}</button>
          {/each}
        </div>
      {/if}
    </div>
    <button class="pin-btn tag-btn" class:tagged={sessionTags(s.id).length} title="Edit tags" onclick={(e) => editTags(s, e)}>🏷</button>
    <button class="pin-btn" class:pinned={pinnedSet.has(s.id)}
            title={pinnedSet.has(s.id) ? 'Unpin' : 'Pin'}
            onclick={(e) => { e.stopPropagation(); togglePin(s.id); }}>📌</button>
    <button class="pin-btn del-row" title="Move to trash (transcript kept in bin/)"
            disabled={deletingId === s.id}
            onclick={(e) => { e.stopPropagation(); delSession(s); }}>🗑</button>
  </div>
{/snippet}

<style>
  /* le 🏷 grisé/transparent de .pin-btn est illisible → on le dégrise et on le rend plus présent */
  .tag-btn { filter: none; }
  .tag-btn.tagged { opacity: 1; }
  .tag-filter { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px 0; }
  .tf-chip {
    background: hsl(var(--h) 60% 50% / 0.14); color: hsl(var(--h) 55% 45%);
    border: 1px solid hsl(var(--h) 55% 50% / 0.4);
    border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600; cursor: pointer;
  }
  .tf-chip:hover { filter: brightness(1.1); }
  .tf-chip.active { background: hsl(var(--h) 60% 45%); color: #fff; border-color: transparent; }
  .tf-clear { --h: 0; opacity: 0.7; }
  .srow-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
  .stag {
    display: inline-flex; align-items: center; gap: 3px;
    background: hsl(var(--h) 60% 50% / 0.14); color: hsl(var(--h) 55% 45%);
    border: 1px solid hsl(var(--h) 55% 50% / 0.4);
    border-radius: 999px; padding: 0 6px; font-size: 10px; font-weight: 600; line-height: 15px;
  }
  .stag-x {
    background: none; border: none; color: inherit; cursor: pointer; padding: 0;
    font-size: 9px; line-height: 1; opacity: 0.55;
  }
  .stag-x:hover { opacity: 1; }
  /* fond sombre → texte plus clair pour rester lisible (thème forcé sombre, ou système en sombre) */
  :global([data-theme='dark']) .tf-chip:not(.active),
  :global([data-theme='dark']) .stag { color: hsl(var(--h) 65% 72%); }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme])) .tf-chip:not(.active),
    :global(:root:not([data-theme])) .stag { color: hsl(var(--h) 65% 72%); }
  }

  .side-foot { margin-top: auto; padding: 8px 10px 12px; }
  /* action secondaire : bouton discret, pas un gros CTA plein */
  .side-foot .trash-btn {
    width: 100%; background: transparent; color: var(--muted);
    border: 1px solid var(--border); border-radius: 10px;
    padding: 8px 12px; font-size: 13px; font-weight: 600; box-shadow: none;
  }
  .side-foot .trash-btn:hover { background: var(--bg3); color: var(--text); }
</style>
