<script>
  import { getTrash, restoreSession } from '$lib/api.js';
  import { loadSessions, ui } from '$lib/state.svelte.js';
  import { ago, fmtCost } from '$lib/format.js';

  let items = $state(null); // null = chargement en cours
  let busy = $state(null);  // id en cours de restauration

  async function load() {
    try {
      // Dédup par id : la corbeille peut contenir des doublons (même session supprimée deux fois,
      // ou deux entrées bin/) → un `{#each}` keyé planterait (each_key_duplicate) et figerait la
      // modale sur « Loading… ». On ne garde que la première occurrence de chaque id.
      const raw = (await getTrash()).trashed || [];
      const seen = new Set();
      items = raw.filter((t) => (t && t.id != null && !seen.has(t.id) ? (seen.add(t.id), true) : false));
    } catch { items = []; }
  }
  load();

  async function restore(it) {
    if (busy) return;
    busy = it.id;
    const res = await restoreSession(it.id).catch(() => ({ ok: false }));
    busy = null;
    if (res.ok) { items = items.filter((x) => x.id !== it.id); loadSessions(); ui.tick++; }
    else alert('✗ restore failed');
  }
</script>

<div class="trash">
  <div class="tr-head">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
    <div>
      <div class="tr-title">Trash</div>
      {#if items === null}
        <div class="tr-sub">Loading…</div>
      {:else if !items.length}
        <div class="tr-sub">Empty — deleted sessions land here and stay recoverable.</div>
      {:else}
        <div class="tr-sub">{items.length} session{items.length > 1 ? 's' : ''} — transcript kept in <code>bin/</code>, restorable anytime.</div>
      {/if}
    </div>
  </div>

  {#if items && items.length}
    <ul class="tr-list">
      {#each items as it (it.id)}
        <li class="tr-row">
          <div class="tr-main">
            <div class="tr-name">{it.title || it.firstPrompt || '(untitled)'}</div>
            <div class="tr-meta">{it.projectName || '?'} · deleted {ago(it.trashedAt)}{#if it.cost} · {fmtCost(it.cost)}{/if}</div>
          </div>
          <button class="tr-restore" disabled={busy === it.id} onclick={() => restore(it)}>
            {busy === it.id ? '…' : '↩ Restore'}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .tr-head { display: flex; align-items: flex-start; gap: 11px; margin-bottom: 16px; padding-right: 24px; color: var(--muted); }
  .tr-head > svg { margin-top: 2px; flex: 0 0 auto; }
  .tr-title { font-size: 16px; font-weight: 800; color: var(--text); }
  .tr-sub { font-size: 12.5px; color: var(--muted); margin-top: 2px; line-height: 1.5; }
  .tr-sub code { font-family: var(--mono); font-size: 11.5px; background: var(--code-inline); padding: 1px 5px; border-radius: 5px; }
  .tr-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow: auto; }
  .tr-row {
    display: flex; align-items: center; gap: 10px; padding: 10px 12px;
    background: var(--bg); border: 1px solid var(--border); border-radius: 11px;
  }
  .tr-main { min-width: 0; flex: 1; }
  .tr-name { font-size: 13.5px; font-weight: 700; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tr-meta { font-family: var(--mono); font-size: 11px; color: var(--muted); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tr-restore {
    flex: none; background: var(--chip); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600; white-space: nowrap;
    transition: background .12s, border-color .12s;
  }
  .tr-restore:hover:not(:disabled) { background: var(--hover); border-color: var(--accent); color: var(--accent); }
  .tr-restore:disabled { opacity: .5; cursor: default; }
</style>
