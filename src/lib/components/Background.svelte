<script>
  import { ago } from '$lib/format.js';
  // Jobs de fond ENCORE ACTIFS de la session (server/background.js → sessionDetail.bgJobs).
  // { kind:'bash'|'monitor'|'wakeup', taskId, command, description, startTs }
  let { jobs = [] } = $props();

  const KIND = {
    bash:    { icon: '⚙️', label: 'Background command' },
    monitor: { icon: '👁', label: 'Monitor (watcher)' },
    wakeup:  { icon: '⏰', label: 'Scheduled wakeup' },
  };
  const meta = (k) => KIND[k] || { icon: '🌀', label: k };
</script>

<div class="bg-list">
  {#if !jobs.length}
    <div class="pane-empty">No active background jobs.</div>
  {:else}
    <p class="bg-hint">🌀 This session's turn ended, but these background jobs are still running — they'll re-invoke Claude when they finish.</p>
    {#each jobs as j, i (j.taskId || j.command || i)}
      <div class="bg-item">
        <div class="bg-top">
          <span class="bg-kind">{meta(j.kind).icon} {meta(j.kind).label}</span>
          {#if j.taskId}<span class="bg-id">{j.taskId}</span>{/if}
          <span class="bg-ago">{ago(j.startTs)}</span>
        </div>
        {#if j.description}<div class="bg-desc">{j.description}</div>{/if}
        {#if j.command}<pre class="bg-cmd">{j.command}</pre>{/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .bg-list { display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
  .bg-hint { font-size: 12.5px; color: var(--muted); margin: 0 0 4px; }
  .bg-item {
    border: 1px solid var(--border); border-left: 3px solid var(--background);
    border-radius: 10px; background: var(--panel); padding: 10px 12px;
  }
  .bg-top { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .bg-kind { font-weight: 700; font-size: 13px; color: var(--text); }
  .bg-id { font-family: var(--mono); font-size: 10.5px; color: var(--muted); background: var(--bg3); border-radius: 6px; padding: 0 6px; }
  .bg-ago { margin-left: auto; font-size: 11px; color: var(--muted); }
  .bg-desc { margin-top: 6px; font-size: 13px; color: var(--text); }
  .bg-cmd {
    margin: 6px 0 0; padding: 8px 10px; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
  }
</style>
