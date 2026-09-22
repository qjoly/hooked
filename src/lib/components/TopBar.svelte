<script>
  // Global top bar (redesign shell): spaces (Deck / Archive), omnibar trigger, account usage
  // gauges (5h / 7d / model-scoped), quick actions (notifications, theme, settings) and the primary
  // "+ Session" button. Replaces the old 14-icon left rail.
  import { page } from '$app/state';
  import { ui, data, settings, account, cycleTheme, toggleNotify, openModal, isArchived, snoozeUntil } from '$lib/state.svelte.js';
  import { getUsage } from '$lib/api.js';
  import { initials } from '$lib/format.js';
  import { NAV_TABS, NAV_KEYS, pageHref } from '$lib/nav.js';
  import Icon from '$lib/components/Icon.svelte';

  let { onOmnibar } = $props();

  const path = $derived(page.url.pathname);
  // The logo goes to the user's default page (same as cold start).
  const homeHref = $derived(pageHref(settings.defaultPage || 'deck'));
  const onDeck = $derived(path === '/');
  const onSettings = $derived(path.startsWith('/settings'));
  // Nav tabs the user chose to show (settings.navTabs). '/sessions' also lights up on /session/* & /new.
  const tabs = $derived(NAV_TABS.filter((t) => (settings.navTabs || NAV_KEYS).includes(t.key)));
  const tabActive = (t) => t.key === 'sessions'
    ? (path === '/sessions' || path.startsWith('/session/') || path.startsWith('/new'))
    : path.startsWith(t.href);

  // decisions badge: sessions awaiting a human decision (question / plan / permission / waiting).
  // A session snoozed from the Deck doesn't count — snoozing means "stop nagging me about it".
  // Minute clock so the badge comes back when a snooze expires, without waiting for a live tick.
  let nowMin = $state(Date.now());
  $effect(() => { const iv = setInterval(() => (nowMin = Date.now()), 30_000); return () => clearInterval(iv); });
  const decisions = $derived(
    data.sessions.filter((s) =>
      (s.hasQuestion || s.hasPlan || s.state === 'waiting' || s.state === 'attention')
      && !isArchived(s.id) && !(snoozeUntil(s.id) > nowMin)).length,
  );

  // Account rate-limit gauges (statusline snapshots + Claude Code usage cache). Refreshed on
  // every live tick.
  let usage = $state(null);
  $effect(() => {
    ui.tick;
    getUsage().then((u) => { usage = u; }).catch(() => {});
  });
  const g5 = $derived(usage?.account?.fiveHour?.pct ?? null);
  const g7 = $derived(usage?.account?.sevenDay?.pct ?? null);
  // Fable weekly bucket: model-scoped limit, only present on accounts that have one — no bucket,
  // no gauge (the 5h / 7d ones always apply). Comes from the account usage endpoint (or, if we
  // can't reach it, Claude Code's own cache), not the statusline — so it carries both its own reset
  // countdown and its own age. Age is worth showing: the cache fallback can be hours old, and a
  // frozen gauge that looks live is worse than one that says so.
  const fable = $derived(usage?.account?.fable ?? null);
  const src = $derived(usage?.account?.usage ?? null);
  const fableAge = $derived(fable?.at ? Math.max(0, Math.round((nowMin - Date.parse(fable.at)) / 60000)) : null);
  const fableStale = $derived(fableAge != null && fableAge >= 10);
  const barW = (pct) => Math.max(0, Math.min(100, pct || 0));
  const resetHint = (min) => (min == null ? '' : ` — resets in ${min >= 60 ? Math.round(min / 60) + 'h' : min + 'm'}`);
  const ageHint = $derived(fableAge == null ? ''
    : `\n${src?.source === 'live' ? 'live' : 'from Claude Code cache'} — ${fableAge < 1 ? 'just now' : fableAge + 'min ago'}`
      + (src?.error ? ` (live fetch: ${src.error})` : ''));

  const themeLabel = $derived({ system: 'System', light: 'Light', dark: 'Dark' }[ui.theme] ?? 'System');
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
  const avatarInitials = $derived(initials(account.displayName, account.email));
  const avatarTitle = $derived(
    (account.displayName || account.email || 'Account')
    + (account.organizationName ? ` — ${account.organizationName}` : '')
    + '\n' + (ui.live ? 'Live — connected' : 'Reconnecting…'),
  );
</script>

<header class="topbar">
  <a class="tb-logo" href={homeHref} title="hooked — home" aria-label="Home">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-9-5.2M6 16a6 6 0 0 0 9 5.2"/><circle cx="12" cy="12" r="3"/></svg>
  </a>

  <nav class="tb-spaces" aria-label="Spaces">
    <a class="tb-space" class:on={onDeck} href="/">
      <Icon name="deck" size={14} /> Deck
      {#if decisions > 0}<span class="tb-badge" title="{decisions} decision{decisions > 1 ? 's' : ''} awaiting you">{decisions}</span>{/if}
    </a>
    {#each tabs as t (t.key)}
      <a class="tb-space" class:on={tabActive(t)} href={t.href} style={t.tint ? `--tab-tint:${t.tint}` : null}><Icon name={t.icon} size={14} /> {t.label}</a>
    {/each}
  </nav>

  <button class="tb-omni" onclick={() => onOmnibar && onOmnibar()} title="Search, launch, command…">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <span class="tb-omni-ph">Search, launch, command…</span>
    <kbd>{isMac ? '⌘' : 'Ctrl'}P</kbd>
  </button>

  <!-- `crit` (>=90%) is a second threshold above `warn` (>=75%). Only the datadog scheme styles
       it (app.css); everywhere else it is an inert class, so nothing changes visually. -->
  <div class="tb-gauges" title="Account rate limits">
    <div class="tb-gauge" class:warn={g5 != null && g5 >= 75} class:crit={g5 != null && g5 >= 90}>
      <div class="tb-g-lbl"><span>5H</span><span>{g5 != null ? g5 + '%' : '—'}</span></div>
      <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(g5)}%"></div></div>
    </div>
    <div class="tb-gauge" class:warn={g7 != null && g7 >= 75} class:crit={g7 != null && g7 >= 90}>
      <div class="tb-g-lbl"><span>7J</span><span>{g7 != null ? g7 + '%' : '—'}</span></div>
      <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(g7)}%"></div></div>
    </div>
    {#if fable}
      <div class="tb-gauge" class:warn={fable.pct != null && fable.pct >= 75} class:crit={fable.pct != null && fable.pct >= 90} class:stale={fableStale}
           title="{fable.label} weekly limit{resetHint(fable.resetInMin)}{ageHint}">
        <div class="tb-g-lbl"><span>FABLE</span><span>{fable.pct != null ? fable.pct + '%' : '—'}</span></div>
        <div class="tb-g-track"><div class="tb-g-fill" style="width:{barW(fable.pct)}%"></div></div>
      </div>
    {/if}
  </div>

  <div class="tb-actions">
    <button class="tb-icon" class:on={ui.notify} onclick={toggleNotify} aria-label="Toggle notifications"
            title={ui.notify ? 'Notifications: on' : 'Notifications: off'}>
      {#if ui.notify}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.4 4 .9 5.3M18 8c0 7 3 9 3 9H7M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
      {/if}
    </button>
    <button class="tb-icon" onclick={cycleTheme} title={`Theme: ${themeLabel}`} aria-label={`Theme: ${themeLabel}`}>
      {#if ui.theme === 'light'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
      {:else if ui.theme === 'dark'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/></svg>
      {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      {/if}
    </button>
    <button class="tb-icon" onclick={() => openModal('trash')} title="Trash — deleted sessions (recoverable)" aria-label="Trash">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    </button>
    <a class="tb-icon" class:active={onSettings} href="/settings" title="Settings" aria-label="Settings">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
  </div>

  <a class="tb-new" href="/new"><Icon name="plus" size={14} /> Session</a>
  <button class="tb-avatar" class:live={ui.live} title={avatarTitle} aria-label="Account" onclick={() => openModal('account')}>
    {avatarInitials}
  </button>
</header>

<style>
  /* Onglets « console » : pleine hauteur de la barre, actif souligné 2px — pas de boîte
     segmentée arrondie autour des espaces. */
  .topbar {
    flex: 0 0 auto; display: flex; align-items: stretch; gap: 12px;
    padding: 0 14px 0 0; background: var(--bg2); border-bottom: 1px solid var(--border);
    min-height: 44px;
  }
  :global(body.focus) .topbar { display: none; }

  .tb-logo {
    width: 44px; align-self: stretch; border-radius: 0; background: transparent; color: var(--accent);
    border-right: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center; flex: 0 0 auto; text-decoration: none;
  }
  .tb-logo:hover { background: var(--hover); }

  .tb-spaces { display: flex; gap: 0; background: transparent; border: none; padding: 0; flex: 0 0 auto; align-items: stretch; }
  .tb-space {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 0 13px; border-radius: 0; font-size: 12.5px; font-weight: 600;
    color: var(--muted); text-decoration: none; white-space: nowrap;
    box-shadow: inset 0 -2px 0 transparent; transition: color .12s, box-shadow .12s;
  }
  .tb-space:hover { color: var(--text); }
  /* Active tab: icon + underline pick the tab's tint (nav.js), accent when it has none. */
  .tb-space.on { background: transparent; color: var(--text); box-shadow: inset 0 -2px 0 var(--tab-tint, var(--accent)); }
  .tb-space.on :global(svg) { color: var(--tab-tint, var(--accent)); }
  .tb-badge {
    min-width: 16px; height: 16px; padding: 0 4px; border-radius: 9px;
    background: var(--attention); color: #fff; font-size: 10px; font-weight: 800;
    display: inline-flex; align-items: center; justify-content: center;
  }

  .tb-omni {
    align-self: center;
    flex: 1 1 auto; max-width: 430px; min-width: 0;
    display: flex; align-items: center; gap: 9px; padding: 7px 12px;
    background: var(--input); border: 1px solid var(--border); border-radius: 10px;
    color: var(--muted); font: inherit; font-size: 12.5px; cursor: pointer; text-align: left;
    transition: border-color .12s, box-shadow .12s;
  }
  .tb-omni:hover { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .tb-omni-ph { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .tb-omni kbd {
    font: 10.5px/1 var(--mono); color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border2); border-radius: 4px; padding: 2px 6px;
  }

  .tb-gauges { display: flex; gap: 12px; margin-left: auto; flex: 0 0 auto; align-self: center; }
  .tb-gauge { display: flex; flex-direction: column; gap: 3px; width: 82px; }
  .tb-g-lbl {
    display: flex; justify-content: space-between;
    font-family: var(--mono); font-size: 9px; color: var(--muted); letter-spacing: .05em;
    font-variant-numeric: tabular-nums;
  }
  .tb-g-track { height: 4px; border-radius: 2px; background: var(--bg3); overflow: hidden; }
  .tb-g-fill { height: 100%; border-radius: 2px; background: var(--accent); transition: width .3s ease; }
  .tb-gauge.warn .tb-g-fill { background: var(--waiting); }
  /* Stale bucket (source older than 10 min): dimmed + hatched, so a frozen number never
     passes for a live one. The tooltip says how old and why. */
  .tb-gauge.stale { opacity: .55; }
  .tb-gauge.stale .tb-g-fill {
    background-image: repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,.35) 2px 4px);
  }

  .tb-actions { display: flex; gap: 2px; flex: 0 0 auto; align-self: center; }
  .tb-icon {
    width: 32px; height: 32px; border-radius: 9px; border: none; background: transparent;
    display: flex; align-items: center; justify-content: center; color: var(--muted);
    cursor: pointer; padding: 0; text-decoration: none; transition: background .12s, color .12s;
  }
  .tb-icon:hover { background: var(--hover); color: var(--text); }
  .tb-icon.on { color: var(--accent); }
  .tb-icon.active { background: var(--accent-soft); color: var(--accent); }

  .tb-new {
    align-self: center;
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px;
    background: var(--accent); color: var(--accent-fg); border-radius: 9px;
    padding: 7px 13px; font-size: 12.5px; font-weight: 700; text-decoration: none;
    transition: background .12s; white-space: nowrap;
  }
  .tb-new:hover { background: var(--accent-d); }

  .tb-avatar {
    align-self: center;
    position: relative; width: 30px; height: 30px; border-radius: 50%; flex: 0 0 auto;
    background: var(--chip); color: var(--muted); border: none; font: inherit; padding: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 10.5px; font-weight: 700; letter-spacing: .02em;
    transition: background .12s, color .12s;
  }
  .tb-avatar:hover { background: var(--hover); color: var(--text); }
  .tb-avatar::after {
    content: ""; position: absolute; bottom: -1px; right: -1px; width: 9px; height: 9px; border-radius: 50%;
    background: var(--idle); border: 2px solid var(--bg2);
  }
  .tb-avatar.live::after { background: var(--success); }

  @media (max-width: 900px) {
    .tb-gauges, .tb-omni kbd { display: none; }
    .tb-omni { max-width: none; }
  }
  @media (max-width: 640px) {
    .tb-actions { display: none; }
    .topbar { gap: 8px; padding: 8px 10px; }
  }
</style>
