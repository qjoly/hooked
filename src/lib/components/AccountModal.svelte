<script>
  import { onDestroy } from 'svelte';
  import { account, loadAccount } from '$lib/state.svelte.js';
  import { accountAction } from '$lib/api.js';
  import { initials } from '$lib/format.js';
  import Icon from './Icon.svelte';

  let login = $state(null);  // { id, url, done, needsPaste, output, exitCode, starting }
  let redirect = $state('');
  let notice = $state('');
  let loggingOut = $state(false);
  let confirmingLogout = $state(false);
  let poll = null;

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  async function startSwitch(mode) {
    notice = '';
    redirect = '';
    login = { id: null, url: null, done: false, needsPaste: false, output: '', starting: true };
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
        if (login.exitCode === 0) { notice = 'Signed in.'; await loadAccount(); }
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

  async function logout() {
    loggingOut = true;
    confirmingLogout = false;
    const r = await accountAction({ action: 'logout' });
    loggingOut = false;
    notice = r.ok ? 'Signed out.' : (r.data?.error || 'Logout failed.');
    await loadAccount();
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
        <p class="sub">{login.exitCode === 0 ? 'Signed in.' : 'Login flow ended before completing.'}</p>
      {:else if login.url}
        <p class="sub">A browser tab may already be open. If not, open this URL and approve the sign-in:</p>
        <div class="urlrow">
          <a class="url" href={login.url} target="_blank" rel="noreferrer noopener">{login.url}</a>
          <button class="btn" onclick={() => navigator.clipboard?.writeText(login.url)}>
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
          <p class="sub waiting"><Icon name="queued" size={13} /> Waiting for authorization…</p>
        {/if}
      {:else}
        <p class="sub waiting"><Icon name="queued" size={13} /> Starting…</p>
      {/if}
      {#if login.output && (login.done ? login.exitCode !== 0 : !login.url)}
        <pre class="raw">{login.output}</pre>
      {/if}
      {#if !login.done}<button class="link danger" onclick={cancelLogin}>Cancel</button>{/if}
    </div>
  {:else}
    <div class="actions">
      <button class="btn primary" onclick={() => startSwitch('claudeai')}>
        <Icon name="refresh" size={14} /> Switch account (Claude subscription)
      </button>
      <button class="btn" onclick={() => startSwitch('console')}>
        Switch to Console / API billing
      </button>
    </div>
    <p class="hint">
      Runs the same sign-in flow as <code>claude auth login</code>. It replaces the credentials the
      CLI keeps on this machine — every session, not just hooked's, authenticates as the new
      account afterwards.
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
    display: flex; align-items: center; justify-content: center; font-size: 15px; font-weight: 700;
  }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .who strong { font-size: 14.5px; }
  .email, .org { font-size: 12px; color: var(--muted); }
  .warn { font-size: 12px; color: var(--attention); font-weight: 600; }

  .notice { margin: 0 0 12px; padding: 8px 11px; border-radius: 9px; background: var(--bg2); border: 1px solid var(--border); color: var(--muted); font-size: 12.5px; }

  .actions { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 9px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); color: var(--text); font-size: 12.5px; font-weight: 600; cursor: pointer; }
  .btn:hover:not(:disabled) { background: var(--hover); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--accent-d); }
  .btn.danger { background: none; border-color: var(--attention); color: var(--attention); }

  .hint { margin: 0 0 14px; font-size: 12px; color: var(--muted); line-height: 1.5; }
  .hint code { background: var(--bg3); padding: 1px 5px; border-radius: 5px; font-size: 11px; }

  .link { background: none; border: none; color: var(--muted); font-size: 12.5px; cursor: pointer; padding: 0; text-decoration: underline; }
  .link.danger { color: var(--attention); }

  .confirm { display: flex; align-items: center; gap: 10px; font-size: 12.5px; }

  .auth { border: 1px solid var(--accent); border-radius: 12px; background: var(--bg2); padding: 14px 16px; }
  .auth-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
  .auth-head strong { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; }
  .sub { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
  .urlrow { display: flex; gap: 8px; align-items: center; margin: 8px 0; }
  .url { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12px; color: var(--accent); }
  .pick { flex: 1 1 auto; min-width: 0; padding: 8px 11px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg2); color: var(--text); font-size: 12.5px; }
  .pick:focus { outline: none; border-color: var(--accent); }
  .waiting { display: inline-flex; align-items: center; gap: 6px; }
  .raw { margin: 8px 0 0; padding: 10px; background: var(--bg3); border-radius: 8px; font-family: var(--mono); font-size: 11.5px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow-y: auto; color: var(--muted); }
</style>
