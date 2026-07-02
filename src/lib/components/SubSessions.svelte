<script>
  import SessionCard from './SessionCard.svelte';

  // Sessions que cette conversation a créées ou référencées : `[{ id, label, source }]` calculé
  // côté serveur (server/subSessions.js) et transporté dans le détail → reste vivant au tick SSE.
  // Chaque entrée est rendue en <SessionCard> (statut live depuis le store, repli fetch si absente).
  let { subSessions = [] } = $props();
</script>

{#if subSessions.length}
  <div class="subsessions">
    {#each subSessions as ss (ss.id)}
      <div class="ss-row">
        <SessionCard sessionId={ss.id} label={ss.label} />
        <span class="ss-source" title={ss.source === 'created' ? 'Started by this conversation' : 'Linked from this conversation'}>
          {ss.source === 'created' ? '✦ created' : '↗ referenced'}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="pane-empty">No sub-sessions created or referenced by this conversation.</div>
{/if}

<style>
  .subsessions { display: flex; flex-direction: column; gap: 8px; padding: 4px 2px; }
  .ss-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ss-source { font-size: 11px; color: var(--muted); white-space: nowrap; }
</style>
