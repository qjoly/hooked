<script>
  import { onDestroy, untrack } from 'svelte';
  import { getMcpServers, mcpAction } from '$lib/api.js';
  import Icon from './Icon.svelte';

  // MCP scopes are per-directory, so the lens is pinned to the session's own project — there is
  // no picker to get wrong.
  let { project = '' } = $props();

  let res = $state(null);          // { cwd, servers, diagnostics, error }
  let loading = $state(true);
  let busy = $state('');           // name of the server a logout/detail call is running for
  let details = $state({});        // name -> `claude mcp get` fields, lazily fetched
  let open = $state(null);         // name of the expanded row
  let login = $state(null);        // { id, name, url, done, needsPaste, output, exitCode }
  let redirect = $state('');
  let notice = $state('');
  let poll = null;

  const RANK = { needs_auth: 0, failed: 1, pending: 2, connected: 3 };
  // Anything needing a human first: this lens exists to fix broken auth, not to admire what works.
  const servers = $derived([...(res?.servers || [])]
    .sort((a, b) => (RANK[a.state] ?? 9) - (RANK[b.state] ?? 9) || a.name.localeCompare(b.name)));
  const broken = $derived(servers.filter((s) => s.state === 'needs_auth' || s.state === 'failed').length);

  const STATE_UI = {
    connected: { icon: 'check', color: 'var(--success)', label: 'Connected' },
    needs_auth: { icon: 'warning', color: 'var(--warn)', label: 'Needs authentication' },
    failed: { icon: 'close', color: 'var(--attention)', label: 'Failed' },
    pending: { icon: 'clock', color: 'var(--muted)', label: 'Pending approval' },
  };
  const stateUi = (s) => STATE_UI[s] || { icon: 'dot', color: 'var(--muted)', label: s };

  async function load(dir = project) {
    loading = true;
    open = null;
    details = {};
    try { res = await getMcpServers(dir); } catch (_) { res = { servers: [], diagnostics: [], error: 'request failed' }; }
    finally { loading = false; }
  }

  async function toggleDetails(name) {
    if (open === name) { open = null; return; }
    open = name;
    if (details[name]) return;
    busy = name;
    const r = await mcpAction({ action: 'get', cwd: project, name });
    if (r.ok) details = { ...details, [name]: r.data.detail };
    busy = '';
  }

  async function logout(name) {
    busy = name;
    const r = await mcpAction({ action: 'logout', cwd: project, name });
    busy = '';
    notice = r.ok ? `Cleared credentials for ${name}.` : `Logout failed for ${name}.`;
    await load();
  }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  async function reauth(name) {
    notice = '';
    redirect = '';
    login = { id: null, name, url: null, done: false, needsPaste: false, output: '', starting: true };
    const r = await mcpAction({ action: 'login', cwd: project, name });
    if (!r.ok) { login = null; notice = r.data?.error || `Could not start login for ${name}.`; return; }
    login = r.data.login;
    // The CLI holds the flow open until the OAuth callback lands (or the redirect URL is pasted),
    // so the page has to watch that process rather than the login call's return value.
    stopPoll();
    poll = setInterval(async () => {
      if (!login?.id) return;
      const s = await mcpAction({ action: 'login-status', id: login.id });
      if (!s.ok) { stopPoll(); return; }
      login = s.data.login;
      if (login.done) { stopPoll(); await load(); }
    }, 1500);
  }

  async function sendRedirect() {
    if (!login?.id || !redirect.trim()) return;
    const r = await mcpAction({ action: 'login-input', id: login.id, text: redirect });
    redirect = '';
    if (r.ok) login = r.data.login;
  }

  async function cancelLogin() {
    stopPoll();
    if (login?.id) await mcpAction({ action: 'login-cancel', id: login.id });
    login = null;
    await load();
  }

  function closeLogin() { stopPoll(); login = null; }

  // SessionDetail swaps the `id` prop instead of remounting, so the lens has to refetch when the
  // project underneath it changes.
  $effect(() => {
    const dir = project;  // tracked dep read BEFORE any guard (Svelte 5 trap)
    untrack(() => { stopPoll(); login = null; load(dir); });
  });
  onDestroy(stopPoll);
</script>

<div class="mcp">
  <div class="mcp-head">
    <div>
      <h2>MCP</h2>
      <p class="sub">
        Servers Claude Code can reach from <code>{project || 'the user scope'}</code>, health-checked
        live. Re-authenticate one here instead of running <code>/mcp</code> in a terminal.
      </p>
    </div>
    <div class="count" class:bad={broken > 0}>{broken > 0 ? `${broken} to fix` : servers.length}</div>
  </div>

  <div class="bar">
    <button class="btn" onclick={() => load()} disabled={loading}>
      <Icon name={loading ? 'queued' : 'refresh'} size={14} /> {loading ? 'Checking…' : 'Refresh'}
    </button>
  </div>

  {#if notice}
    <p class="notice">{notice}</p>
  {/if}

  {#if login}
    <div class="auth">
      <div class="auth-head">
        <strong><Icon name="lock" size={14} /> Authorize “{login.name}”</strong>
        <button class="link" onclick={closeLogin}>Close</button>
      </div>
      {#if login.starting}
        <p class="sub">Starting the login flow…</p>
      {:else if login.done && login.outOfBand && login.url}
        <p class="sub">Approve the connection on claude.ai, then hit Refresh:</p>
        <div class="urlrow">
          <a class="url" href={login.url} target="_blank" rel="noreferrer noopener">{login.url}</a>
          <button class="btn" onclick={() => navigator.clipboard?.writeText(login.url)}>
            <Icon name="copy" size={14} /> Copy
          </button>
        </div>
        <p class="sub">The connector reports as authenticated once claude.ai has it — this page will not notice on its own.</p>
      {:else if login.done}
        <p class="sub">
          {login.exitCode === 0 ? 'Login flow finished. The list has been refreshed.' : 'Login flow ended before completing.'}
        </p>
      {:else if login.url}
        <p class="sub">Open this URL in your browser and approve the connection:</p>
        <div class="urlrow">
          <a class="url" href={login.url} target="_blank" rel="noreferrer noopener">{login.url}</a>
          <button class="btn" onclick={() => navigator.clipboard?.writeText(login.url)}>
            <Icon name="copy" size={14} /> Copy
          </button>
        </div>
        {#if login.needsPaste}
          <p class="sub">This server finishes the flow locally. Paste the URL you were redirected to:</p>
          <div class="urlrow">
            <input class="pick" bind:value={redirect} placeholder="http://localhost:…/callback?code=…"
                   onkeydown={(e) => e.key === 'Enter' && sendRedirect()} />
            <button class="btn" onclick={sendRedirect} disabled={!redirect.trim()}>Submit</button>
          </div>
        {:else}
          <p class="sub waiting"><Icon name="queued" size={13} /> Waiting for authorization…</p>
        {/if}
      {:else}
        <p class="sub">No authorization URL was produced. Raw output:</p>
      {/if}
      {#if login.output && (login.done ? login.exitCode !== 0 : !login.url)}
        <pre class="raw">{login.output}</pre>
      {/if}
      {#if !login.done}<button class="link danger" onclick={cancelLogin}>Cancel</button>{/if}
    </div>
  {/if}

  {#if res?.error}
    <p class="empty">{res.error}</p>
  {:else if loading && !res}
    <p class="empty">Checking MCP server health…</p>
  {:else if !servers.length}
    <p class="empty">No MCP server configured for this project.</p>
  {:else}
    <div class="list">
      {#each servers as s (s.name)}
        {@const ui = stateUi(s.state)}
        <div class="card" style="--st:{ui.color}">
          <div class="row">
            <span class="st" title={s.status}><Icon name={ui.icon} size={15} color={ui.color} /></span>
            <div class="idcol">
              <div class="name">
                {s.name}
                <span class="chip">{s.scopeLabel}</span>
                <span class="chip">{s.transport}</span>
              </div>
              <div class="target" title={s.target}>{s.target}</div>
            </div>
            <div class="acts">
              {#if s.authable}
                <button class="btn" onclick={() => reauth(s.name)} disabled={!!login && !login.done}>
                  <Icon name="lock" size={14} /> {s.state === 'connected' ? 'Reauth' : 'Authenticate'}
                </button>
                {#if s.state === 'connected'}
                  <button class="btn" onclick={() => logout(s.name)} disabled={busy === s.name}>Logout</button>
                {/if}
              {/if}
              <button class="btn ghost" onclick={() => toggleDetails(s.name)} title="Details">
                <Icon name={open === s.name ? 'chevron-down' : 'chevron-right'} size={14} />
              </button>
            </div>
          </div>
          {#if open === s.name}
            <div class="det">
              {#if busy === s.name && !details[s.name]}
                <span class="sub">Loading…</span>
              {:else if details[s.name]}
                {@const d = details[s.name]}
                {#each [['Scope', d.scopeLabel], ['Status', d.status], ['Type', d.type], ['URL', d.url], ['Command', d.command], ['Args', d.args], ['Environment', d.env]] as [k, v]}
                  {#if v}<div class="dl"><span>{k}</span><code>{v}</code></div>{/if}
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if res?.diagnostics?.length}
    <div class="diag">
      <strong><Icon name="warning" size={14} color="var(--warn)" /> Config diagnostics</strong>
      <pre>{res.diagnostics.join('\n')}</pre>
    </div>
  {/if}
</div>

<style>
  .mcp { max-width: 900px; margin: 0 auto; padding: 24px 20px 80px; }
  .mcp-head { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
  .mcp-head > div:first-child { flex: 1 1 auto; }
  h2 { font-size: 18px; margin: 0 0 4px; letter-spacing: -.01em; }
  .sub { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .sub code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: 12px; }
  .count { flex: none; font-weight: 700; font-size: 18px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 14px; color: var(--accent); }
  .count.bad { color: var(--warn); border-color: var(--warn); }

  .bar { display: flex; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }
  .pick { flex: 1 1 260px; min-width: 0; padding: 9px 13px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: 13.5px; }
  .pick:focus { outline: none; border-color: var(--accent); }
  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: 12.5px; font-weight: 600; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.ghost { border-color: transparent; background: none; color: var(--muted); }
  .link { background: none; border: none; color: var(--muted); font-size: 12.5px; cursor: pointer; padding: 0; text-decoration: underline; }
  .link.danger { color: var(--attention); margin-top: 10px; }

  .notice { margin: 0 0 14px; padding: 9px 12px; border-radius: 9px; background: var(--bg2); border: 1px solid var(--border); color: var(--muted); font-size: 13px; }
  .empty { color: var(--muted); text-align: center; padding: 40px 0; }

  .auth { border: 1px solid var(--accent); border-radius: 12px; background: var(--bg2); padding: 14px 16px; margin: 0 0 18px; }
  .auth-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .auth-head strong { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; }
  .urlrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .url { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; color: var(--accent); }
  .waiting { display: inline-flex; align-items: center; gap: 6px; }
  .raw { margin: 8px 0 0; padding: 10px; background: var(--bg3); border-radius: 8px; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow-y: auto; color: var(--muted); }

  .list { display: flex; flex-direction: column; gap: 8px; }
  .card { border: 1px solid var(--border); border-left: 3px solid var(--st); border-radius: 10px; background: var(--bg2); overflow: hidden; }
  .row { display: flex; align-items: center; gap: 11px; padding: 11px 13px; }
  .st { flex: none; display: inline-flex; }
  .idcol { flex: 1 1 auto; min-width: 0; }
  .name { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 13.5px; flex-wrap: wrap; }
  .chip { font-weight: 600; font-size: 10.5px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); background: var(--bg3); border-radius: 999px; padding: 2px 7px; }
  .target { color: var(--muted); font-family: var(--mono); font-size: 11.5px; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acts { flex: none; display: flex; gap: 6px; align-items: center; }

  .det { border-top: 1px solid var(--border); padding: 10px 13px; display: flex; flex-direction: column; gap: 5px; }
  .dl { display: flex; gap: 10px; font-size: 12px; }
  .dl span { flex: none; width: 92px; color: var(--muted); }
  .dl code { font-family: var(--mono); font-size: 11.5px; overflow-wrap: anywhere; }

  .diag { margin-top: 20px; border: 1px solid var(--border); border-left: 3px solid var(--warn); border-radius: 10px; background: var(--bg2); padding: 12px 14px; }
  .diag strong { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; }
  .diag pre { margin: 8px 0 0; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--muted); }
</style>
