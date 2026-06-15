<script>
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { ui, startLive } from '$lib/state.svelte.js';
  import Modal from '$lib/components/Modal.svelte';
  import '../app.css';

  let { children } = $props();
  onMount(startLive);

  const onStats = $derived(page.url.pathname.startsWith('/stats'));
</script>

<header>
  <div class="brand">🪝 <span>hooked</span></div>
  <nav class="tabs">
    <a class="tab" class:active={!onStats} href="/">Sessions</a>
    <a class="tab" class:active={onStats} href="/stats">Stats &amp; usage</a>
  </nav>
  <div class="status">
    <span class="dot" class:on={ui.live}></span>
    <span>{ui.live ? 'live' : 'reconnexion…'}</span>
  </div>
</header>

<main>
  {@render children()}
</main>

<Modal />
