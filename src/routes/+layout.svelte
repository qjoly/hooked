<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ui, startLive, toggleFocus, toggleSidebarPeek, cycleTheme, toggleNotify, toggleNotifyPinnedOnly } from '$lib/state.svelte.js';
  import Modal from '$lib/components/Modal.svelte';
  import '../app.css';

  let { children } = $props();
  onMount(startLive);

  // Deep-links de session (`[label](/session/<id>)` rendus par autolink) : le routeur client
  // SvelteKit intercepte déjà le clic (nav interne, sans reload). On ajoute juste window.focus()
  // pour remonter la fenêtre au premier plan en multi-fenêtres — sans preventDefault, pour laisser
  // SvelteKit faire la navigation. Miroir du handler de clic des notifications (state.svelte.js).
  onMount(() => {
    const onClick = (e) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = e.target && e.target.closest && e.target.closest('a[data-session-link]');
      if (a) { try { window.focus(); } catch (_) {} }
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  });

  // Bouton de thème : cycle Système → Clair → Sombre. L'icône reflète le choix courant
  // (🖥️ = suit le système, ☀️ = clair forcé, 🌙 = sombre forcé).
  const THEME_UI = {
    system: { icon: '🖥️', label: 'System' },
    light:  { icon: '☀️', label: 'Light' },
    dark:   { icon: '🌙', label: 'Dark' },
  };
  const themeUi = $derived(THEME_UI[ui.theme] ?? THEME_UI.system);

  // Le header et la sidebar vivent dans deux layouts distincts ; <body> est leur ancêtre
  // commun → on reflète le mode focus sur body et tout le CSS focus s'y accroche.
  $effect(() => {
    document.body.classList.toggle('focus', ui.focus);
    document.body.classList.toggle('sidebar-peek', ui.focus && ui.sidebarPeek);
  });

  const onStats = $derived(page.url.pathname.startsWith('/stats'));
  const onSearch = $derived(page.url.pathname.startsWith('/search'));
  const onSettings = $derived(page.url.pathname.startsWith('/settings'));
  const onSessions = $derived(!onStats && !onSearch && !onSettings);
</script>

<header>
  <div class="brand">🪝 <span>hooked</span></div>
  <nav class="tabs">
    <a class="tab" class:active={onSessions} href="/">Sessions</a>
    <a class="tab" class:active={onSearch} href="/search">Search</a>
    <a class="tab" class:active={onStats} href="/stats">Stats &amp; usage</a>
    <a class="tab" class:active={onSettings} href="/settings">Settings</a>
  </nav>
  <!-- contrôles du mode focus, logés dans la barre globale (visibles seulement en focus,
       cf. CSS body.focus) : ré-ouvrir la sidebar (☰) et quitter le focus (✕). -->
  <div class="focus-ctl">
    <button class="focus-fab-btn" onclick={toggleSidebarPeek}
            title={ui.sidebarPeek ? 'Collapse sidebar' : 'Re-open sidebar'} aria-label="Toggle sidebar">☰</button>
    <button class="focus-fab-btn" onclick={toggleFocus} title="Exit focus mode" aria-label="Exit focus">✕</button>
  </div>
  <div class="status">
    <span class="dot" class:on={ui.live}></span>
    <span>{ui.live ? 'live' : 'reconnecting…'}</span>
  </div>
  <button class="theme-btn" onclick={toggleNotify}
          title={ui.notify ? 'Browser notifications: on — click to turn off' : 'Browser notifications: off — click to turn on (alerts when a session finishes or awaits your reply)'}
          aria-label="Toggle browser notifications">
    <span class="theme-ico">{ui.notify ? '🔔' : '🔕'}</span>
    <span class="theme-lbl">Notifs</span>
  </button>
  <button class="theme-btn"
          onclick={toggleNotifyPinnedOnly}
          disabled={!ui.notify}
          title={!ui.notify
            ? 'Enable notifications first'
            : ui.notifyPinnedOnly
              ? 'Notifying pinned sessions only — click to notify all'
              : 'Notifying all sessions — click to restrict to pinned only'}
          aria-label="Toggle pinned-only notifications">
    <span class="theme-ico">{ui.notifyPinnedOnly ? '📌' : '📍'}</span>
    <span class="theme-lbl">Pinned</span>
  </button>
  <button class="theme-btn" onclick={cycleTheme}
          title={`Theme: ${themeUi.label} — click to change`}
          aria-label={`Theme: ${themeUi.label}. Click to change theme.`}>
    <span class="theme-ico">{themeUi.icon}</span>
    <span class="theme-lbl">{themeUi.label}</span>
  </button>
</header>

<main>
  {@render children()}
</main>

<Modal />
