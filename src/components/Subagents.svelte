<script>
  import SubagentCard from './SubagentCard.svelte';
  let { subagents, session } = $props();
</script>

{#if !subagents.length}
  <div class="pane-empty">Aucun sous-agent lancé dans cette session.</div>
{:else}
  {#each subagents as a (a.id)}
    <SubagentCard {a} {session} />
  {/each}
{/if}
