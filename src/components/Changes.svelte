<script>
  import Diff from './Diff.svelte';
  let { changes } = $props();
  let openSet = $state({}); // index -> bool
</script>

{#if !changes.length}
  <div class="pane-empty">Aucune modification de fichier dans cette session.</div>
{:else}
  {#each changes as c, i}
    <div class="change" class:open={openSet[i]}>
      <div class="change-head" title={c.file} onclick={() => (openSet = { ...openSet, [i]: !openSet[i] })}>
        <span class="ch-arrow">▸</span>
        <span class="ch-name">{c.name}</span>
        <span class="ch-path">{c.file}</span>
        <span class="ch-count">{c.count} {c.count > 1 ? 'modifs' : 'modif'}</span>
      </div>
      <div class="change-ops">
        {#each c.ops as o}<Diff {o} />{/each}
      </div>
    </div>
  {/each}
{/if}
