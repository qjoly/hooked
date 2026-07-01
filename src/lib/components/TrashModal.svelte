<script>
  import { getTrash, restoreSession } from '$lib/api.js';
  import { loadSessions, ui } from '$lib/state.svelte.js';
  import { ago, fmtCost } from '$lib/format.js';

  let items = $state(null); // null = chargement en cours
  let busy = $state(null);  // id en cours de restauration

  async function load() {
    try { items = (await getTrash()).trashed || []; }
    catch { items = []; }
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
  <h2>🗑 Trash</h2>
  {#if items === null}
    <p class="muted">Loading…</p>
  {:else if !items.length}
    <p class="muted">The trash is empty. Deleted sessions land here and stay recoverable.</p>
  {:else}
    <p class="muted">{items.length} session{items.length > 1 ? 's' : ''} — transcript kept in <code>bin/</code>, restorable anytime.</p>
    <ul>
      {#each items as it (it.id)}
        <li>
          <div class="tl-main">
            <div class="tl-title">{it.title || it.firstPrompt || '(untitled)'}</div>
            <div class="tl-sub">{it.projectName || '?'} · deleted {ago(it.trashedAt)}{#if it.cost} · {fmtCost(it.cost)}{/if}</div>
          </div>
          <button class="tl-btn" disabled={busy === it.id} onclick={() => restore(it)}>
            {busy === it.id ? '…' : '↩ Restore'}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .trash h2 { margin: 0 0 10px; font-size: 1.1rem; }
  .muted { opacity: .7; font-size: .9rem; margin: 0 0 12px; }
  .trash ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; max-height: 60vh; overflow: auto; }
  .trash li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid rgba(128,128,128,.25); border-radius: 8px; }
  .tl-main { min-width: 0; flex: 1; }
  .tl-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tl-sub { font-size: .8rem; opacity: .65; margin-top: 2px; }
  .tl-btn { flex: none; background: transparent; border: 1px solid rgba(128,128,128,.4); border-radius: 6px; padding: 5px 10px; cursor: pointer; font: inherit; color: inherit; white-space: nowrap; }
  .tl-btn:hover:not(:disabled) { border-color: currentColor; }
  .tl-btn:disabled { opacity: .5; cursor: default; }
</style>
