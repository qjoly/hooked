<script>
  import { goto } from '$app/navigation';
  import { ago } from '$lib/format.js';

  let q = $state('');
  let project = $state('');
  let results = $state([]);
  let loading = $state(false);
  let lastQ = $state('');
  let timer = null;

  // Le snippet renvoyé par sqlite contient déjà <mark>…</mark> ; on l'injecte tel quel
  // mais on échappe le reste pour éviter toute injection HTML depuis le contenu indexé.
  function safeSnippet(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/&lt;mark&gt;/g, '<mark>')
      .replace(/&lt;\/mark&gt;/g, '</mark>');
  }

  function basename(p) {
    if (!p) return '';
    const parts = String(p).split('/');
    return parts[parts.length - 1] || p;
  }

  async function run() {
    const term = q.trim();
    if (!term) { results = []; lastQ = ''; return; }
    loading = true;
    try {
      const u = new URL('/api/search', window.location.origin);
      u.searchParams.set('q', term);
      if (project) u.searchParams.set('project', project);
      const r = await fetch(u).then((x) => x.json());
      results = r.results || [];
      lastQ = term;
    } catch (_) {
      results = [];
    } finally {
      loading = false;
    }
  }

  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(run, 250);
  }

  // Groupe les hits par session, en conservant l'ordre du meilleur score par session.
  const groups = $derived.by(() => {
    const map = new Map();
    for (const r of results) {
      const key = r.sessionId;
      if (!map.has(key)) {
        map.set(key, { sessionId: key, project: r.project, hits: [] });
      }
      map.get(key).hits.push(r);
    }
    return [...map.values()];
  });

  const projects = $derived.by(() => {
    const set = new Set(results.map((r) => r.project).filter(Boolean));
    return [...set].sort();
  });

  function openMessage(sessionId, ts) {
    // hash #msg-<ts encodé> → SessionDetail scroll dessus + flash après load.
    const hash = ts ? `#msg-${encodeURIComponent(ts)}` : '';
    goto(`/session/${encodeURIComponent(sessionId)}${hash}`);
  }
</script>

<section class="view active search-view">
  <div class="search-head">
    <h2>🔎 Full-text search</h2>
    <p class="hint">Searches all your prompts and Claude's replies. The index is built/refreshed on the first query.</p>
    <input
      class="search-input"
      type="search"
      placeholder="e.g. kubernetes, sealed secret, ArgoCD…"
      bind:value={q}
      oninput={onInput}
    />
    {#if projects.length > 1}
      <label class="filter">
        <span>Project:</span>
        <select bind:value={project} onchange={run}>
          <option value="">all</option>
          {#each projects as p}
            <option value={p}>{basename(p)}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>

  {#if loading}
    <div class="status-line">… searching</div>
  {:else if lastQ && !results.length}
    <div class="status-line">No results for <strong>{lastQ}</strong>.</div>
  {:else if results.length}
    <div class="status-line">
      {results.length} message{results.length > 1 ? 's' : ''} in
      {groups.length} session{groups.length > 1 ? 's' : ''} for <strong>{lastQ}</strong>
    </div>
    <ul class="groups">
      {#each groups as g (g.sessionId)}
        <li class="group">
          <div class="ghead">
            <a class="gproject" href={`/session/${encodeURIComponent(g.sessionId)}`}>
              📁 {basename(g.project) || '—'}
            </a>
            <span class="gid" title={g.sessionId}>{g.sessionId.slice(0, 8)}</span>
            <span class="gcount">{g.hits.length} match{g.hits.length > 1 ? 's' : ''}</span>
            <a class="gopen" href={`/session/${encodeURIComponent(g.sessionId)}`}>open session ↗</a>
          </div>
          <ul class="hits">
            {#each g.hits as r}
              <li
                class="hit"
                role="button"
                tabindex="0"
                onclick={() => openMessage(g.sessionId, r.ts)}
                onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMessage(g.sessionId, r.ts); } }}
              >
                <div class="meta">
                  <span class="role role-{r.role}">{r.role === 'user' ? '🧑 you' : '🤖 claude'}</span>
                  <span class="ts">{r.ts ? ago(r.ts) : ''}</span>
                </div>
                <div class="snippet">{@html safeSnippet(r.snippet)}</div>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {:else}
    <div class="status-line muted">Type a query to start.</div>
  {/if}
</section>

<style>
  .search-view { padding: 22px 26px; max-width: 980px; margin: 0 auto; overflow-y: auto; }
  .search-head h2 { margin: 0 0 4px; color: var(--text); }
  .hint { color: var(--muted); font-size: 13px; margin: 0 0 12px; }
  .search-input {
    width: 100%;
    padding: 11px 14px;
    font-size: 15px;
    color: var(--text);
    background: var(--card);
    border: 2px solid var(--accent);
    border-radius: 11px;
    outline: none;
    transition: box-shadow .15s;
  }
  .search-input:focus { box-shadow: 0 0 0 3px var(--accent-soft); }
  .filter { display: inline-flex; gap: 6px; align-items: center; margin-top: 8px; font-size: 13px; color: var(--muted); }
  .filter select { padding: 4px 8px; border: 1px solid var(--border2); border-radius: 8px; background: var(--card); color: var(--text); }

  .status-line { padding: 12px 0; color: var(--muted); font-size: 13px; }
  .status-line strong { color: var(--text); }
  .status-line.muted { opacity: .7; }

  .groups { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 14px; }
  .group {
    background: var(--bg2);
    border: 1px solid var(--border);
    border-radius: 12px;
    box-shadow: var(--shadow-sm);
    overflow: hidden;
  }
  .ghead {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px;
    background: var(--bg3);
    border-bottom: 1px solid var(--border);
    font-size: 12px; color: var(--muted);
  }
  .gproject { color: var(--text); font-weight: 700; text-decoration: none; font-family: var(--mono); font-size: 12px; }
  .gproject:hover { color: var(--accent); }
  .gid { font-family: var(--mono); font-size: 11px; opacity: .7; }
  .gcount { background: var(--card); border: 1px solid var(--border2); border-radius: 999px; padding: 1px 9px; font-size: 11px; font-weight: 600; color: var(--muted); }
  .gopen { margin-left: auto; color: var(--accent); text-decoration: none; font-weight: 600; font-size: 12px; }
  .gopen:hover { color: var(--accent-d); text-decoration: underline; }

  .hits { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; }
  .hit {
    padding: 10px 14px;
    cursor: pointer;
    border-top: 1px solid var(--border);
    background: var(--panel);
    transition: background .12s;
  }
  .hit:first-child { border-top: none; }
  .hit:hover, .hit:focus { background: var(--bg3); outline: none; }
  .meta { display: flex; gap: 12px; align-items: center; font-size: 11px; color: var(--muted); margin-bottom: 4px; font-family: var(--mono); text-transform: uppercase; letter-spacing: .04em; }
  .role { font-weight: 700; }
  .role-user { color: var(--accent); }
  .role-assistant { color: var(--working); }
  .ts { opacity: .8; }
  .snippet {
    font-size: 13.5px;
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .snippet :global(mark) {
    background: var(--waiting);
    color: #2f2b23;
    padding: 0 3px;
    border-radius: 3px;
    font-weight: 600;
  }
</style>
