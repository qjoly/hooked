<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ui, startLive, toggleFocus, toggleSidebarPeek, cycleTheme, toggleNotify } from '$lib/state.svelte.js';
  import Modal from '$lib/components/Modal.svelte';
  import '../app.css';

  let { children } = $props();
  onMount(startLive);

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

<!-- pastille flottante visible uniquement en mode focus (cf. CSS body.focus) : ré-ouvrir la
     sidebar (☰) et quitter le focus (✕), accessibles depuis n'importe quelle page. -->
<div class="focus-fab">
  <button class="focus-fab-btn" onclick={toggleSidebarPeek}
          title={ui.sidebarPeek ? 'Collapse sidebar' : 'Re-open sidebar'} aria-label="Toggle sidebar">☰</button>
  <button class="focus-fab-btn" onclick={toggleFocus} title="Exit focus mode" aria-label="Exit focus">✕</button>
</div>

<Modal />
