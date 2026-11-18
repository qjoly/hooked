<script>
  import { getLlmTools } from '#lib/api.js';
  import Icon from '#lib/components/Icon.svelte';
  import { data, sessionTitle } from '#lib/state.svelte.js';

  // Tools a driven session sends to the model: built-in tools plus every MCP server's tools, with
  // their token cost and whether they sit in the prompt or are deferred behind tool search.
  let catalog = $state(null);   // null = loading
  let error = $state('');
  let sessionId = $state('');
  let filter = $state('');
  let loading = $state(false);

  async function load(id) {
    loading = true;
    error = '';
    try {
      catalog = await getLlmTools(id);
      if (catalog.session) sessionId = catalog.session.id || '';
    } catch (e) {
      error = e?.message || 'request failed';
      catalog = catalog || { sessions: [], builtin: [], mcp: [], totals: null };
    }
    loading = false;
  }
  load(null);

  const label = (s) => {
    const known = data.sessions.find((x) => x.id === s.id);
    const title = known ? sessionTitle(known) : s.id.slice(0, 8);
    const dir = s.cwd ? s.cwd.split('/').filter(Boolean).pop() : '';
    return dir ? `${title} — ${dir}` : title;
  };

  const q = $derived(filter.trim().toLowerCase());
  const match = (t, server = '') => !q
    || t.name.toLowerCase().includes(q)
    || (t.description || '').toLowerCase().includes(q)
    || server.toLowerCase().includes(q);
  const builtin = $derived((catalog?.builtin || []).filter((t) => match(t)));
  const servers = $derived((catalog?.mcp || [])
    .map((s) => ({ ...s, shown: s.tools.filter((t) => match(t, s.name)) }))
    .filter((s) => s.shown.length || (!q && !s.tools.length)));

  const fmtTokens = (n) => (n == null ? '' : n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
  const serverTokens = (s) => s.tools.reduce((n, t) => n + (t.deferred === false ? t.tokens || 0 : 0), 0);
</script>

<div class="lt">
  <div class="lt-head">
    <Icon name="tool" size={18} />
    <div class="lt-headmain">
      <div class="lt-title">Tools sent to the model</div>
      {#if catalog === null}
        <div class="lt-sub">Loading…</div>
      {:else if !catalog.session}
        <div class="lt-sub">No driven session is running. Start one to see the tools it sends.</div>
      {:else if catalog.totals}
        <div class="lt-sub">
          {catalog.totals.count} tools · {fmtTokens(catalog.totals.tokens)} tokens in the prompt · {catalog.totals.deferred} deferred behind tool search (name only, {fmtTokens(catalog.totals.deferredTokens)} tokens if all loaded)
          {#if catalog.available === false}<br />Token counts unavailable for this session.{/if}
        </div>
      {/if}
    </div>
  </div>

  {#if catalog?.sessions?.length}
    <div class="lt-bar">
      <select bind:value={sessionId} onchange={() => load(sessionId)} aria-label="Session">
        {#each catalog.sessions as s (s.id)}
          <option value={s.id}>{label(s)}</option>
        {/each}
      </select>
      <input type="search" placeholder="Filter tools…" bind:value={filter} aria-label="Filter tools" />
      <button class="lt-btn" onclick={() => load(sessionId)} disabled={loading} title="Refresh" aria-label="Refresh">
        <Icon name="refresh" size={14} />
      </button>
    </div>
  {/if}
  {#if error}<p class="lt-sub">✗ {error}</p>{/if}

  {#if catalog?.session}
    <div class="lt-list">
      {#if builtin.length}
        <section>
          <h3>Built-in <span class="lt-count">{builtin.length}</span></h3>
          <ul>
            {#each builtin as t (t.name)}
              <li class="lt-row">
                <code class="lt-name">{t.name}</code>
                {#if t.deferred}<span class="lt-badge def">deferred</span>{/if}
                <span class="lt-tok">{fmtTokens(t.tokens)}</span>
              </li>
            {/each}
          </ul>
        </section>
      {/if}

      {#each servers as s (s.name)}
        <section>
          <h3>
            <Icon name="mcp" size={13} /> {s.name}
            <span class="lt-count">{s.tools.length}</span>
            {#if s.scope}<span class="lt-badge">{s.scope}</span>{/if}
            {#if s.status && s.status !== 'connected'}<span class="lt-badge warn">{s.status}</span>{/if}
            <span class="lt-tok">{fmtTokens(serverTokens(s))}</span>
          </h3>
          {#if !s.tools.length}
            <p class="lt-empty">No tools exposed{s.status && s.status !== 'connected' ? ` (${s.status})` : ''}.</p>
          {:else}
            <ul>
              {#each s.shown as t (t.wireName)}
                <li class="lt-row col">
                  <div class="lt-line">
                    <code class="lt-name" title={t.wireName}>{t.name}</code>
                    {#if t.deferred}<span class="lt-badge def">deferred</span>{/if}
                    {#if t.annotations?.readOnly}<span class="lt-badge">read-only</span>{/if}
                    {#if t.annotations?.destructive}<span class="lt-badge warn">destructive</span>{/if}
                    <span class="lt-tok">{fmtTokens(t.tokens)}</span>
                  </div>
                  {#if t.description}
                    <details>
                      <summary>{t.description.split('\n')[0]}</summary>
                      {#if t.description.includes('\n')}<pre>{t.description}</pre>{/if}
                    </details>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}

      {#if !builtin.length && !servers.length}
        <p class="lt-empty">{q ? 'No tool matches the filter.' : 'This session reports no tools.'}</p>
      {/if}
    </div>
  {/if}
</div>

<style>
  .lt { min-width: min(720px, 80vw); }
  .lt-head { display: flex; align-items: flex-start; gap: 11px; margin-bottom: 14px; padding-right: 24px; color: var(--muted); }
  .lt-head > :global(svg) { margin-top: 3px; flex: 0 0 auto; }
  .lt-headmain { min-width: 0; }
  .lt-title { font-size: var(--t-title); line-height: var(--lh-title); font-weight: 800; color: var(--text); }
  .lt-sub { font-size: var(--t-ui); color: var(--muted); margin-top: 2px; line-height: 1.5; }
  .lt-bar { display: flex; gap: 8px; margin-bottom: 12px; }
  .lt-bar select { flex: 1 1 50%; min-width: 0; }
  .lt-bar input { flex: 1 1 50%; min-width: 0; }
  .lt-bar select, .lt-bar input {
    background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; font: inherit; font-size: var(--t-ui);
  }
  .lt-btn {
    flex: none; background: var(--chip); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 10px; cursor: pointer; display: inline-flex; align-items: center;
  }
  .lt-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .lt-btn:disabled { opacity: .5; cursor: default; }
  .lt-list { max-height: 62vh; overflow: auto; display: flex; flex-direction: column; gap: 14px; }
  h3 {
    display: flex; align-items: center; gap: 6px; margin: 0 0 6px; font-size: var(--t-ui); font-weight: 700;
    color: var(--text); position: sticky; top: 0; background: var(--card, var(--bg)); padding: 4px 0; z-index: 1;
  }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .lt-row {
    display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 9px;
  }
  .lt-row.col { flex-direction: column; align-items: stretch; gap: 4px; }
  .lt-line { display: flex; align-items: center; gap: 8px; }
  .lt-name { font-family: var(--mono); font-size: var(--t-meta); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lt-count { font-weight: 600; color: var(--muted); font-size: var(--t-micro); }
  .lt-tok { margin-left: auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); white-space: nowrap; }
  .lt-badge {
    font-size: var(--t-micro); font-weight: 600; color: var(--muted); background: var(--chip);
    border: 1px solid var(--border); border-radius: 6px; padding: 0 6px; white-space: nowrap;
  }
  .lt-badge.def { color: var(--accent); }
  .lt-badge.warn { color: var(--danger, #d33); }
  details { font-size: var(--t-meta); color: var(--muted); }
  summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  details[open] summary { white-space: normal; }
  pre { white-space: pre-wrap; font-family: var(--mono); font-size: var(--t-micro); margin: 6px 0 0; color: var(--text); }
  .lt-empty { font-size: var(--t-ui); color: var(--muted); margin: 0; }
</style>
