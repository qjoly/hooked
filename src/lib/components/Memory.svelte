<script>
  import { onMount } from 'svelte';
  import { getMemory } from '$lib/api.js';
  import Markdown from './Markdown.svelte';

  let data = $state(null);   // { projects, total, byType }
  let loading = $state(true);
  let query = $state('');
  let activeType = $state('all');
  let openKey = $state(null); // "<slug>/<file>" de la mémoire dépliée
  let collapsed = $state(new Set()); // slugs de projets repliés

  onMount(async () => {
    try { data = await getMemory(); } catch (_) {} finally { loading = false; }
  });

  const TYPE_META = {
    user: { label: 'User', hint: 'Qui tu es — rôle, préférences, expertise' },
    feedback: { label: 'Feedback', hint: 'Comment je dois travailler avec toi' },
    project: { label: 'Project', hint: 'Travail en cours, objectifs, contraintes' },
    reference: { label: 'Reference', hint: 'Pointeurs externes — URLs, dashboards, tickets' },
  };
  const TYPE_ORDER = ['user', 'feedback', 'project', 'reference'];

  const q = $derived(query.trim().toLowerCase());

  // Projets filtrés par recherche (nom projet, nom mémoire, description, corps) et par type.
  const projects = $derived(
    (data?.projects || [])
      .map((p) => ({
        ...p,
        memories: p.memories.filter(
          (m) =>
            (activeType === 'all' || m.type === activeType) &&
            (!q ||
              m.name.toLowerCase().includes(q) ||
              m.description.toLowerCase().includes(q) ||
              m.body.toLowerCase().includes(q) ||
              p.name.toLowerCase().includes(q)),
        ),
      }))
      .filter((p) => p.memories.length),
  );

  const shownTotal = $derived(projects.reduce((n, p) => n + p.memories.length, 0));

  function toggle(slug, file) {
    const key = slug + '/' + file;
    openKey = openKey === key ? null : key;
  }

  function toggleProject(slug) {
    const next = new Set(collapsed);
    next.has(slug) ? next.delete(slug) : next.add(slug);
    collapsed = next;
  }
</script>

<div class="mem">
  <header class="mem-head">
    <div>
      <h1>Memory</h1>
      <p class="sub">Ce que Claude a retenu de tes projets — un fait par fiche, persisté sous <code>~/.claude/projects/&lt;projet&gt;/memory/</code>.</p>
    </div>
    {#if data}
      <div class="count" title="{data.total} mémoires au total">{data.total}</div>
    {/if}
  </header>

  {#if loading}
    <p class="empty">Chargement…</p>
  {:else if !data || data.total === 0}
    <p class="empty">Aucune mémoire pour l'instant. Claude en écrira au fil des sessions.</p>
  {:else}
    <div class="controls">
      <input class="search" type="search" placeholder="Rechercher dans les mémoires…" bind:value={query} />
      <div class="types">
        <button class="chip" class:on={activeType === 'all'} onclick={() => (activeType = 'all')}>
          Tout <span class="n">{data.total}</span>
        </button>
        {#each TYPE_ORDER as t (t)}
          {#if data.byType[t]}
            <button class="chip t-{t}" class:on={activeType === t} onclick={() => (activeType = t)} title={TYPE_META[t].hint}>
              {TYPE_META[t].label} <span class="n">{data.byType[t]}</span>
            </button>
          {/if}
        {/each}
      </div>
    </div>

    {#if !projects.length}
      <p class="empty">Aucune mémoire ne correspond.</p>
    {:else}
      {#if q || activeType !== 'all'}<p class="hits">{shownTotal} résultat{shownTotal > 1 ? 's' : ''}</p>{/if}
      <div class="projects">
        {#each projects as p (p.slug)}
          {@const isCollapsed = collapsed.has(p.slug) && !q && activeType === 'all'}
          <section class="project" class:collapsed={isCollapsed}>
            <h2>
              <button class="phead" onclick={() => toggleProject(p.slug)} title={p.cwd || p.slug}>
                <svg class="pchev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                <span class="pname">{p.name}</span>
                <span class="pcount">{p.memories.length}</span>
              </button>
            </h2>
            {#if !isCollapsed}
            <div class="cards">
              {#each p.memories as m (m.file)}
                {@const key = p.slug + '/' + m.file}
                <article class="card t-{m.type}" class:open={openKey === key}>
                  <button class="card-head" onclick={() => toggle(p.slug, m.file)}>
                    <span class="row">
                      <span class="badge t-{m.type}">{TYPE_META[m.type].label}</span>
                      <span class="name">{m.name}</span>
                      <svg class="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                    </span>
                    {#if m.description}<span class="desc">{m.description}</span>{/if}
                  </button>
                  {#if openKey === key}
                    <div class="body">
                      <Markdown text={m.body} />
                      {#if m.originSessionId}
                        <a class="origin" href="/session/{encodeURIComponent(m.originSessionId)}" data-session-link>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                          Voir la session d'origine
                        </a>
                      {/if}
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .mem { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  .mem-head { display: flex; align-items: flex-start; gap: 16px; justify-content: space-between; margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .sub code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: 12px; }
  .count { flex: none; font-weight: 700; font-size: 18px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 14px; color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }

  .controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-bottom: 18px; }
  .search { flex: 1 1 220px; padding: 9px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: 14px; }
  .search:focus { outline: none; border-color: var(--accent); }
  .types { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg2); color: var(--muted); font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .chip:hover { border-color: var(--border2); }
  .chip.on { color: var(--accent-fg); background: var(--accent); border-color: var(--accent); }
  .chip .n { opacity: .7; font-variant-numeric: tabular-nums; }
  .chip.on .n { opacity: .85; }

  .hits { color: var(--muted); font-size: 12.5px; margin: 0 0 10px; }
  .projects { display: flex; flex-direction: column; gap: 26px; }
  .project h2 { margin: 0 0 10px; }
  .phead { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 2px; background: none; border: none; cursor: pointer; font-size: 14px; font-weight: 700; color: var(--text); text-align: left; }
  .phead:hover { color: var(--accent); }
  .pchev { flex: none; color: var(--muted); transition: transform .15s; }
  .project.collapsed .pchev { transform: rotate(-90deg); }
  .pname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pcount { flex: none; font-size: 11px; font-weight: 600; color: var(--muted); background: var(--bg3); border-radius: 999px; padding: 1px 8px; }
  .cards { display: flex; flex-direction: column; gap: 8px; }

  .card { border: 1px solid var(--border); border-left: 3px solid var(--type-c, var(--border2)); border-radius: 10px; background: var(--bg2); overflow: hidden; }
  .card.open { border-color: var(--border2); }
  .card-head { width: 100%; display: flex; flex-direction: column; gap: 6px; padding: 11px 13px; background: none; border: none; cursor: pointer; text-align: left; color: var(--text); }
  .card-head:hover { background: rgba(var(--ink-rgb), .04); }
  .row { display: flex; align-items: center; gap: 9px; }
  .badge { flex: none; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: 2px 7px; border-radius: 6px; color: var(--type-c, var(--muted)); background: var(--type-soft, var(--bg3)); }
  .name { flex: 1; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { flex: none; color: var(--muted); transition: transform .15s; }
  .card.open .chev { transform: rotate(180deg); }
  .desc { display: block; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
  .body { padding: 4px 14px 14px; border-top: 1px solid var(--border); font-size: 13px; line-height: 1.6; }
  .body :global(pre) { max-width: 100%; overflow-x: auto; }
  .origin { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 12px; font-weight: 600; color: var(--accent); text-decoration: none; padding: 5px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg3); }
  .origin:hover { border-color: var(--accent); }

  /* type colours — soft chip + accent bar */
  .t-user { --type-c: #7c3aed; --type-soft: rgba(124,58,237,.12); }
  .t-feedback { --type-c: #d97706; --type-soft: rgba(217,119,6,.14); }
  .t-project { --type-c: #2563eb; --type-soft: rgba(37,99,235,.13); }
  .t-reference { --type-c: #0891b2; --type-soft: rgba(8,145,178,.14); }
  .chip.t-user.on { background: #7c3aed; border-color: #7c3aed; }
  .chip.t-feedback.on { background: #d97706; border-color: #d97706; }
  .chip.t-project.on { background: #2563eb; border-color: #2563eb; }
  .chip.t-reference.on { background: #0891b2; border-color: #0891b2; }
</style>
