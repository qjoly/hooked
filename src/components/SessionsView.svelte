<script>
  import { ui } from '../lib/state.svelte.js';
  import Sidebar from './Sidebar.svelte';
  import Overview from './Overview.svelte';
  import SessionDetail from './SessionDetail.svelte';
</script>

<div class="layout" class:has-detail={!!ui.currentSessionId}>
  <Sidebar />
  <div class="main-pane">
    {#if ui.currentSessionId}
      {#key ui.currentSessionId}
        <SessionDetail id={ui.currentSessionId} />
      {/key}
    {:else}
      <Overview />
    {/if}
  </div>
</div>
