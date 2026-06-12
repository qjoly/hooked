<script>
  import { ui, data, openModal } from '../lib/state.svelte.js';
  import { STATUS_FILTERS, filterMatches, LIVE_STATES, ago, shortModel } from '../lib/format.js';

  const sf = $derived(STATUS_FILTERS.find((f) => f.key === ui.statusFilter) || STATUS_FILTERS[0]);

  function count(f) {
    return f.states === null ? data.sessions.length : data.sessions.filter((s) => filterMatches(f, s.state)).length;
  }

  // liste filtrée (statut + masquer > 24h + recherche)
  const filtered = $derived.by(() => {
    const q = ui.search.toLowerCase().trim();
    const now = Date.now();
    return data.sessions.filter((s) => {
      if (!filterMatches(sf, s.state)) return false;
      if (ui.hideOld && s.lastActivity && (now - Date.parse(s.lastActivity)) > 86400000) return false;
      if (q) {
        const hay = `${s.projectName} ${s.title} ${s.lastPrompt} ${s.gitBranch}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  // regroupe par projet, trié par activité la plus récente
  const groups = $derived.by(() => {
    const g = {};
    for (const s of filtered) (g[s.projectName || '?'] = g[s.projectName || '?'] || []).push(s);
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
      <button class="ov-btn" onclick={() => (ui.currentSessionId = null)}>🏠 Vue d'ensemble</button>
      <button class="new-btn" onclick={() => openModal('launch')}>＋ Nouvelle session</button>
    </div>
    <input id="search" type="search" placeholder="Rechercher…" bind:value={ui.search} />
    <div class="status-filter">
      {#each STATUS_FILTERS as f}
        <button class="sf-chip" class:active={ui.statusFilter === f.key} onclick={() => (ui.statusFilter = f.key)}>
          {f.label}<span class="sf-n">{count(f)}</span>
        </button>
      {/each}
    </div>
    <label class="chk"><input type="checkbox" bind:checked={ui.hideOld} /> masquer &gt; 24h</label>
  </div>

  <div class="side-list">
    {#if !groups.length}
      <div class="empty">Aucune session.</div>
    {:else}
      {#each groups as g (g.proj)}
        <div class="pgroup" class:collapsed={ui.collapsed[g.proj]}>
          <div class="phead" onclick={() => toggle(g.proj)}>
            <span class="parrow">▾</span>
            <span class="pname">{g.proj}</span>
            {#if projFlag(g.items)}<span class="pflag {projFlag(g.items)}"></span>{/if}
            <span class="pcount">{g.items.length}</span>
          </div>
          <div class="plist">
            {#each g.items as s (s.id)}
              <div class="srow s-{s.state}" class:has-q={s.hasQuestion} class:active={ui.currentSessionId === s.id}
                   onclick={() => (ui.currentSessionId = s.id)}>
                <span class="sdot"></span>
                <div class="srow-main">
                  <div class="srow-title">
                    {#if s.hasQuestion}<span class="q-flag" title="Claude attend ta réponse">⌨</span>{/if}{s.title}
                  </div>
                  <div class="srow-sub">{#if s.gitBranch}{s.gitBranch} · {/if}{ago(s.lastActivity)}</div>
                  {#if LIVE_STATES.includes(s.state) && (s.model || s.effort)}
                    <div class="srow-meta">
                      {#if s.model}<span class="mtag">{shortModel(s.model)}</span>{/if}
                      {#if s.effort}<span class="mtag eff">{s.effort}</span>{/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</aside>
