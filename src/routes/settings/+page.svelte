<script>
  import { untrack, onMount } from 'svelte';
  import { ui, settings, updateSettings, setTheme, loadSessions } from '$lib/state.svelte.js';
  import { resync, getGit, checkoutBranch, dismissRestartNotice } from '$lib/api.js';

  // Métadonnées d'affichage des sous-onglets (miroir de SessionDetail / server/settings.js).
  const SUBTAB_META = {
    chat:      { icon: '💬', label: 'Conversation' },
    changes:   { icon: '📝', label: 'Files' },
    todos:     { icon: '✅', label: 'Tasks' },
    subagents: { icon: '🤖', label: 'Subagents' },
    terminal:  { icon: '🖥', label: 'Terminal' },
  };

  const THEMES = [
    { key: 'system', icon: '🖥️', label: 'System' },
    { key: 'light',  icon: '☀️', label: 'Light' },
    { key: 'dark',   icon: '🌙', label: 'Dark' },
  ];

  // Ordre local des sous-onglets, resynchronisé depuis le store (sauf pendant une réorganisation).
  let order = $state([...settings.subtabOrder]);
  $effect(() => { order = [...settings.subtabOrder]; });

  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    order = next;              // optimiste
    await updateSettings({ subtabOrder: next });
  }

  // Commande shell initiale : champ local resynchronisé depuis le store TANT QUE l'utilisateur
  // n'a pas commencé à éditer (sinon la resync async au chargement écraserait sa frappe).
  let cmd = $state('');
  let cmdDirty = false;
  $effect(() => { const v = settings.initialShellCommand; if (!cmdDirty) untrack(() => (cmd = v)); });
  let cmdStatus = $state('');
  async function saveCmd() {
    const res = await updateSettings({ initialShellCommand: cmd });
    cmdDirty = false;
    cmdStatus = res.ok ? '✓ saved' : '✗ ' + (res.data?.error || 'failed');
    setTimeout(() => { cmdStatus = ''; }, 2500);
  }

  // Resync live states: re-reads every session's tmux pane at cold to clear a stale status.
  let resyncing = $state(false);
  let resyncStatus = $state('');
  async function doResync() {
    if (resyncing) return;
    resyncing = true; resyncStatus = '';
    const res = await resync().catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      await loadSessions(); ui.tick++;         // push the refreshed states into the UI
      resyncStatus = `✓ resynced ${res.data.count} sessions`;
    } else {
      resyncStatus = '✗ ' + (res.data?.error || 'failed');
    }
    resyncing = false;
    setTimeout(() => { resyncStatus = ''; }, 3000);
  }

  // ── Git branch of the running hooked instance ─────────────────────────────────────────────────
  // Operates on the repo the server itself lives in (resolved server-side at runtime).
  let git = $state(null);          // { current, dirty, ahead, behind, upstream, branches, sync } | { error }
  let gitLoading = $state(false);
  let selected = $state('');       // branch chosen in the picker
  let checkoutStatus = $state(''); // feedback line
  let showOverrides = $state(false); // dirty deny → offer stash / force
  let checkingOut = $state(false);

  async function loadGit() {
    gitLoading = true;
    try {
      const d = await getGit();
      git = d;
      if (d && !d.error && !selected) selected = d.current || '';
    } catch (e) {
      git = { error: e.message || 'failed to load git status' };
    }
    gitLoading = false;
  }
  onMount(loadGit);

  async function doCheckout(strategy) {
    if (!selected || checkingOut) return;
    checkingOut = true; checkoutStatus = strategy === 'block' ? '' : '';
    const res = await checkoutBranch(selected, strategy).catch((e) => ({ ok: false, data: { error: e.message } }));
    checkingOut = false;
    if (res.ok) {
      showOverrides = false;
      checkoutStatus = `✓ on ${res.data.status?.current ?? selected}` + (res.data.stashRef ? ` (stashed: ${res.data.stashRef})` : '');
      await loadGit();
      setTimeout(() => { checkoutStatus = ''; }, 4000);
    } else if (res.data?.dirty) {
      showOverrides = true;
      checkoutStatus = '✗ working tree is dirty — choose how to proceed';
    } else {
      showOverrides = false;
      checkoutStatus = '✗ ' + (res.data?.error || 'checkout failed');
      setTimeout(() => { checkoutStatus = ''; }, 5000);
    }
  }

  async function dismissRestart() {
    const res = await dismissRestartNotice().catch(() => null);
    if (res?.ok && git) git = { ...git, sync: res.data.sync };
  }
</script>

<section id="view-settings" class="view active">
  <div class="settings">
    <h1>Settings</h1>
    <p class="lead">Persisted server-side (shared across browsers). More will be added as needed.</p>

    <div class="card">
      <h2>Theme</h2>
      <p class="hint">Interface appearance. (Per-browser preference.)</p>
      <div class="chips">
        {#each THEMES as t (t.key)}
          <button class="chip" class:active={ui.theme === t.key} onclick={() => setTheme(t.key)}>
            {t.icon} {t.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="card">
      <h2>Live state</h2>
      <p class="hint">Re-reads every session's tmux pane fresh to fix a stale status — e.g. a session stuck on “working” after it finished or after its terminal was closed.</p>
      <div class="cmd-row">
        <button class="save" onclick={doResync} disabled={resyncing}>{resyncing ? '⏳ Resyncing…' : '↻ Resync live states'}</button>
        {#if resyncStatus}<span class="status">{resyncStatus}</span>{/if}
      </div>
    </div>

    <div class="card">
      <h2>Git branch</h2>
      <p class="hint">Branch of the running hooked instance itself (the repo the server lives in). Checkout is blocked when the working tree is dirty; overrides let you stash or force.</p>

      {#if git?.sync?.restartNeeded}
        <div class="restart-notice">
          <span>♻️ {git.sync.note || 'A restart is needed to finish applying an update.'}</span>
          <button class="mini" onclick={dismissRestart}>Dismiss</button>
        </div>
      {:else if git?.sync?.note}
        <p class="hint" style="margin-bottom:12px">ℹ️ {git.sync.note}</p>
      {/if}

      {#if gitLoading && !git}
        <p class="hint">Loading…</p>
      {:else if git?.error}
        <p class="hint">✗ {git.error}</p>
      {:else if git}
        <p class="hint" style="margin-bottom:12px">
          Current: <strong>{git.detached ? '(detached HEAD)' : git.current}</strong>
          {#if git.dirty}<span class="badge dirty">dirty</span>{/if}
          {#if git.behind}<span class="badge">↓{git.behind} behind</span>{/if}
          {#if git.ahead}<span class="badge">↑{git.ahead} ahead</span>{/if}
          {#if git.upstream}<span class="badge">→ {git.upstream}</span>{/if}
        </p>
        <div class="cmd-row">
          <select class="cmd-input" bind:value={selected}>
            {#each git.branches as b (b.name + (b.remote ? ':r' : ''))}
              <option value={b.name} disabled={b.locked}>
                {b.current ? '● ' : ''}{b.name}{b.remote ? ' (remote)' : ''}{b.locked ? ' — in worktree' : ''}
              </option>
            {/each}
          </select>
          <button class="save" onclick={() => doCheckout('block')} disabled={checkingOut || !selected || selected === git.current}>
            {checkingOut ? '⏳' : 'Checkout'}
          </button>
          {#if checkoutStatus}<span class="status">{checkoutStatus}</span>{/if}
        </div>
        {#if showOverrides}
          <div class="cmd-row" style="margin-top:10px">
            <span class="hint" style="margin:0">Working tree is dirty:</span>
            <button class="chip" onclick={() => doCheckout('stash')} disabled={checkingOut}>📦 Stash &amp; checkout</button>
            <button class="chip danger" onclick={() => doCheckout('force')} disabled={checkingOut}>⚠ Force (discard changes)</button>
          </div>
        {/if}
      {/if}
    </div>

    <div class="card">
      <h2>Auto git sync</h2>
      <p class="hint">When enabled, periodically <code>git fetch</code> then <code>git pull --ff-only</code> — only if the working tree is clean and the branch is behind a fast-forwardable upstream. Never destructive; a dirty tree fetches only.</p>
      <label class="check">
        <input type="checkbox" checked={settings.autoGitSync} onchange={(e) => updateSettings({ autoGitSync: e.currentTarget.checked })} />
        <span>Enable background fetch + fast-forward pull</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.gitAutoRestartOnLock} onchange={(e) => updateSettings({ gitAutoRestartOnLock: e.currentTarget.checked })} />
        <span>Auto-restart the service when a pull changes <code>package-lock.json</code> (re-installs deps)</span>
      </label>
      <label class="check">
        <input type="checkbox" checked={settings.gitRestartNotice} onchange={(e) => updateSettings({ gitRestartNotice: e.currentTarget.checked })} />
        <span>Show a “restart needed / restarted” notice in the UI</span>
      </label>
    </div>

    <div class="card">
      <h2>Conversation diffs</h2>
      <p class="hint">How file edits render inline in the conversation. (Per-browser preference.)</p>
      <div class="chips">
        <button class="chip" class:active={!ui.diffSplit} onclick={() => (ui.diffSplit = false)}>▤ Unified</button>
        <button class="chip" class:active={ui.diffSplit} onclick={() => (ui.diffSplit = true)}>▥ Side-by-side</button>
      </div>
    </div>

    <div class="card">
      <h2>Session subtab order</h2>
      <p class="hint">Determines the display order — and which available tab opens first when arriving on a session.</p>
      <ul class="reorder">
        {#each order as key, i (key)}
          <li>
            <span class="ro-pos">{i + 1}</span>
            <span class="ro-name">{SUBTAB_META[key]?.icon} {SUBTAB_META[key]?.label ?? key}</span>
            <span class="ro-actions">
              <button class="mini" disabled={i === 0} onclick={() => move(i, -1)} title="Move up" aria-label="Move up">▲</button>
              <button class="mini" disabled={i === order.length - 1} onclick={() => move(i, 1)} title="Move down" aria-label="Move down">▼</button>
            </span>
          </li>
        {/each}
      </ul>
    </div>

    <div class="card">
      <h2>Initial shell command (new terminal)</h2>
      <p class="hint">Run automatically when opening a new terminal pane (＋ button). Empty = bare shell.</p>
      <div class="cmd-row">
        <input class="cmd-input" bind:value={cmd} placeholder="e.g. source .venv/bin/activate"
               oninput={() => (cmdDirty = true)}
               onkeydown={(e) => { if (e.key === 'Enter') saveCmd(); }} />
        <button class="save" onclick={saveCmd}>Save</button>
        {#if cmdStatus}<span class="status">{cmdStatus}</span>{/if}
      </div>
    </div>
  </div>
</section>

<style>
  #view-settings { overflow-y: auto; padding: 26px; }
  .settings { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 14px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 20px; padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .chip:hover { border-color: var(--border2); }
  .chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-d); }
  .reorder { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .reorder li { display: flex; align-items: center; gap: 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
  .ro-pos { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; width: 16px; }
  .ro-name { flex: 1; font-weight: 600; font-size: 13.5px; }
  .ro-actions { display: flex; gap: 4px; }
  .mini { background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 6px; width: 28px; height: 26px; cursor: pointer; font-size: 11px; }
  .mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-d); }
  .mini:disabled { opacity: .35; cursor: default; }
  .cmd-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cmd-input { flex: 1; min-width: 240px; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 9px 12px; color: var(--text); font-size: 13px; font-family: inherit; }
  .cmd-input:focus { outline: none; border-color: var(--accent); }
  .save { background: var(--accent); border: none; color: #fff; border-radius: 8px; padding: 9px 16px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .save:hover { background: var(--accent-d); }
  .status { color: var(--muted); font-size: 12.5px; }
  .badge { display: inline-block; margin-left: 6px; padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; background: var(--bg3); border: 1px solid var(--border); color: var(--muted); vertical-align: middle; }
  .badge.dirty { color: var(--accent-d); border-color: var(--accent); background: var(--accent-soft); }
  .chip.danger { color: #b42318; border-color: #f0a99f; background: #fef3f2; }
  .chip.danger:hover { border-color: #d92d20; }
  .check { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; margin-bottom: 10px; cursor: pointer; }
  .check:last-child { margin-bottom: 0; }
  .check input { margin-top: 2px; }
  .check code { font-size: 12px; background: var(--bg3); padding: 1px 5px; border-radius: 4px; }
  .restart-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--accent-soft); border: 1px solid var(--accent); color: var(--accent-d); border-radius: 8px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
</style>
