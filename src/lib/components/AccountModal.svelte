<script>
  import { copyText } from '$lib/clipboard.js';
  import { onDestroy } from 'svelte';
  import { account, loadAccount } from '$lib/state.svelte.js';
  import { accountAction } from '$lib/api.js';
  import { initials } from '$lib/format.js';
  import Icon from './Icon.svelte';

  let login = $state(null);  // { id, url, done, needsPaste, output, exitCode, reason, startedAt, timeoutMs, starting }
  let redirect = $state('');
  let notice = $state('');
  let loggingOut = $state(false);
  let confirmingLogout = $state(false);
  let poll = null;

  // Roster: saved accounts that can be switched to instantly (no fresh `claude auth login`).
  let roster = $state([]);
  let rosterLoading = $state(false);
  let saveLabel = $state('');
  let savingRoster = $state(false);
  let switchingId = $state(null);   // roster id currently being switched to
  let removingId = $state(null);    // roster id pending a remove confirm (click-to-confirm, same row)
  let renamingId = $state(null);
  let renameValue = $state('');

  // A switch (fresh login OR roster) that needs an explicit "yes, even though sessions are busy"
  // before it runs — holds the thunk to call once confirmed. null = no switch is gated right now.
  let pendingSwitch = $state(null);

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  async function loadRoster() {
    rosterLoading = true;
    try {
      const r = await accountAction({ action: 'roster-list' });
      if (r.ok) roster = r.data.accounts || [];
    } finally { rosterLoading = false; }
  }

  // Identity can be stale the moment this opens (another tab, another terminal, another machine
  // via remote control) — force a fresh `auth status` rather than trusting the 5-minute cache.
  loadAccount(true);
  loadRoster();

  // Switching (either a fresh login or a roster entry) replaces the ONE credential slot every
  // `claude` process on this machine reads — including any OTHER driven session mid-turn right
  // now. Gate on that instead of just doing it, but only when it's actually true.
  function requestSwitch(run) {
    if (account.busySessions > 0) { pendingSwitch = run; return; }
    run();
  }
  function confirmPendingSwitch() { const run = pendingSwitch; pendingSwitch = null; if (run) run(); }
  function cancelPendingSwitch() { pendingSwitch = null; }

  async function startSwitch(mode) {
    notice = '';
    redirect = '';
    login = { id: null, url: null, done: false, needsPaste: false, output: '', starting: true, startedAt: Date.now() };
    const r = await accountAction({ action: 'login', mode });
    if (!r.ok) { login = null; notice = r.data?.error || 'Could not start the login flow.'; return; }
    login = r.data.login;
    stopPoll();
    poll = setInterval(async () => {
      if (!login?.id) return;
      const s = await accountAction({ action: 'login-status', id: login.id });
      if (!s.ok) { stopPoll(); return; }
      login = s.data.login;
      if (login.done) {
        stopPoll();
        if (login.exitCode === 0) { saveLabel = ''; await loadAccount(true); await loadRoster(); }
      }
    }, 1500);
  }

  async function sendRedirect() {
    if (!login?.id || !redirect.trim()) return;
    const r = await accountAction({ action: 'login-input', id: login.id, text: redirect });
    redirect = '';
    if (r.ok) login = r.data.login;
  }

  async function cancelLogin() {
    stopPoll();
    if (login?.id) await accountAction({ action: 'login-cancel', id: login.id });
    login = null;
  }

  function closeLogin() { stopPoll(); login = null; }

  async function saveToRoster() {
    savingRoster = true;
    const r = await accountAction({ action: 'roster-save', label: saveLabel.trim() });
    savingRoster = false;
    if (r.ok) { notice = 'Saved — switch back to it instantly next time.'; await loadRoster(); closeLogin(); }
    else notice = r.data?.error || 'Could not save this account.';
  }

  function reasonMessage(l) {
    if (l.reason === 'timeout') return `Login timed out after ${Math.round((l.timeoutMs || 600000) / 60000)} min — try again.`;
    if (l.reason === 'cancelled') return 'Cancelled.';
    return 'Login flow ended before completing.';
  }

  function elapsedSeconds(l) { return l?.startedAt ? Math.max(0, Math.round((Date.now() - l.startedAt) / 1000)) : 0; }
  function elapsedLabel(l) {
    const s = elapsedSeconds(l);
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  async function doRosterSwitch(id) {
    switchingId = id;
    notice = '';
    const r = await accountAction({ action: 'roster-switch', id });
    switchingId = null;
    if (r.ok) { notice = 'Switched.'; await loadAccount(true); await loadRoster(); }
    else notice = r.data?.error || 'Could not switch to this account.';
  }
  function askRosterSwitch(id) { requestSwitch(() => doRosterSwitch(id)); }

  async function confirmRemove(id) {
    if (removingId !== id) { removingId = id; return; } // first click arms it
    removingId = null;
    const r = await accountAction({ action: 'roster-remove', id });
    if (r.ok) await loadRoster();
  }

  function startRename(a) { renamingId = a.id; renameValue = a.label; }
  async function submitRename() {
    if (!renamingId) return;
    const r = await accountAction({ action: 'roster-rename', id: renamingId, label: renameValue.trim() });
    renamingId = null;
    if (r.ok) await loadRoster();
  }

  async function logout() {
    loggingOut = true;
    confirmingLogout = false;
    const r = await accountAction({ action: 'logout' });
    loggingOut = false;
    notice = r.ok ? 'Signed out.' : (r.data?.error || 'Logout failed.');
    await loadAccount(true);
    await loadRoster();
  }

  onDestroy(stopPoll);
</script>

<div class="account">
  <div class="head">
    <div class="big-avatar">{initials(account.displayName, account.email)}</div>
    <div class="who">
      <strong>{account.displayName || account.email || 'Unknown account'}</strong>
      {#if account.email && account.displayName}<span class="email">{account.email}</span>{/if}
      {#if account.organizationName}<span class="org">{account.organizationName}</span>{/if}
      {#if account.loggedIn === false}<span class="warn">Not signed in</span>{/if}
    </div>
  </div>

  {#if notice}<p class="notice">{notice}</p>{/if}

  {#if login}
    <div class="auth">
      <div class="auth-head">
        <strong><Icon name="lock" size={14} /> Sign in</strong>
        <button class="link" onclick={closeLogin}>Close</button>
      </div>
      {#if login.starting}
        <p class="sub">Starting the login flow…</p>
      {:else if login.done}
        {#if login.exitCode === 0}
          <p class="sub"><Icon name="check" size={13} /> Signed in.</p>
          <div class="urlrow">
            <input class="pick" bind:value={saveLabel} placeholder="Label (e.g. Personal, Work)…"
                   onkeydown={(e) => e.key === 'Enter' && saveToRoster()} />
            <button class="btn primary" onclick={saveToRoster} disabled={savingRoster}>
              {savingRoster ? 'Saving…' : 'Save for quick switch'}
            </button>
          </div>
          <button class="link" onclick={closeLogin}>Skip</button>
        {:else}
          <p class="sub">{reasonMessage(login)}</p>
        {/if}
      {:else if login.url}
        <p class="sub">A browser tab may already be open. If not, open this URL and approve the sign-in:</p>
        <div class="urlrow">
          <a class="url" href={login.url} target="_blank" rel="noreferrer noopener">{login.url}</a>
          <button class="btn" onclick={() => copyText(login.url)}>
            <Icon name="copy" size={14} /> Copy
          </button>
        </div>
        {#if login.needsPaste}
          <p class="sub">Paste the code or redirect URL shown after you approve:</p>
          <div class="urlrow">
            <input class="pick" bind:value={redirect} placeholder="code or redirect URL…"
                   onkeydown={(e) => e.key === 'Enter' && sendRedirect()} />
            <button class="btn" onclick={sendRedirect} disabled={!redirect.trim()}>Submit</button>
          </div>
        {:else}
          <p class="sub waiting"><Icon name="queued" size={13} /> Waiting for authorization… ({elapsedLabel(login)})</p>
          {#if elapsedSeconds(login) > 60}
            <p class="hint">Taking a while? Make sure a browser window opened, or open the link above manually.</p>
          {/if}
        {/if}
      {:else}
        <p class="sub waiting"><Icon name="queued" size={13} /> Starting… ({elapsedLabel(login)})</p>
      {/if}
      {#if login.output && (login.done ? login.exitCode !== 0 : !login.url)}
        <pre class="raw">{login.output}</pre>
      {/if}
      {#if !login.done}<button class="link danger" onclick={cancelLogin}>Cancel</button>{/if}
    </div>
  {:else if pendingSwitch}
    <div class="warn-card">
      <p class="sub">
        <Icon name="warning" size={14} />
        {account.busySessions} session{account.busySessions > 1 ? 's are' : ' is'} currently running —
        switching replaces the credentials every <code>claude</code> process on this machine uses, so
        {account.busySessions > 1 ? 'they' : 'it'} will be affected too.
      </p>
      <div class="confirm">
        <button class="btn danger" onclick={confirmPendingSwitch}>Switch anyway</button>
        <button class="link" onclick={cancelPendingSwitch}>Cancel</button>
      </div>
    </div>
  {:else}
    {#if roster.length}
      <div class="roster">
        <div class="roster-head">Saved accounts</div>
        {#each roster as a (a.id)}
          <div class="roster-row">
            <div class="roster-avatar">{initials(a.displayName, a.email)}</div>
            <div class="roster-who">
              {#if renamingId === a.id}
                <input class="pick small" bind:value={renameValue}
                       onkeydown={(e) => e.key === 'Enter' && submitRename()}
                       onblur={submitRename} />
              {:else}
                <strong>{a.label}</strong>
                <span class="email">{a.email || a.displayName || ''}</span>
              {/if}
            </div>
            {#if a.active}
              <span class="active-badge"><Icon name="check" size={12} /> Active</span>
            {:else}
              <button class="btn tiny" onclick={() => askRosterSwitch(a.id)} disabled={switchingId === a.id}>
                {switchingId === a.id ? 'Switching…' : 'Switch'}
              </button>
            {/if}
            <button class="icon-btn" title="Rename" onclick={() => startRename(a)}><Icon name="pencil" size={13} /></button>
            <button class="icon-btn" class:armed={removingId === a.id} title={removingId === a.id ? 'Click again to remove' : 'Remove'}
                    onclick={() => confirmRemove(a.id)}>
              <Icon name="trash" size={13} />
            </button>
          </div>
        {/each}
      </div>
    {:else if rosterLoading}
      <p class="hint">Loading saved accounts…</p>
    {/if}

    <div class="actions">
      <button class="btn primary" onclick={() => requestSwitch(() => startSwitch('claudeai'))}>
        <Icon name="refresh" size={14} /> Switch account (Claude subscription)
      </button>
      <button class="btn" onclick={() => requestSwitch(() => startSwitch('console'))}>
        Switch to Console / API billing
      </button>
    </div>
    <p class="hint">
      Runs the same sign-in flow as <code>claude auth login</code>. It replaces the credentials the
      CLI keeps on this machine — every session, not just hooked's, authenticates as the new
      account afterwards. Sign in once and save it above to switch back without repeating this.
    </p>

    {#if confirmingLogout}
      <div class="confirm">
        <span>Sign out of this account entirely?</span>
        <button class="btn danger" onclick={logout} disabled={loggingOut}>{loggingOut ? 'Signing out…' : 'Confirm sign out'}</button>
        <button class="link" onclick={() => (confirmingLogout = false)}>Cancel</button>
      </div>
    {:else}
      <button class="link danger" onclick={() => (confirmingLogout = true)}>Sign out</button>
    {/if}
  {/if}
</div>

<style>
  .account { min-width: 320px; max-width: 420px; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
  .big-avatar {
    width: 44px; height: 44px; border-radius: 50%; flex: none; background: var(--chip); color: var(--muted);
    display: flex; align-items: center; justify-content: center; font-size: var(--t-title); line-height: var(--lh-title); font-weight: 700;
  }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .who strong { font-size: var(--t-body); }
  .email, .org { font-size: var(--t-meta); color: var(--muted); }
  .warn { font-size: var(--t-meta); color: var(--attention); font-weight: 600; }

  .notice { margin: 0 0 12px; padding: 8px 11px; border-radius: 9px; background: var(--bg2); border: 1px solid var(--border); color: var(--muted); font-size: var(--t-ui); }

  .actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); font-weight: 600; cursor: pointer; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-d); }
  .btn.danger { background: none; border-color: var(--attention); color: var(--attention); }
  .btn.tiny { padding: 5px 9px; font-size: var(--t-meta); flex: none; }

  .hint { margin: 0 0 14px; font-size: var(--t-meta); color: var(--muted); line-height: 1.5; }
  .hint code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: var(--t-micro); }

  .link { background: none; border: none; color: var(--muted); font-size: var(--t-ui); cursor: pointer; padding: 0; text-decoration: underline; }
  .link.danger { color: var(--attention); }

  .confirm { display: flex; align-items: center; gap: 10px; font-size: var(--t-ui); }

  .auth, .warn-card { border: 1px solid var(--accent); border-radius: 12px; background: var(--bg2); padding: 14px 16px; margin-bottom: 12px; }
  .warn-card { border-color: var(--attention); }
  .warn-card .sub { display: flex; align-items: flex-start; gap: 7px; margin-bottom: 10px; }
  .auth-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .auth-head strong { display: inline-flex; align-items: center; gap: 7px; font-size: var(--t-body); }
  .sub { margin: 0; color: var(--muted); font-size: var(--t-ui); line-height: 1.5; }
  .urlrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .url { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: var(--t-meta); color: var(--accent); }
  .pick { flex: 1 1 auto; min-width: 0; padding: 8px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); color: var(--text); font-size: var(--t-ui); }
  .pick.small { padding: 5px 8px; font-size: var(--t-meta); }
  .pick:focus { outline: none; border-color: var(--accent); }
  .waiting { display: inline-flex; align-items: center; gap: 6px; }
  .raw { margin: 8px 0 0; padding: 10px; background: var(--bg3); border-radius: 8px; font-family: var(--mono); font-size: var(--t-meta); white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; color: var(--muted); }

  .roster { margin-bottom: 14px; border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  .roster-head { padding: 8px 12px; font-size: var(--t-micro); font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: var(--bg2); }
  .roster-row { display: flex; align-items: center; gap: 9px; padding: 8px 12px; border-top: 1px solid var(--border); }
  .roster-avatar {
    width: 26px; height: 26px; border-radius: 50%; flex: none; background: var(--chip); color: var(--muted);
    display: flex; align-items: center; justify-content: center; font-size: var(--t-micro); font-weight: 700;
  }
  .roster-who { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .roster-who strong { font-size: var(--t-ui); }
  .roster-who .email { font-size: var(--t-micro); }
  .active-badge { display: inline-flex; align-items: center; gap: 4px; font-size: var(--t-micro); font-weight: 600; color: var(--success); flex: none; }
  .icon-btn {
    flex: none; background: none; border: none; color: var(--muted); cursor: pointer; padding: 4px;
    border-radius: 6px; display: inline-flex;
  }
  .icon-btn:hover { background: var(--hover); color: var(--text); }
  .icon-btn.armed { color: var(--attention); }
</style>
