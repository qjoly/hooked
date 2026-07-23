<script>
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { data, sessionTitle, sessionTags, allTags } from '$lib/state.svelte.js';
  import { ago, tagColor } from '$lib/format.js';

  // Filtres locaux au board (n'interfèrent pas avec ceux de l'inbox).
  let q = $state('');
  let project = $state('');   // '' = tous
  let tags = $state([]);      // tags sélectionnés (ET logique)

  // dropdowns recherchables (projet = mono-sélection, tags = multi)
  let projOpen = $state(false);
  let projQuery = $state('');
  let tagOpen = $state(false);
  let tagQuery = $state('');

  const projKey = (s) => s.repo || s.projectName || '?';
  const needsReply = (s) => s.hasQuestion || s.hasPlan || s.state === 'waiting' || s.state === 'attention';
  const isWorking = (s) => s.state === 'working' || s.state === 'background';

  const projects = $derived([...new Set(data.sessions.map(projKey))].sort((a, b) => a.localeCompare(b)));
  const tagList = $derived(allTags());
  const projOptions = $derived(projects.filter((p) => p.toLowerCase().includes(projQuery.toLowerCase())));
  const tagOptions = $derived(tagList.filter((t) => t.toLowerCase().includes(tagQuery.toLowerCase())));

  function pickProject(p) { project = p; projOpen = false; projQuery = ''; }
  function toggleTag(t) { tags = tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t]; }

  // fermer les dropdowns au clic extérieur (les boutons/popovers stoppent la propagation).
  onMount(() => {
    const h = (e) => { if (!e.target.closest || !e.target.closest('.bf-menu')) { projOpen = false; tagOpen = false; } };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  });

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

  // colonne d'une session : à traiter / en cours / terminé (les sessions au repos rejoignent
  // « Ended » — plus de colonne « Idle » dédiée).
  function colOf(s) {
    if (needsReply(s)) return 'needs';
    if (isWorking(s)) return 'working';
    return 'ended';
  }
  const COLUMNS = [
    { key: 'needs', label: 'Needs your reply', tone: 'warn' },
    { key: 'working', label: 'Working', tone: 'info' },
    { key: 'ended', label: 'Ended', tone: 'muted' },
  ];
  const byActivity = (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  const columns = $derived.by(() => {
    const g = { needs: [], working: [], ended: [] };
    for (const s of filtered) g[colOf(s)].push(s);
    for (const k of Object.keys(g)) g[k].sort(byActivity);
    return COLUMNS.map((c) => ({ ...c, items: g[c.key] }));
  });

  const dotClass = (s) => (needsReply(s) ? 'warn' : isWorking(s) ? 'info' : (s.state === 'ended' || s.state === 'past') ? 'success' : 'muted');
  const activeCount = $derived((project ? 1 : 0) + tags.length + (q ? 1 : 0));
</script>

<section class="view active">
  <div class="board">
    <div class="board-head">
      <div class="board-title">
        <h1>Board</h1>
        <p class="board-sub">All sessions by status — {filtered.length} shown{activeCount ? ' (filtered)' : ''}.</p>
      </div>
      <div class="board-filters">
        <div class="bf-search">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          <input type="search" placeholder="Search…" bind:value={q} />
        </div>

        <!-- Projet : dropdown recherchable (mono-sélection) -->
        <div class="bf-menu">
          <button class="bf-trigger" class:on={!!project} onclick={(e) => { e.stopPropagation(); tagOpen = false; projOpen = !projOpen; }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
            <span class="bf-trigger-lbl">{project || 'All projects'}</span>
            <svg class="bf-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          {#if projOpen}
            <div class="bf-pop" onclick={(e) => e.stopPropagation()}>
              <!-- svelte-ignore a11y_autofocus -->
              <input class="bf-popsearch" placeholder="Search projects…" autofocus bind:value={projQuery} />
              <div class="bf-poplist">
                <button class="bf-opt" class:sel={!project} onclick={() => pickProject('')}>All projects</button>
                {#each projOptions as p (p)}
                  <button class="bf-opt" class:sel={project === p} onclick={() => pickProject(p)}>
                    <span class="bf-opt-name">{p}</span>
                    {#if project === p}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                  </button>
                {/each}
                {#if !projOptions.length}<div class="bf-empty">No match</div>{/if}
              </div>
            </div>
          {/if}
        </div>

        <!-- Tags : dropdown recherchable (multi-sélection, ET) -->
        <div class="bf-menu">
          <button class="bf-trigger" class:on={tags.length > 0} onclick={(e) => { e.stopPropagation(); projOpen = false; tagOpen = !tagOpen; }}>
            <span class="bf-hash">#</span>
            <span class="bf-trigger-lbl">{tags.length ? `${tags.length} tag${tags.length > 1 ? 's' : ''}` : 'All tags'}</span>
            <svg class="bf-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
          </button>
          {#if tagOpen}
            <div class="bf-pop" onclick={(e) => e.stopPropagation()}>
              <!-- svelte-ignore a11y_autofocus -->
              <input class="bf-popsearch" placeholder="Search tags…" autofocus bind:value={tagQuery} />
              <div class="bf-poplist">
                {#if tags.length}<button class="bf-opt bf-clear" onclick={() => (tags = [])}>Clear selection</button>{/if}
                {#each tagOptions as t (t)}
                  {@const on = tags.includes(t)}
                  <button class="bf-opt" class:sel={on} onclick={() => toggleTag(t)}>
                    <span class="bf-sw" style="background:{tagColor(t)}"></span>
                    <span class="bf-opt-name">{t}</span>
                    {#if on}<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                  </button>
                {/each}
                {#if !tagList.length}<div class="bf-empty">No tags yet</div>{:else if !tagOptions.length}<div class="bf-empty">No match</div>{/if}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </div>

    {#if tags.length}
      <div class="bf-active">
        {#each tags as t (t)}
          <button class="bf-chip" style="--c:{tagColor(t)}" onclick={() => toggleTag(t)}># {t} <span class="bf-chip-x">✕</span></button>
        {/each}
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
  .board-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .bf-search { position: relative; display: flex; align-items: center; }
  .bf-search svg { position: absolute; left: 11px; color: var(--muted); pointer-events: none; }
  .bf-search input { background: var(--input); border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px 8px 34px; font: inherit; font-size: 13px; color: var(--text); width: 190px; }
  .bf-search input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  /* dropdowns recherchables (projet / tags) — cohérents avec le reste du design */
  .bf-menu { position: relative; }
  .bf-trigger {
    display: inline-flex; align-items: center; gap: 7px; max-width: 220px;
    background: var(--input); border: 1px solid var(--border); border-radius: 9px;
    padding: 8px 11px; font: inherit; font-size: 13px; font-weight: 600; color: var(--text); cursor: pointer;
    transition: border-color .12s, background .12s;
  }
  .bf-trigger:hover { border-color: var(--border2); }
  .bf-trigger.on { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .bf-trigger > svg, .bf-hash { flex: 0 0 auto; color: var(--muted); }
  .bf-trigger.on > svg, .bf-trigger.on .bf-hash { color: var(--accent); }
  .bf-hash { font-family: var(--mono); font-weight: 700; font-size: 13px; }
  .bf-trigger-lbl { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bf-caret { opacity: .6; }
  .bf-pop {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 260px;
    background: var(--bg2); border: 1px solid var(--border2); border-radius: 12px; padding: 8px;
    box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 6px;
  }
  .bf-popsearch {
    width: 100%; box-sizing: border-box; background: var(--input); border: 1px solid var(--border);
    border-radius: 8px; padding: 7px 10px; font: inherit; font-size: 13px; color: var(--text);
  }
  .bf-popsearch:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .bf-poplist { max-height: 240px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
  .bf-opt {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    background: transparent; border: none; border-radius: 8px; padding: 7px 9px; cursor: pointer;
    font: inherit; font-size: 13px; color: var(--text); transition: background .1s;
  }
  .bf-opt:hover { background: var(--hover); }
  .bf-opt.sel { color: var(--accent); background: var(--accent-soft); }
  .bf-opt .bf-opt-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bf-opt > svg { color: var(--accent); flex: 0 0 auto; }
  .bf-sw { width: 11px; height: 11px; border-radius: 4px; flex: 0 0 auto; }
  .bf-clear { color: var(--muted); font-weight: 600; }
  .bf-empty { color: var(--muted); font-size: 12.5px; padding: 8px 9px; }

  .bf-active { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 12px; }
  .bf-chip {
    display: inline-flex; align-items: center; gap: 5px; background: var(--c); color: #fff; border: none;
    border-radius: 6px; padding: 3px 9px; cursor: pointer; font: inherit; font-family: var(--mono); font-size: 10.5px; font-weight: 600;
  }
  .bf-chip-x { opacity: .8; font-size: 9px; }

  .cols { flex: 1; min-height: 0; display: flex; gap: 14px; margin-top: 16px; padding-bottom: 4px; overflow-x: auto; }
  .col { flex: 1 1 0; min-width: 260px; display: flex; flex-direction: column; min-height: 0; background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; }
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
    .bf-search { flex: 1; }
    .bf-search input { width: 100%; }
  }
</style>
