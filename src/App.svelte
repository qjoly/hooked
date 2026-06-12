<script>
  import { onMount } from 'svelte';
  import { ui, startLive } from './lib/state.svelte.js';
  import SessionsView from './components/SessionsView.svelte';
  import Stats from './components/Stats.svelte';
  import Modal from './components/Modal.svelte';

  onMount(startLive);
</script>

<header>
  <div class="brand">🪝 <span>hooked</span></div>
  <nav class="tabs">
    <button class="tab" class:active={ui.view === 'sessions'} onclick={() => (ui.view = 'sessions')}>Sessions</button>
    <button class="tab" class:active={ui.view === 'stats'} onclick={() => (ui.view = 'stats')}>Stats &amp; usage</button>
  </nav>
  <div class="status">
    <span class="dot" class:on={ui.live}></span>
    <span>{ui.live ? 'live' : 'reconnexion…'}</span>
  </div>
</header>

<main>
  {#if ui.view === 'sessions'}
    <section class="view active"><SessionsView /></section>
  {:else}
    <section id="view-stats" class="view active"><Stats /></section>
  {/if}
</main>

<Modal />
