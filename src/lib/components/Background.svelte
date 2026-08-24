<script>
  import { tick, onDestroy } from 'svelte';
  import { ago } from '$lib/format.js';
  import { connectBackgroundLog } from '$lib/api.js';
  // Jobs de fond de la session (server/background.js → sessionDetail.bgJobs) : running + historique.
  // { kind:'bash'|'monitor'|'wakeup', taskId, command, description, startTs, outputPath, status }
  let { jobs = [], session } = $props();

  const KIND = {
    bash:     { icon: '⚙️', label: 'Background command' },
    monitor:  { icon: '👁', label: 'Monitor (watcher)' },
    wakeup:   { icon: '⏰', label: 'Scheduled wakeup' },
    subagent: { icon: '🤖', label: 'Sub-agent' },
  };
  const meta = (k) => KIND[k] || { icon: '🌀', label: k };

  // Statut d'un job (cf. jobStatus, server/background.js) → libellé + variable de couleur d'état.
  const STATUS = {
    running:   { label: 'Running',   var: 'background' },
    completed: { label: 'Completed', var: 'ended' },
    fired:     { label: 'Fired',     var: 'ended' },
    failed:    { label: 'Failed',    var: 'attention' },
    expired:   { label: 'Expired',   var: 'waiting' },
    stopped:   { label: 'Stopped',   var: 'waiting' },
    orphaned:  { label: 'Orphaned',  var: 'muted' },
  };
  const stat = (s) => STATUS[s] || { label: s || 'Running', var: 'muted' };

  // Actifs (en tête) vs terminés (repliés). Un job sans statut (payload legacy) est traité 'running'.
  const isActive = (j) => ['running', 'expired', 'orphaned'].includes(j.status || 'running');
  const active = $derived(jobs.filter(isActive));
  const finished = $derived(jobs.filter((j) => !isActive(j)));

  // Accordéon : un seul log ouvert à la fois (un seul EventSource vivant).
  let openId = $state(null);
  let logText = $state('');
  let logStatus = $state(''); // '' | 'connecting' | 'unavailable'
  let es = null;              // EventSource courant (non réactif)
  let decoder = null;         // TextDecoder (stream:true) pour recoller les octets UTF-8
  let logEl;                  // ref du <pre> scrollable
  let stick = true;           // coller au bas tant que l'utilisateur n'a pas scrollé vers le haut

  const b64ToText = (b64) => (b64 ? decoder.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), { stream: true }) : '');

  function close() {
    if (es) { try { es.close(); } catch (_) {} es = null; }
    decoder = null;
    openId = null;
    logText = '';
    logStatus = '';
  }
  function open(j) {
    close();
    openId = j.taskId;
    logStatus = 'connecting';
    stick = true;
    decoder = new TextDecoder();
    es = connectBackgroundLog({
      id: session,
      taskId: j.taskId,
      onSeed: (b64) => { logText = b64ToText(b64); logStatus = ''; scrollSoon(); },
      onData: (b64) => { logText += b64ToText(b64); logStatus = ''; scrollSoon(); },
      onUnavailable: () => { logStatus = 'unavailable'; },
    });
  }
  const toggle = (j) => (openId === j.taskId ? close() : open(j));

  async function scrollSoon() {
    await tick();
    if (stick && logEl) logEl.scrollTop = logEl.scrollHeight;
  }
  function onScroll() {
    if (!logEl) return;
    stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
  }

  // le job ouvert a disparu (session rafraîchie, job terminé) → on ferme proprement.
  $effect(() => { if (openId && !jobs.some((j) => j.taskId === openId)) close(); });
  onDestroy(close);
</script>

{#snippet jobItem(j, i)}
  <div class="bg-item">
    <div class="bg-top">
      <span class="bg-kind">{meta(j.kind).icon} {meta(j.kind).label}</span>
      <span class="bg-status" style="color: var(--{stat(j.status).var}); border-color: var(--{stat(j.status).var});">{stat(j.status).label}</span>
      {#if j.taskId}<span class="bg-id">{j.taskId}</span>{/if}
      <span class="bg-ago">{ago(j.startTs)}</span>
    </div>
    {#if j.description}<div class="bg-desc">{j.description}</div>{/if}
    {#if j.command}<pre class="bg-cmd">{j.command}</pre>{/if}
    {#if j.outputPath}
      <button class="bg-log-toggle" onclick={() => toggle(j)} aria-expanded={openId === j.taskId}>
        {openId === j.taskId ? '▾ Hide log' : '▸ View log'}
      </button>
    {:else}
      <div class="bg-nolog">no log available</div>
    {/if}
    {#if openId === j.taskId}
      <pre class="bg-log" bind:this={logEl} onscroll={onScroll}>{#if logStatus === 'unavailable'}(no log available){:else if logStatus === 'connecting' && !logText}connecting…{:else}{logText}{/if}</pre>
    {/if}
  </div>
{/snippet}

<div class="bg-list">
  {#if active.length}
    <p class="bg-hint">🌀 This session's turn ended, but these background jobs are still running — they'll re-invoke Claude when they finish.</p>
    {#each active as j, i (j.taskId || j.command || i)}
      {@render jobItem(j, i)}
    {/each}
  {:else}
    <div class="pane-empty">No active background jobs.</div>
  {/if}

  {#if finished.length}
    <details class="bg-finished">
      <summary>Finished ({finished.length})</summary>
      {#each finished as j, i (j.taskId || j.command || i)}
        {@render jobItem(j, i)}
      {/each}
    </details>
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
  /* pastille de statut : couleur d'état (var passée en inline style) sur fond transparent.
     Classe dédiée (pas `.badge`) pour n'hériter NI du `.badge { margin-left:auto }` global ni des
     `.s-<state> .badge { background }` (app.css) — sinon la couleur d'état de la SESSION bavait sur
     la pastille du job et le `margin-left:auto` la décalait au milieu de .bg-top. */
  .bg-status {
    font-size: 10px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
    border: 1px solid var(--muted); border-radius: 999px; padding: 1px 7px; line-height: 1.5;
  }
  .bg-finished { margin-top: 6px; }
  .bg-finished > summary {
    cursor: pointer; font-size: 12.5px; font-weight: 600; color: var(--muted);
    padding: 4px 2px; list-style-position: inside;
  }
  .bg-finished > summary:hover { color: var(--text); }
  .bg-finished[open] > summary { margin-bottom: 8px; }
  .bg-finished .bg-item { margin-bottom: 8px; }
  .bg-finished .bg-item:last-child { margin-bottom: 0; }
  .bg-ago { margin-left: auto; font-size: 11px; color: var(--muted); }
  .bg-desc { margin-top: 6px; font-size: 13px; color: var(--text); }
  .bg-cmd {
    margin: 6px 0 0; padding: 8px 10px; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 8px; font-family: var(--mono); font-size: 12px; color: var(--muted);
    white-space: pre-wrap; word-break: break-word; overflow-x: auto;
  }
  .bg-log-toggle {
    margin-top: 8px; background: none; border: none; padding: 0; cursor: pointer;
    font-size: 12px; font-weight: 600; color: var(--background); font-family: inherit;
  }
  .bg-log-toggle:hover { text-decoration: underline; }
  .bg-nolog { margin-top: 8px; font-size: 11.5px; color: var(--muted); font-style: italic; }
  /* mini-terminal : le tail live du .output */
  .bg-log {
    margin: 8px 0 0; padding: 8px 10px; max-height: 320px; overflow: auto;
    background: #0b0b0d; color: #d6d3cc; border: 1px solid var(--border); border-radius: 8px;
    font-family: var(--mono); font-size: 12px; line-height: 1.45;
    white-space: pre-wrap; word-break: break-word;
  }
</style>
