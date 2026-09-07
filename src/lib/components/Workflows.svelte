<script>
  // Runs de workflow de la session (sessionDetail.workflows), le plus récent d'abord.
  import WorkflowCard from './WorkflowCard.svelte';
  let { workflows = [], session } = $props();
</script>

{#if !workflows.length}
  <div class="pane-empty">No workflow launched in this session.</div>
{:else}
  <div class="wf-list">
    {#each workflows as w (w.runId)}
      <WorkflowCard {w} {session} />
    {/each}
  </div>
{/if}

<style>
  .wf-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
</style>
