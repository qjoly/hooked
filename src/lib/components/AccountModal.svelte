<script>
  import { copyText } from '#lib/clipboard.js';
  import { onDestroy, onMount } from 'svelte';
  import { account, loadAccount, settings, updateSettings, loadSettings } from '#lib/state.svelte.js';
  import { accountAction, getAccount, getProfiles, getUsage, profilesAction } from '#lib/api.js';
  import { initials } from '#lib/format.js';
  import Icon from './Icon.svelte';

  // One list of accounts, the main one first. A card is keyed by `key`: '' for the main account (the
  // Claude Code login of this machine), else the id of the profile that has an account of its own.
  let accounts = $state([]);       // [{ key, label, info, usage }] -- profiles with an account
  let servers = $state([]);        // [{ id, label, models }]    -- profiles of kind `compatible`
  let mainUsage = $state(null);
  let notice = $state('');
  let cardError = $state(null);    // { key, text }
  let menu = $state(null);         // key of the card whose menu is open
  let confirm = $state(null);      // { kind: 'logout' | 'remove', key } -- or, for a server, key = its id
  let busy = $state(false);

  // The sign-in in flight: which card it is on, and the flow itself.
  let login = $state(null);        // { id, url, done, needsPaste, output, exitCode, starting }
  let loginKey = $state(null);
  let redirect = $state('');
  let poll = null;

  // The form to add an account, and the one to add a server.
  let newName = $state('');
  let adding = $state(false);
  let srv = $state({ open: false, name: '', url: '', token: '', ctx: '' });
  let probe = $state(null);        // { loading } | { baseUrl, models, error } for the address typed
  let picked = $state({});         // model id -> kept
  let savingServer = $state(false);

  // The account new sessions start on: a profile's, or the main one ('') when none is set or the one
  // set no longer has an account.
  const defaultKey = $derived(settings.defaultProfile && accounts.some((a) => a.key === settings.defaultProfile) ? settings.defaultProfile : '');

  const cards = $derived([
    { key: '', label: account.displayName || account.email || 'Main account', info: account, usage: mainUsage, main: true },
    ...accounts.map((a) => ({ ...a, main: false })),
  ]);

  async function loadAccounts() {
    try {
      const { profiles } = await getProfiles();
      servers = (profiles || []).filter((p) => p.kind === 'compatible');
      accounts = await Promise.all((profiles || []).filter((p) => p.hasAccount).map(async (p) => {
        const info = await getAccount(p.id).catch(() => null);
        // Its limits are asked for only once it is signed in: there is nothing to poll before.
        const usage = info?.loggedIn ? await getUsage(p.id).catch(() => null) : null;
        return { key: p.id, label: p.label, info, usage };
      }));
    } catch (_) { accounts = []; }
  }
  async function loadMain() {
    await loadAccount();
    mainUsage = await getUsage().catch(() => null);
  }
  const reload = (key) => (key === '' ? loadMain() : loadAccounts());

  // The 5 h and 7 d limits of an account, as text; null when there is nothing to show.
  const limitsOf = (u) => {
    const a = u?.account;
    if (!a || (!a.fiveHour && !a.sevenDay)) return null;
    const f = (x) => (x?.pct != null ? x.pct + '%' : '—');
    return `5h ${f(a.fiveHour)} · 7d ${f(a.sevenDay)}`;
  };
  const planOf = (info) => (info?.subscriptionType ? info.subscriptionType[0].toUpperCase() + info.subscriptionType.slice(1) : null);

  onMount(() => { loadAccounts(); getUsage().then((u) => { mainUsage = u; }).catch(() => {}); });

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }
  const fail = (key, text) => { cardError = { key, text }; };

  async function setDefault(key) {
    menu = null;
    await updateSettings({ defaultProfile: key });
  }

  // Signs `key` in (again): the same `claude auth login` flow as before, shown inside the card.
  async function startLogin(key, mode = 'claudeai') {
    menu = null;
    notice = '';
    cardError = null;
    redirect = '';
    if (login) await cancelLogin();
    loginKey = key;
    login = { id: null, url: null, done: false, needsPaste: false, output: '', starting: true };
    const r = await accountAction({ action: 'login', mode, ...(key ? { profile: key } : {}) });
    if (!r.ok) { login = null; loginKey = null; fail(key, r.data?.error || 'Could not start the sign-in.'); return; }
    login = r.data.login;
    stopPoll();
    poll = setInterval(async () => {
      if (!login?.id) return;
      const s = await accountAction({ action: 'login-status', id: login.id });
      if (!s.ok) { stopPoll(); return; }
      login = s.data.login;
      if (login.done) {
        stopPoll();
        if (login.exitCode === 0) { notice = 'Signed in.'; await reload(key); }
      }
    }, 1500);
  }

  async function sendRedirect() {
    if (!login?.id || !redirect.trim()) return;
    const r = await accountAction({ action: 'login-input', id: login.id, text: redirect });
    redirect = '';
    if (r.ok) login = r.data.login;
  }

  // Closing the panel ends the sign-in: leaving it open kept a process, and one of the few places
  // there are, until it timed out ten minutes later -- which is what made the next "Sign in" fail.
  async function cancelLogin() {
    stopPoll();
    const id = login?.id;
    login = null;
    loginKey = null;
    if (id) await accountAction({ action: 'login-cancel', id });
  }

  async function logout(key) {
    busy = true;
    confirm = null;
    const r = await accountAction({ action: 'logout', ...(key ? { profile: key } : {}) });
    busy = false;
    notice = r.ok ? 'Signed out.' : (r.data?.error || 'Sign-out failed.');
    await reload(key);
  }

  async function remove(id) {
    busy = true;
    confirm = null;
    const r = await profilesAction({ action: 'remove-profile', id });
    busy = false;
    if (!r.ok) { fail(id, r.data?.error || 'Could not remove it.'); return; }
    const d = r.data;
    notice = 'Removed.'
      + (d.loggedOut === false ? ' Signing out failed: its login may still be on this machine.' : '')
      + (d.keptDir ? ` Its folder was kept: ${d.keptDir}` : '');
    await loadAccounts();
    await loadSettings();
  }

  // A new profile with an account of its own, then straight into its sign-in.
  async function addAccount() {
    const label = newName.trim();
    if (!label || adding || login) return;
    adding = true;
    notice = '';
    const r = await profilesAction({ action: 'add-account', label });
    adding = false;
    if (!r.ok) { notice = r.data?.error || 'Could not add the account.'; return; }
    newName = '';
    await loadAccounts();
    await startLogin(r.data.profile.id);
  }

  // What the server at the typed address offers: checked before saving, so a typo or a server that is
  // asleep shows up here and not at the first launch.
  async function testServer() {
    if (!srv.url.trim()) return;
    probe = { loading: true };
    const r = await profilesAction({ action: 'probe-server', url: srv.url, token: srv.token });
    probe = r.ok ? r.data : { models: [], error: r.data?.error || 'request failed' };
    picked = Object.fromEntries((probe.models || []).map((m) => [m.id, true]));
  }

  async function addServer() {
    const label = srv.name.trim();
    if (!label || !srv.url.trim() || savingServer) return;
    notice = '';
    const models = Object.keys(picked).filter((id) => picked[id]);
    // Models were found and none is kept: saving would quietly mean "all of them".
    if (probe?.models?.length && !models.length) { notice = 'Tick at least one model, or Cancel.'; return; }
    savingServer = true;
    const body = { action: 'add-server', label, url: srv.url, token: srv.token, contextWindow: srv.ctx ? Number(srv.ctx) : undefined, models };
    const r = await profilesAction(body);
    savingServer = false;
    if (!r.ok) { notice = r.data?.error || 'Could not add the server.'; return; }
    notice = `Added “${r.data.profile.label}”. Pick it in New session.`;
    srv = { open: false, name: '', url: '', token: '', ctx: '' };
    probe = null;
    picked = {};
    await loadAccounts();
  }

  onDestroy(() => { stopPoll(); if (login?.id && !login.done) accountAction({ action: 'login-cancel', id: login.id }); });
</script>

<svelte:window onclick={(e) => { if (menu !== null && !e.target.closest?.('.menu, .menu-btn')) menu = null; }} />

<div class="account">
  <h2>Accounts</h2>
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}

  <div class="list">
    {#each cards as c (c.key)}
      {@const loggedIn = c.info?.loggedIn === true}
      {@const plan = planOf(c.info)}
      <div class="card" class:def={defaultKey === c.key}>
        <div class="row">
          <div class="avatar">{loggedIn ? initials(c.info.displayName, c.info.email) : '?'}</div>
          <div class="who">
            <div class="title">
              <strong>{c.label}</strong>
              {#if defaultKey === c.key}<span class="chip def" title="New sessions start on this account">Default</span>{/if}
              {#if plan}<span class="chip">{plan}</span>{/if}
            </div>
            {#if loggedIn}
              <span class="meta">{c.info.email}{#if c.info.organizationName} · {c.info.organizationName}{/if}</span>
              {#if limitsOf(c.usage)}<span class="meta" title="Rate limits of this account">{limitsOf(c.usage)}</span>{/if}
            {:else if c.info?.loggedIn === false}
              <span class="warn">Not signed in</span>
            {:else}
              <span class="meta">…</span>
            {/if}
            {#if c.main}<span class="meta">Claude Code's own login on this machine</span>{/if}
          </div>
          <div class="acts">
            {#if c.info?.loggedIn === false && !(login && loginKey === c.key)}
              <button class="btn primary" disabled={busy} onclick={() => startLogin(c.key)}>Sign in</button>
            {/if}
            <button class="btn ghost menu-btn" aria-label="Actions for {c.label}" aria-haspopup="menu" aria-expanded={menu === c.key}
                    onclick={() => (menu = menu === c.key ? null : c.key)}><Icon name="menu" size={16} /></button>
          </div>
          {#if menu === c.key}
            <div class="menu" role="menu">
              {#if defaultKey !== c.key}<button role="menuitem" onclick={() => setDefault(c.key)}>Use for new sessions</button>{/if}
              <button role="menuitem" onclick={() => startLogin(c.key)}>{loggedIn ? 'Sign in again' : 'Sign in'}</button>
              <button role="menuitem" onclick={() => startLogin(c.key, 'console')}>Sign in with Console (API billing)</button>
              {#if loggedIn}<button role="menuitem" class="danger" onclick={() => { menu = null; confirm = { kind: 'logout', key: c.key }; }}>Sign out</button>{/if}
              {#if !c.main}<button role="menuitem" class="danger" onclick={() => { menu = null; confirm = { kind: 'remove', key: c.key }; }}>Remove</button>{/if}
            </div>
          {/if}
        </div>

        {#if cardError?.key === c.key}
          <p class="err" role="alert"><Icon name="warning" size={13} /> {cardError.text}</p>
        {/if}

        {#if confirm && confirm.key === c.key}
          <div class="confirm">
            {#if confirm.kind === 'logout'}
              <span>Sign out of {c.main ? 'the main account? Every Claude Code session on this machine that is not on another account loses its login.' : `“${c.label}”?`}</span>
              <button class="btn danger" onclick={() => logout(c.key)} disabled={busy}>Sign out</button>
            {:else}
              <span>Remove “{c.label}”? It is signed out and leaves this list. Its folder stays on disk.</span>
              <button class="btn danger" onclick={() => remove(c.key)} disabled={busy}>Remove</button>
            {/if}
            <button class="link" onclick={() => (confirm = null)}>Cancel</button>
          </div>
        {/if}

        {#if login && loginKey === c.key}
          <div class="auth">
            <div class="auth-head">
              <strong><Icon name="lock" size={14} /> Sign in — {c.label}</strong>
              {#if login.done}<button class="link" onclick={cancelLogin}>Close</button>{/if}
            </div>
            {#if login.starting}
              <p class="sub waiting"><Icon name="queued" size={13} /> Starting…</p>
            {:else if login.done}
              <p class="sub">{login.exitCode === 0 ? 'Signed in.' : 'The sign-in ended before completing.'}</p>
            {:else if login.url}
              <p class="sub">
                Open this link in a browser window where you are signed in to
                <b>{loggedIn ? c.info.email : 'the account you want here'}</b>, and approve it:
              </p>
              <div class="urlrow">
                <a class="url" href={login.url} target="_blank" rel="noreferrer noopener">{login.url}</a>
                <button class="btn" onclick={() => copyText(login.url)}><Icon name="copy" size={14} /> Copy</button>
              </div>
              {#if c.main}
                <p class="hint">This replaces the main login: every Claude Code session on this machine that is not on another account uses the new one.</p>
              {/if}
              {#if login.needsPaste}
                <p class="sub">Paste the code or redirect URL shown after you approve:</p>
                <div class="urlrow">
                  <input class="pick" bind:value={redirect} placeholder="code or redirect URL…"
                         onkeydown={(e) => e.key === 'Enter' && sendRedirect()} />
                  <button class="btn" onclick={sendRedirect} disabled={!redirect.trim()}>Submit</button>
                </div>
              {:else}
                <p class="sub waiting"><Icon name="queued" size={13} /> Waiting for authorization…</p>
              {/if}
            {:else}
              <p class="sub waiting"><Icon name="queued" size={13} /> Starting…</p>
            {/if}
            {#if login.output && (login.done ? login.exitCode !== 0 : !login.url)}
              <pre class="raw">{login.output}</pre>
            {/if}
            {#if !login.done}<button class="link danger" onclick={cancelLogin}>Cancel sign-in</button>{/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>

  <div class="urlrow add">
    <input class="pick" placeholder="Name of a new account…" bind:value={newName} disabled={!!login}
           onkeydown={(e) => e.key === 'Enter' && addAccount()} />
    <button class="btn" onclick={addAccount} disabled={!newName.trim() || adding || !!login}>{adding ? 'Adding…' : 'Add account'}</button>
  </div>
  <p class="hint">Each account signs in on its own, and runs the sessions you start on it: pick it in <b>New session</b>, or make it the default from its menu.</p>

  <h2 class="section">Servers</h2>
  <div class="list">
    {#each servers as v (v.id)}
      <div class="card">
        <div class="row">
          <div class="avatar"><Icon name="link" size={15} /></div>
          <div class="who">
            <div class="title"><strong>{v.label}</strong></div>
            <span class="meta">{v.models.length ? v.models.length + ' model' + (v.models.length > 1 ? 's' : '') : 'models read from the server'}</span>
          </div>
          <div class="acts">
            <button class="btn ghost menu-btn" aria-label="Actions for {v.label}" aria-haspopup="menu" aria-expanded={menu === 'srv:' + v.id}
                    onclick={() => (menu = menu === 'srv:' + v.id ? null : 'srv:' + v.id)}><Icon name="menu" size={16} /></button>
          </div>
          {#if menu === 'srv:' + v.id}
            <div class="menu" role="menu">
              <button role="menuitem" class="danger" onclick={() => { menu = null; confirm = { kind: 'remove', key: v.id }; }}>Remove</button>
            </div>
          {/if}
        </div>
        {#if cardError?.key === v.id}<p class="err" role="alert"><Icon name="warning" size={13} /> {cardError.text}</p>{/if}
        {#if confirm && confirm.key === v.id}
          <div class="confirm">
            <span>Remove “{v.label}”? Sessions that ran on it keep their label.</span>
            <button class="btn danger" onclick={() => remove(v.id)} disabled={busy}>Remove</button>
            <button class="link" onclick={() => (confirm = null)}>Cancel</button>
          </div>
        {/if}
      </div>
    {:else}
      <p class="hint">No server yet. An Anthropic-compatible server (LM Studio…) runs sessions on your own machine.</p>
    {/each}
  </div>

  {#if srv.open}
    <div class="srv">
      <input class="pick" placeholder="Name, e.g. LM Studio" bind:value={srv.name} />
      <input class="pick" placeholder="Address, e.g. http://127.0.0.1:1234" bind:value={srv.url}
             oninput={() => (probe = null)} spellcheck="false" />
      <input class="pick" placeholder="Token (leave empty if the server has none)" bind:value={srv.token}
             oninput={() => (probe = null)} autocomplete="off" spellcheck="false" />
      <input class="pick" type="number" min="2048" placeholder="Context size the server loads models at, e.g. 65536" bind:value={srv.ctx} />
      <div class="urlrow">
        <button class="btn" onclick={testServer} disabled={!srv.url.trim() || probe?.loading}>{probe?.loading ? 'Testing…' : 'Test'}</button>
        {#if probe && !probe.loading}
          {#if probe.error}<span class="warn">{probe.error}</span>
          {:else}<span class="sub">{probe.models.length} model{probe.models.length === 1 ? '' : 's'} found</span>{/if}
        {/if}
      </div>
      {#if probe?.models?.length}
        <div class="models">
          {#each probe.models as m (m.id)}
            <label class="model"><input type="checkbox" bind:checked={picked[m.id]} /> <code>{m.id}</code></label>
          {/each}
        </div>
        <p class="hint">Only the ticked models can be picked for this server. A model that is not loaded is loaded by the server when first asked for, with its default context.</p>
      {/if}
      <div class="urlrow">
        <button class="btn primary" onclick={addServer} disabled={!srv.name.trim() || !srv.url.trim() || savingServer}>{savingServer ? 'Adding…' : 'Add server'}</button>
        <button class="link" onclick={() => { srv.open = false; probe = null; }}>Cancel</button>
      </div>
      <p class="hint">The token, if any, is kept in <code>profiles.json</code>, which only you can read.</p>
    </div>
  {:else}
    <button class="btn add-srv" onclick={() => (srv.open = true)}>Add server</button>
  {/if}
</div>

<style>
  .account { min-width: 320px; max-width: 420px; }
  h2 { margin: 0 0 12px; font-size: var(--t-body); font-weight: 700; }
  h2.section { margin-top: 22px; }

  .notice { margin: 0 0 12px; padding: 8px 11px; border-radius: 9px; background: var(--bg2); border: 1px solid var(--border); color: var(--muted); font-size: var(--t-ui); overflow-wrap: anywhere; }
  .err { display: flex; gap: 6px; align-items: flex-start; margin: 8px 0 0; color: var(--attention); font-size: var(--t-meta); }

  .list { display: flex; flex-direction: column; gap: 8px; }
  .card { position: relative; border: 1px solid var(--border); border-radius: 12px; background: var(--bg2); padding: 10px 12px; }
  .card.def { border-color: var(--accent); }
  .row { display: flex; align-items: center; gap: 11px; }
  .avatar {
    width: 36px; height: 36px; border-radius: 50%; flex: none; background: var(--chip); color: var(--muted);
    display: flex; align-items: center; justify-content: center; font-size: var(--t-ui); font-weight: 700;
  }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
  .title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .title strong { font-size: var(--t-body); }
  .chip { font-size: var(--t-micro); font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); background: var(--bg3); border-radius: 999px; padding: 2px 7px; }
  .chip.def { color: var(--accent); }
  .meta { font-size: var(--t-meta); color: var(--muted); overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .warn { font-size: var(--t-meta); color: var(--attention); font-weight: 600; }
  .acts { display: flex; align-items: center; gap: 6px; flex: none; }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 7px 11px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; white-space: nowrap; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-d); }
  .btn.danger { background: none; border-color: var(--attention); color: var(--attention); }
  .btn.ghost { border-color: transparent; background: none; color: var(--muted); padding: 6px; }
  .link { background: none; border: none; color: var(--muted); font-size: var(--t-ui); cursor: pointer; padding: 0; text-decoration: underline; }
  .link.danger { color: var(--attention); margin-top: 10px; }

  .menu {
    position: absolute; right: 8px; top: 48px; z-index: 5; min-width: 220px; padding: 4px;
    display: flex; flex-direction: column; background: var(--bg); border: 1px solid var(--border); border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, .25);
  }
  .menu button { text-align: left; background: none; border: none; color: var(--text); font-size: var(--t-ui); padding: 8px 10px; border-radius: 7px; cursor: pointer; }
  .menu button:hover { background: var(--hover); }
  .menu button.danger { color: var(--attention); }

  .confirm { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; margin-top: 10px; font-size: var(--t-ui); }
  .confirm span { flex: 1 1 100%; color: var(--muted); }

  .auth { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; }
  .auth-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .auth-head strong { display: inline-flex; align-items: center; gap: 7px; font-size: var(--t-ui); }
  .sub { margin: 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .urlrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .url { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: var(--t-meta); color: var(--accent); }
  .pick { flex: 1 1 auto; min-width: 0; padding: 8px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); }
  .pick:focus { outline: none; border-color: var(--accent); }
  .waiting { display: inline-flex; align-items: center; gap: 6px; }
  .raw { margin: 8px 0 0; padding: 10px; background: var(--bg3); border-radius: 8px; font-family: var(--mono); font-size: var(--t-meta); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; color: var(--muted); }

  .add { margin: 12px 0 6px; }
  .hint { margin: 0 0 8px; font-size: var(--t-meta); color: var(--muted); line-height: 1.5; }
  .hint code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: var(--t-micro); }
  .srv { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 4px; }
  .models { display: flex; flex-direction: column; gap: 4px; max-height: 140px; overflow-y: auto; padding: 8px 10px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); }
  .model { display: flex; align-items: center; gap: 8px; font-size: var(--t-meta); cursor: pointer; }
  .model code { font-family: var(--mono); overflow-wrap: anywhere; }
  .add-srv { margin: 8px 0 4px; }
</style>
