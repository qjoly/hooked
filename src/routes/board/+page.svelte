<script>
  import { goto } from '$app/navigation';
  import { data, sessionTitle, sessionTags, allTags } from '$lib/state.svelte.js';
  import { ago, tagColor } from '$lib/format.js';

  // Filtres locaux au board (n'interfèrent pas avec ceux de l'inbox).
  let project = $state('');
  let tags = $state([]);
  let q = $state('');

  const projKey = (s) => s.repo || s.projectName || '?';
  const needsReply = (s) => s.hasQuestion || s.hasPlan || s.state === 'waiting' || s.state === 'attention';
  const isWorking = (s) => s.state === 'working' || s.state === 'background';

  // liste de projets (clé repo/dossier) présents, triés.
  const projects = $derived([...new Set(data.sessions.map(projKey))].sort((a, b) => a.localeCompare(b)));
  const tagList = $derived(allTags());

  function toggleTag(t) { tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]; }

  const filtered = $derived.by(() => {
    const query = q.toLowerCase().trim();
    return data.sessions.filter((s) => {
      if (project && projKey(s) !== project) return false;
      const st = sessionTags(s.id);
      if (tags.length && !tags.every((t) => st.includes(t))) return false;
      if (query) {
        const hay = `${s.repo} ${s.projectName} ${s.title} ${s.lastPrompt} ${s.gitBranch} ${st.join(' ')}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  });

  // colonne d'une session (exhaustif) : à traiter / en cours / au repos / terminé.
  function colOf(s) {
    if (needsReply(s)) return 'needs';
    if (isWorking(s)) return 'working';
    if (s.state === 'ended' || s.state === 'past') return 'ended';
    return 'idle';
  }
  const COLUMNS = [
    { key: 'needs', label: 'Needs your reply', tone: 'warn' },
    { key: 'working', label: 'Working', tone: 'info' },
    { key: 'idle', label: 'Idle', tone: 'muted' },
    { key: 'ended', label: 'Ended', tone: 'success' },
  ];
  const byActivity = (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  const columns = $derived.by(() => {
    const g = { needs: [], working: [], idle: [], ended: [] };
    for (const s of filtered) g[colOf(s)].push(s);
    for (const k of Object.keys(g)) g[k].sort(byActivity);
    return COLUMNS.map((c) => ({ ...c, items: g[c.key] }));
  });

  const dotClass = (s) => (needsReply(s) ? 'warn' : isWorking(s) ? 'info' : (s.state === 'ended' || s.state === 'past') ? 'success' : 'muted');
</script>

<section class="view active">
  <div class="board">
    <div class="board-head">
      <div class="board-title">
        <h1>Board</h1>
        <p class="board-sub">All sessions by status — {filtered.length} shown{project || tags.length || q ? ' (filtered)' : ''}.</p>
      </div>
      <div class="board-filters">
        <div class="bf-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" placeholder="Search…" bind:value={q} />
        </div>
        <select class="bf-proj" bind:value={project} title="Filter by project">
          <option value="">All projects</option>
          {#each projects as p (p)}<option value={p}>{p}</option>{/each}
        </select>
      </div>
    </div>

    {#if tagList.length}
      <div class="board-tags">
        {#each tagList as t (t)}
          {@const on = tags.includes(t)}
          <button class="bt" class:on style="--c:{tagColor(t)}" onclick={() => toggleTag(t)}># {t}</button>
        {/each}
        {#if tags.length}<button class="bt bt-clear" onclick={() => (tags = [])}>✕ clear</button>{/if}
      </div>
    {/if}

    <div class="cols">
      {#each columns as col (col.key)}
        <div class="col">
          <div class="col-head col-{col.tone}">
            <span class="col-dot"></span>{col.label}<span class="col-n">{col.items.length}</span>
          </div>
          <div class="col-body">
            {#each col.items as s (s.id)}
              <button class="bcard" onclick={() => goto('/session/' + encodeURIComponent(s.id))}>
                <div class="bc-top">
                  <span class="bc-dot bc-dot-{dotClass(s)}"></span>
                  <span class="bc-title">{sessionTitle(s)}</span>
                </div>
                <div class="bc-sub">{projKey(s)}{#if s.gitBranch} · {s.gitBranch}{/if}</div>
                {#if s.state === 'working' && s.activity}
                  <div class="bc-snip bc-working">✦ {s.activity}…</div>
                {:else if s.lastPrompt}
                  <div class="bc-snip">{s.lastPrompt}</div>
                {/if}
                {#if sessionTags(s.id).length}
                  <div class="bc-pills">{#each sessionTags(s.id) as t}<span class="bc-pill" style="--c:{tagColor(t)}"># {t}</span>{/each}</div>
                {/if}
                <div class="bc-time">{ago(s.lastActivity)}</div>
              </button>
            {/each}
            {#if !col.items.length}<div class="col-empty">—</div>{/if}
          </div>
        </div>
      {/each}
    </div>
  </div>
</section>

<style>
  .board { height: 100%; display: flex; flex-direction: column; padding: 22px 24px 0; min-height: 0; }
  .board-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .board-title h1 { font-size: 24px; font-weight: 800; letter-spacing: -.01em; margin: 0; }
  .board-sub { color: var(--muted); font-size: 13px; margin: 3px 0 0; }
  .board-filters { display: flex; gap: 8px; align-items: center; }
  .bf-search { position: relative; display: flex; align-items: center; }
  .bf-search svg { position: absolute; left: 11px; color: var(--muted); pointer-events: none; }
  .bf-search input { background: var(--input); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px 8px 34px; font: inherit; font-size: 13px; color: var(--text); width: 200px; }
  .bf-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .bf-proj { background: var(--input); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px; font: inherit; font-size: 13px; color: var(--text); }
  .bf-proj:focus { outline: none; border-color: var(--accent); }

  .board-tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
  .bt { display: inline-flex; align-items: center; gap: 4px; background: color-mix(in srgb, var(--c) 13%, transparent); color: var(--c); border: none; border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-family: var(--mono); font-size: 10.5px; font-weight: 600; }
  .bt.on { background: var(--c); color: #fff; }
  .bt-clear { --c: var(--muted); opacity: .8; }

  .cols { flex: 1; min-height: 0; display: flex; gap: 14px; margin-top: 16px; padding-bottom: 4px; overflow-x: auto; }
  .col { flex: 1 1 0; min-width: 250px; display: flex; flex-direction: column; min-height: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; }
  .col-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; font-family: var(--mono); border-bottom: 1px solid var(--border); }
  .col-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .col-n { margin-left: auto; background: var(--chip); color: var(--muted); border-radius: 20px; padding: 1px 8px; font-size: 11px; }
  .col-warn { color: var(--warn); } .col-info { color: var(--info); } .col-success { color: var(--success); } .col-muted { color: var(--muted); }
  .col-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .col-empty { color: var(--muted); text-align: center; padding: 12px; font-size: 13px; opacity: .5; }

  .bcard { text-align: left; width: 100%; background: var(--card); border: 1px solid var(--border); border-radius: 11px; padding: 11px 12px; cursor: pointer; font: inherit; transition: border-color .12s, box-shadow .12s, transform .05s; }
  .bcard:hover { border-color: var(--accent); box-shadow: var(--shadow-sm); }
  .bcard:active { transform: translateY(1px); }
  .bc-top { display: flex; align-items: flex-start; gap: 8px; }
  .bc-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex: 0 0 auto; }
  .bc-dot-info { background: var(--info); } .bc-dot-warn { background: var(--warn); } .bc-dot-success { background: var(--success); } .bc-dot-muted { background: var(--muted); }
  .bc-title { font-size: 13px; font-weight: 600; color: var(--text); line-height: 1.35; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .bc-sub { font-family: var(--mono); font-size: 10.5px; color: var(--muted); margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bc-snip { font-size: 11.5px; color: var(--muted); margin-top: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bc-working { color: var(--info); font-style: italic; }
  .bc-pills { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
  .bc-pill { font-family: var(--mono); font-size: 10px; font-weight: 600; line-height: 1.6; color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent); border-radius: 6px; padding: 0 6px; }
  .bc-time { font-family: var(--mono); font-size: 10px; color: var(--muted); margin-top: 7px; }

  @media (max-width: 700px) {
    .board { padding: 16px 14px 0; }
    .board-filters { width: 100%; }
    .bf-search input { width: 100%; }
  }
</style>
