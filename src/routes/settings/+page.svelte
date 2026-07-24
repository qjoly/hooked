<script>
  import { untrack, onMount } from 'svelte';
  import { data, ui, settings, updateSettings, setTheme, setScheme, loadSessions, allTags, tagUsage, deleteTag } from '$lib/state.svelte.js';
  import { tagColor } from '$lib/format.js';
  import { resync, getGit, checkoutBranch, dismissRestartNotice, getClaudeVersion, upgradeClaude, restartClaudeSession, pickFolder } from '$lib/api.js';
  import ModelEffort from '$lib/components/ModelEffort.svelte';

  // Navigation de section (rail gauche collant). Chaque entrée pointe l'id d'une carte ;
  // les cartes secondaires appartiennent à la section la plus proche au-dessus.
  const NAV = [
    { id: 'pset-appearance', label: 'Appearance' },
    { id: 'pset-sidebar', label: 'Sidebar' },
    { id: 'pset-new', label: 'New session defaults' },
    { id: 'pset-project', label: 'Default project' },
    { id: 'pset-digest', label: 'Daily digest' },
    { id: 'pset-live', label: 'Live state' },
    { id: 'pset-claude', label: 'Claude Code' },
    { id: 'pset-git', label: 'Git' },
    { id: 'pset-tags', label: 'Tags' },
    { id: 'pset-interface', label: 'Interface' },
  ];
  let activeSec = $state(NAV[0].id);
  // Tag deletion is two-click (arm → confirm) to avoid removing a tag from every session by mistake.
  let confirmTag = $state(null);
  function removeTag(tag) {
    if (confirmTag !== tag) { confirmTag = tag; return; }
    deleteTag(tag);
    confirmTag = null;
  }
  function goTo(id) {
    activeSec = id;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // scroll-spy : la section dont le haut franchit la bande supérieure devient active.
  onMount(() => {
    const root = document.getElementById('view-settings');
    if (!root) return;
    const secs = [...root.querySelectorAll('[data-sec]')];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) activeSec = e.target.id;
    }, { root, rootMargin: '-8% 0px -80% 0px', threshold: 0 });
    secs.forEach((s) => io.observe(s));
    return () => io.disconnect();
  });

  // Métadonnées d'affichage des sous-onglets (miroir de SessionDetail / server/settings.js).
  const SUBTAB_META = {
    chat:        { icon: '💬', label: 'Conversation' },
    changes:     { icon: '📝', label: 'Files' },
    todos:       { icon: '✅', label: 'Tasks' },
    subagents:   { icon: '🤖', label: 'Subagents' },
    subsessions: { icon: '🔗', label: 'Sub-sessions' },
    background:  { icon: '🌀', label: 'Background' },
    terminal:    { icon: '🖥', label: 'Terminal' },
    pr:          { icon: '🔀', label: 'PRs' },
    issues:      { icon: '🐛', label: 'Issues' },
  };

  // Elements of the session status bar (header) that can be toggled on/off and reordered.
  // Keyed map (label per key) ; l'ordre d'affichage vient de settings.statusBarOrder.
  const STATUS_BAR_META = {
    branch:         { label: 'Git branch' },
    stateBadge:     { label: 'State badge (working / waiting / ended…)' },
    permissionMode: { label: 'Permission-mode control (Normal / Auto-edits / Plan)' },
    modelEffort:    { label: 'Model / effort control' },
    cost:           { label: 'Cost (session + subagent cost)' },
    prompts:        { label: 'Prompt count' },
    tokens:         { label: 'Token counts (output + cache)' },
    model:          { label: 'Model name (shown when session is not live)' },
    usage5h:        { label: '5-hour usage indicator' },
    prLinks:        { label: 'Show linked PRs in the status bar' },
    issueLinks:     { label: 'Show linked issues in the status bar' },
    focusBtn:       { label: 'Focus button (in ⋯ menu)' },
  };

  const THEMES = [
    { key: 'system', icon: '🖥️', label: 'System' },
    { key: 'light',  icon: '☀️', label: 'Light' },
    { key: 'dark',   icon: '🌙', label: 'Dark' },
  ];
  // Palette (axe orthogonal au clair/sombre). 'default' = refonte indigo ; 'legacy' = ancien thème crème.
  const SCHEMES = [
    { key: 'default', icon: '🟣', label: 'Default' },
    { key: 'legacy',  icon: '🟤', label: 'Legacy' },
  ];

  // Défauts de session (modèle / effort / mode de permission) pré-sélectionnés dans les formulaires
  // Nouvelle session et Resume. '' = hériter de la config Claude Code (~/.claude). Champs locaux
  // resynchronisés depuis le store, persistés à chaque changement du sélecteur.
  let defModel = $state(settings.defaultModel || '');
  let defEffort = $state(settings.defaultEffort || '');
  let defMode = $state(settings.defaultMode || '');
  $effect(() => { defModel = settings.defaultModel || ''; defEffort = settings.defaultEffort || ''; defMode = settings.defaultMode || ''; });
  function saveDefaults() {
    updateSettings({ defaultModel: defModel, defaultEffort: defEffort, defaultMode: defMode });
  }

  // Projet de démarrage rapide : cwd utilisé quand une session est lancée sans dossier (p.ex. un
  // raccourci macOS qui POST /api/launch avec juste un prompt). Liste = projets connus (comme la
  // Nouvelle session), + « Other folder… » via le sélecteur natif. '' = aucun (cwd requis comme avant).
  const projs = $derived.by(() => {
    const m = new Map();
    for (const s of data.sessions) {
      if (!s.project) continue;
      const e = m.get(s.project) || { name: s.projectName || s.project, count: 0, last: '' };
      e.count++;
      const t = s.lastActivity || '';
      if (t > e.last) e.last = t;
      m.set(s.project, e);
    }
    return [...m.entries()]
      .sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
      .map(([cwd, e]) => [cwd, e.name]);
  });
  const quickProject = $derived(settings.quickLaunchProject || '');
  let picking = $state(false);
  async function browseQuickProject() {
    if (picking) return;
    picking = true;
    try {
      const r = await pickFolder(quickProject || undefined);
      if (r.ok && r.data?.dir) updateSettings({ quickLaunchProject: r.data.dir });
    } finally {
      picking = false;
    }
  }

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

  // Masquage manuel d'un sous-onglet (bouton œil). 'chat' (Conversation) n'est jamais masquable.
  const hidden = $derived(new Set(settings.subtabHidden || []));
  async function toggleSubtab(key) {
    if (key === 'chat') return;
    const next = new Set(settings.subtabHidden || []);
    next.has(key) ? next.delete(key) : next.add(key);
    await updateSettings({ subtabHidden: [...next] });
  }
  // Aperçu de la barre de sous-onglets : ordre configuré moins les masqués (l'auto-masquage d'un
  // onglet vide dépend d'une session → non simulé ici ; c'est un aperçu de la configuration).
  const previewSubtabs = $derived(order.filter((k) => SUBTAB_META[k] && !hidden.has(k)));

  // Barre de statut : lecture/bascule d'un élément + échantillons représentatifs pour l'aperçu.
  const sbOn = (k) => settings.statusBar?.[k] !== false;
  function toggleStatusBar(key) {
    updateSettings({ statusBar: { ...settings.statusBar, [key]: !sbOn(key) } });
  }
  // Ordre local des éléments de la barre de statut, resynchronisé depuis le store (comme les subtabs).
  let sbOrder = $state([...settings.statusBarOrder]);
  $effect(() => { sbOrder = [...settings.statusBarOrder]; });
  async function moveSb(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= sbOrder.length) return;
    const next = [...sbOrder];
    [next[i], next[j]] = [next[j], next[i]];
    sbOrder = next;            // optimiste
    await updateSettings({ statusBarOrder: next });
  }
  const SB_SAMPLE = {
    branch: 'main', stateBadge: '● waiting', permissionMode: 'Auto', modelEffort: 'opus · max',
    cost: '$1.20', prompts: '42 prompts', tokens: '128k out · 1.2M cache', model: 'opus',
    usage5h: '43%', prLinks: '🔗 hooked #18', issueLinks: '🐛 hooked #21', focusBtn: '⛶ Focus',
  };

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

  // ── Claude Code version (installed binary + outdated live sessions) ───────────────────────────
  // A session keeps running the version it started with: upgrading the binary doesn't touch live
  // sessions until they're restarted (kill + `claude --resume`). We surface which live sessions run
  // an older version than installed, let the user upgrade the binary (never sudo), and reconnect.
  let claude = $state(null);           // { install, installed, outdated } | { error }
  let claudeLoading = $state(false);
  let claudeStatus = $state('');
  let upgrading = $state(false);
  let restartingId = $state('');       // session id currently restarting (single-flight)
  let bulkBusy = $state(false);        // "Upgrade & reconnect all" in flight
  const restarted = $state(new Set()); // ids restarted this visit → filtered out (transcript version lags until it next writes)

  const outdatedRows = $derived((claude?.outdated || []).filter((r) => !restarted.has(r.id)));

  async function loadClaude() {
    claudeLoading = true;
    try {
      claude = await getClaudeVersion();
    } catch (e) {
      claude = { error: e.message || 'failed to load claude version' };
    }
    claudeLoading = false;
  }

  async function doUpgrade() {
    if (upgrading || !claude?.install) return;
    upgrading = true; claudeStatus = '⏳ upgrading…';
    const res = await upgradeClaude().catch((e) => ({ ok: false, data: { error: e.message } }));
    upgrading = false;
    if (res.ok) {
      claudeStatus = `✓ upgraded to ${res.data.installed}`;
      await loadClaude();
    } else if (res.data?.needsSudo) {
      claudeStatus = '✗ ' + (res.data.warning || 'upgrade needs elevated permissions');
    } else {
      claudeStatus = '✗ ' + (res.data?.warning || res.data?.error || 'upgrade failed');
    }
    setTimeout(() => { claudeStatus = ''; }, 6000);
  }

  // Restart one session so it picks up the installed version. A session that's actively working is
  // guarded behind a confirm (kill + resume loses in-memory state; the transcript is reloaded).
  async function doRestart(row) {
    if (restartingId || bulkBusy) return false;
    if (row.state === 'working' && !confirm(`“${row.projectName || row.id}” is working right now.\nRestart it? In-memory state is lost; the session resumes from its transcript.`)) return false;
    restartingId = row.id; claudeStatus = '';
    const res = await restartClaudeSession(row.id).catch((e) => ({ ok: false, data: { error: e.message } }));
    restartingId = '';
    if (res.ok) { restarted.add(row.id); claude = { ...claude }; return true; }
    claudeStatus = '✗ ' + (res.data?.error || 'restart failed');
    setTimeout(() => { claudeStatus = ''; }, 5000);
    return false;
  }

  // Upgrade the binary first (if possible), then reconnect every still-outdated session in sequence.
  async function doUpgradeAndReconnect() {
    if (bulkBusy || restartingId) return;
    bulkBusy = true;
    try {
      if (claude?.install?.upgrade && !claude.install.needsSudo) {
        claudeStatus = '⏳ upgrading…';
        const up = await upgradeClaude().catch((e) => ({ ok: false, data: { error: e.message } }));
        if (up.ok) { await loadClaude(); }
        else { claudeStatus = '✗ ' + (up.data?.warning || up.data?.error || 'upgrade failed'); bulkBusy = false; setTimeout(() => { claudeStatus = ''; }, 6000); return; }
      }
      const rows = [...(claude?.outdated || [])].filter((r) => !restarted.has(r.id));
      let done = 0;
      for (const r of rows) {
        claudeStatus = `⏳ reconnecting ${done + 1}/${rows.length}…`;
        const res = await restartClaudeSession(r.id).catch(() => ({ ok: false }));
        if (res.ok) { restarted.add(r.id); done++; }
      }
      claude = { ...claude };
      claudeStatus = `✓ reconnected ${done} session${done === 1 ? '' : 's'}`;
    } finally {
      bulkBusy = false;
      setTimeout(() => { claudeStatus = ''; }, 6000);
    }
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
  onMount(() => { loadGit(); loadClaude(); });

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
  <div class="set-wrap">
    <nav class="set-nav">
      <div class="set-nav-title">Settings</div>
      {#each NAV as n (n.id)}
        <a href="#{n.id}" class:active={activeSec === n.id} onclick={(e) => { e.preventDefault(); goTo(n.id); }}>{n.label}</a>
      {/each}
    </nav>

    <div class="settings">
    <h1>Settings</h1>
    <p class="lead">Persisted server-side (shared across browsers). More will be added as needed.</p>

    <div class="card" id="pset-appearance" data-sec>
      <h2>Theme</h2>
      <p class="hint">Interface appearance. (Per-browser preference.)</p>
      <div class="chips">
        {#each THEMES as t (t.key)}
          <button class="chip" class:active={ui.theme === t.key} onclick={() => setTheme(t.key)}>
            {t.icon} {t.label}
          </button>
        {/each}
      </div>

      <h2 style="margin-top:22px">Color scheme</h2>
      <p class="hint">Palette used for both light and dark. <strong>Legacy</strong> restores the previous warm cream / terracotta look. (Per-browser preference.)</p>
      <div class="chips">
        {#each SCHEMES as s (s.key)}
          <button class="chip" class:active={ui.scheme === s.key} onclick={() => setScheme(s.key)}>
            {s.icon} {s.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="card" id="pset-sidebar" data-sec>
      <h2>Inbox grouping</h2>
      <p class="hint">Group the sidebar sessions by project (repository / folder) with collapsible headers, instead of the status sections (Needs your reply / Working / Idle). The Active / Needs you / Working / All scope still applies. (Per-browser preference.)</p>
      <label class="check">
        <input type="checkbox" checked={ui.groupByProject} onchange={(e) => (ui.groupByProject = e.currentTarget.checked)} />
        <span>Group sessions by project</span>
      </label>
    </div>

    <div class="card" id="pset-new" data-sec>
      <h2>New session defaults</h2>
      <p class="hint">Model, reasoning effort and permission mode pre-selected when you start a new session or resume one. <strong>Inherit</strong> falls back to your Claude Code config (<code>~/.claude</code>).</p>
      <ModelEffort showMode allowInherit bind:model={defModel} bind:effort={defEffort} bind:mode={defMode} onchange={saveDefaults} />
    </div>

    <div class="card" id="pset-project" data-sec>
      <h2>Default project</h2>
      <p class="hint">Working directory used when a session is launched <strong>without</strong> a folder — e.g. from a macOS shortcut that posts to <code>/api/launch</code> with only a prompt. Leave empty to keep requiring an explicit folder.</p>
      <div class="cmd-row">
        <select class="cmd-input" value={quickProject} onchange={(e) => updateSettings({ quickLaunchProject: e.currentTarget.value })}>
          <option value="">— None —</option>
          {#each projs as [cwd, name] (cwd)}
            <option value={cwd}>{name} — {cwd}</option>
          {/each}
          {#if quickProject && !projs.some(([c]) => c === quickProject)}
            <option value={quickProject}>{quickProject}</option>
          {/if}
        </select>
        <button class="save" onclick={browseQuickProject} disabled={picking}>{picking ? '⏳' : '📂'} Browse…</button>
      </div>
    </div>

    <div class="card" id="pset-digest" data-sec>
      <h2>Daily digest</h2>
      <p class="hint">Generate an AI recap of the previous day's sessions each morning — see the <strong>Digest</strong> tab. Runs a headless <code>claude -p</code> pass. Manual generation from the tab always works, even with auto off.</p>
      <label class="check">
        <input type="checkbox" checked={settings.digest?.auto ?? true}
               onchange={(e) => updateSettings({ digest: { ...settings.digest, auto: e.currentTarget.checked } })} />
        <span>Generate yesterday's digest automatically each day</span>
      </label>
      <div class="cmd-row" style="margin-top:6px">
        <label class="dg-field">At
          <select class="dg-sel" value={String(settings.digest?.hour ?? 7)} disabled={!(settings.digest?.auto ?? true)}
                  onchange={(e) => updateSettings({ digest: { ...settings.digest, hour: parseInt(e.currentTarget.value, 10) } })}>
            {#each Array.from({ length: 24 }, (_, h) => h) as h}<option value={String(h)}>{String(h).padStart(2, '0')}:00</option>{/each}
          </select>
          local time
        </label>
        <label class="dg-field">Model
          <select class="dg-sel" value={settings.digest?.model ?? ''}
                  onchange={(e) => updateSettings({ digest: { ...settings.digest, model: e.currentTarget.value } })}>
            <option value="">Inherit (your default)</option>
            <option value="haiku">haiku</option>
            <option value="sonnet">sonnet</option>
            <option value="opus">opus</option>
          </select>
        </label>
      </div>
      <p class="hint" style="margin:12px 0 0">A cheaper model (e.g. <code>haiku</code>/<code>sonnet</code>) keeps daily cost low on busy days.</p>
    </div>

    <div class="card" id="pset-live" data-sec>
      <h2>Live state</h2>
      <p class="hint">Re-reads every session's tmux pane fresh to fix a stale status — e.g. a session stuck on “working” after it finished or after its terminal was closed.</p>
      <div class="cmd-row">
        <button class="save" onclick={doResync} disabled={resyncing}>{resyncing ? '⏳ Resyncing…' : '↻ Resync live states'}</button>
        {#if resyncStatus}<span class="status">{resyncStatus}</span>{/if}
      </div>
    </div>

    <div class="card" id="pset-claude" data-sec>
      <h2>Claude Code</h2>
      <p class="hint">A running session keeps the claude version it started with. Upgrading the binary doesn't touch live sessions until they restart — reconnecting resumes them from their transcript on the new version. In-memory state is lost by design.</p>

      {#if claudeLoading && !claude}
        <p class="hint">Loading…</p>
      {:else if claude?.error}
        <p class="hint">✗ {claude.error}</p>
      {:else if claude}
        <p class="hint" style="margin-bottom:12px">
          {#if claude.install?.method === 'absent'}
            <strong>claude not found on PATH</strong>
          {:else}
            Installed: <strong>{claude.installed || '(unknown)'}</strong>
            <span class="badge">{claude.install?.label || claude.install?.method || 'unknown'}</span>
            {#if claude.install?.real}<span class="path" title={claude.install.real}>{claude.install.real}</span>{/if}
          {/if}
        </p>

        {#if claude.install?.method !== 'absent'}
          {#if claude.install?.needsSudo}
            <div class="restart-notice">
              <span>🔒 Upgrade needs elevated permissions (install prefix not writable). Run <code>{claude.install.upgrade}</code> in a terminal.</span>
            </div>
          {:else if claude.install?.upgrade}
            <div class="cmd-row" style="margin-bottom:12px">
              <button class="save" onclick={doUpgrade} disabled={upgrading || bulkBusy}>{upgrading ? '⏳ Upgrading…' : '⬆ Upgrade claude'}</button>
              <span class="hint" style="margin:0"><code>{claude.install.upgrade}</code></span>
            </div>
          {:else}
            <p class="hint" style="margin-bottom:12px">Unknown install method — upgrade claude manually.</p>
          {/if}
        {/if}

        {#if outdatedRows.length}
          <div class="cmd-row" style="margin-bottom:10px">
            <strong style="font-size:13px">{outdatedRows.length} live session{outdatedRows.length === 1 ? '' : 's'} running an older version</strong>
            <button class="save" onclick={doUpgradeAndReconnect} disabled={bulkBusy || !!restartingId || upgrading}>{bulkBusy ? '⏳ Working…' : '⬆ Upgrade & reconnect all'}</button>
          </div>
          <ul class="reorder">
            {#each outdatedRows as row (row.id)}
              <li>
                <span class="ro-name">{row.projectName || row.id}</span>
                <span class="ver">{row.version} → {row.installed}</span>
                {#if row.state === 'working'}<span class="badge dirty">working</span>{/if}
                <span class="ro-actions">
                  <button class="mini wide" disabled={!!restartingId || bulkBusy} onclick={() => doRestart(row)}>
                    {restartingId === row.id ? '⏳' : '↻ Restart & reconnect'}
                  </button>
                </span>
              </li>
            {/each}
          </ul>
        {:else if claude.installed}
          <p class="hint" style="margin:0">✓ All live sessions are on the installed version.</p>
        {/if}
        {#if claudeStatus}<p class="status" style="margin:10px 0 0">{claudeStatus}</p>{/if}
      {/if}
    </div>

    <div class="card" id="pset-git" data-sec>
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

    <div class="card" id="pset-tags" data-sec>
      <h2>Tags</h2>
      <p class="hint">Tags live only through the sessions that carry them — deleting one removes it from every session and clears it from any active filter. This can't be undone.</p>
      {#if allTags().length}
        <ul class="taglist">
          {#each allTags() as t (t)}
            {@const n = tagUsage(t)}
            <li>
              <span class="pt-pill" style="--c:{tagColor(t)}"># {t}</span>
              <span class="tl-count">{n} session{n === 1 ? '' : 's'}</span>
              <span class="tl-actions">
                {#if confirmTag === t}
                  <button class="mini danger" onclick={() => removeTag(t)} title="Confirm deletion">Confirm</button>
                  <button class="mini" onclick={() => (confirmTag = null)} title="Cancel">Cancel</button>
                {:else}
                  <button class="mini" onclick={() => removeTag(t)} title="Delete tag" aria-label="Delete tag">🗑</button>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint tl-empty">No tags yet. Add tags to a session from its ⋯ menu in the sidebar.</p>
      {/if}
    </div>

    <div class="card" id="pset-interface" data-sec>
      <h2>Session status bar</h2>
      <p class="hint">Reorder the elements with ▲/▼ and toggle which ones appear in the session header. Click the eye to hide or show each one.</p>
      <ul class="reorder">
        {#each sbOrder as key, i (key)}
          <li class:row-off={!sbOn(key)}>
            <span class="ro-pos">{i + 1}</span>
            <span class="ro-name">{STATUS_BAR_META[key]?.label ?? key}</span>
            <span class="ro-actions">
              <button class="mini" disabled={i === 0} onclick={() => moveSb(i, -1)} title="Move up" aria-label="Move up">▲</button>
              <button class="mini" disabled={i === sbOrder.length - 1} onclick={() => moveSb(i, 1)} title="Move down" aria-label="Move down">▼</button>
              <button class="mini vis" class:off={!sbOn(key)} onclick={() => toggleStatusBar(key)}
                      title={sbOn(key) ? 'Shown — click to hide' : 'Hidden — click to show'}
                      aria-label="Toggle visibility">{sbOn(key) ? '👁' : '🚫'}</button>
            </span>
          </li>
        {/each}
      </ul>
      <div class="preview">
        <span class="preview-label">Preview</span>
        <div class="pv-statusbar">
          {#each sbOrder as key (key)}
            {#if sbOn(key)}<span class="pv-sb-item pv-sb-{key}">{SB_SAMPLE[key]}</span>{/if}
          {/each}
          {#if !sbOrder.some((k) => sbOn(k))}<span class="pv-empty">(all hidden)</span>{/if}
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Session subtabs</h2>
      <p class="hint">Reorder the subtabs (the first available one opens on arrival) and hide the ones you don't use. Conversation is always shown; tabs also auto-hide when empty.</p>
      <ul class="reorder">
        {#each order as key, i (key)}
          <li class:row-off={hidden.has(key)}>
            <span class="ro-pos">{i + 1}</span>
            <span class="ro-name">{SUBTAB_META[key]?.icon ?? '•'} {SUBTAB_META[key]?.label ?? key}</span>
            <span class="ro-actions">
              <button class="mini" disabled={i === 0} onclick={() => move(i, -1)} title="Move up" aria-label="Move up">▲</button>
              <button class="mini" disabled={i === order.length - 1} onclick={() => move(i, 1)} title="Move down" aria-label="Move down">▼</button>
              <button class="mini vis" class:off={hidden.has(key)} disabled={key === 'chat'}
                      onclick={() => toggleSubtab(key)}
                      title={key === 'chat' ? 'Always shown' : (hidden.has(key) ? 'Hidden — click to show' : 'Shown — click to hide')}
                      aria-label="Toggle visibility">{hidden.has(key) ? '🚫' : '👁'}</button>
            </span>
          </li>
        {/each}
      </ul>
      <div class="preview">
        <span class="preview-label">Preview</span>
        <div class="pv-subtabs">
          {#each previewSubtabs as key, i (key)}
            <span class="pv-subtab" class:active={i === 0}>{SUBTAB_META[key]?.icon} {SUBTAB_META[key]?.label ?? key}</span>
          {/each}
          {#if !previewSubtabs.length}<span class="pv-empty">(all hidden)</span>{/if}
        </div>
      </div>
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
  </div>
</section>

<style>
  #view-settings { overflow-y: auto; padding: 26px; }
  .set-wrap { display: flex; align-items: flex-start; gap: 32px; max-width: 1000px; margin: 0 auto; }
  .set-nav { position: sticky; top: 0; flex: 0 0 190px; width: 190px; display: flex; flex-direction: column; gap: 2px; padding-top: 40px; }
  .set-nav-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 6px 10px; }
  .set-nav a { display: block; padding: 7px 10px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--muted); text-decoration: none; transition: background .12s, color .12s; }
  .set-nav a:hover { color: var(--text); background: var(--hover); }
  .set-nav a.active { color: var(--accent); background: var(--accent-soft); }
  .settings { flex: 1; min-width: 0; max-width: 720px; }
  [data-sec] { scroll-margin-top: 16px; }
  h1 { font-size: 24px; font-weight: 800; letter-spacing: -.01em; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 22px 24px; margin-bottom: 20px; }
  h2 { font-size: 15px; font-weight: 800; margin: 0 0 4px; }
  @media (max-width: 780px) {
    .set-nav { display: none; }
    .settings { max-width: none; }
  }
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
  /* bouton œil (masquer/afficher) + lignes masquées + aperçus (sous-onglets & barre de statut). */
  .vis { font-size: 12px; }
  .vis.off { color: var(--muted); }
  .mini.vis:disabled { opacity: .3; }
  .row-off { opacity: .55; }
  .row-off .ro-name { text-decoration: line-through; }
  .preview { margin-top: 14px; padding: 12px; background: var(--bg2); border: 1px dashed var(--border2); border-radius: 8px; }
  .preview-label { display: block; font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin-bottom: 8px; }
  .pv-subtabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .pv-subtab { font-size: 12.5px; font-weight: 600; color: var(--muted); padding: 5px 10px; border-radius: 7px; white-space: nowrap; }
  .pv-subtab.active { color: var(--accent-d); background: var(--accent-soft); }
  .pv-statusbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
  .pv-sb-item { white-space: nowrap; }
  .pv-sb-branch { background: var(--bg3); border: 1px solid var(--border); border-radius: 5px; padding: 1px 7px; font-size: 11px; }
  .pv-sb-stateBadge { background: var(--bg3); border: 1px solid var(--border); border-radius: 20px; padding: 1px 8px; font-weight: 600; }
  .pv-sb-permissionMode, .pv-sb-modelEffort { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 1px 8px; }
  .pv-sb-cost { font-weight: 700; color: var(--text); }
  .pv-empty { font-size: 12px; color: var(--muted); font-style: italic; }
  /* Claude Code card: resolved binary path + running→installed version + wide restart button. */
  .path { display: inline-block; margin-left: 8px; font-size: 11px; color: var(--muted); max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle; }
  .ver { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .mini.wide { width: auto; padding: 0 12px; font-weight: 600; }
  .mini.danger { width: auto; padding: 0 12px; font-weight: 600; color: #b42318; border-color: #f0a99f; background: #fef3f2; }
  .mini.danger:hover:not(:disabled) { border-color: #d92d20; color: #b42318; }

  .taglist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .taglist li { display: flex; align-items: center; gap: 10px; padding: 6px 4px; border-bottom: 1px solid var(--border); }
  .taglist li:last-child { border-bottom: 0; }
  .taglist .pt-pill {
    font-family: var(--mono); font-size: 11px; font-weight: 600; line-height: 1.7;
    color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent);
    border-radius: 6px; padding: 1px 8px;
  }
  .dg-field { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted); }
  .dg-sel { background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 7px 10px; color: var(--text); font-size: 13px; font-family: inherit; }
  .dg-sel:focus { outline: none; border-color: var(--accent); }
  .dg-sel:disabled { opacity: .5; }
  .tl-count { color: var(--muted); font-size: 12px; }
  .tl-actions { margin-left: auto; display: flex; gap: 6px; }
  .tl-empty { margin: 0; }
</style>
