<script>
  // Sessions space landing: reopen the LAST session you were on (ui.lastSessionId, persisted) —
  // "coming back to Sessions" means resuming where you left off, not starting from a blank canvas.
  // Falls back to the empty state (just the left sidebar) when there's no usable last session.
  import { goto } from '$app/navigation';
  import { ui, data } from '$lib/state.svelte.js';

  // Redirect once the session list is loaded (so a deleted/stale id doesn't 404 forever):
  // replaceState keeps Back working (it returns to wherever you came from, not to /sessions).
  $effect(() => {
    const last = ui.lastSessionId;
    if (!last || !data.sessions.length) return;
    if (data.sessions.some((s) => s.id === last)) {
      goto('/session/' + encodeURIComponent(last), { replaceState: true });
    }
  });
</script>

<div class="sessions-empty">
  <div class="se-inner">
    <div class="se-ico">🗂</div>
    <p>Pick a session on the left to open it.</p>
  </div>
</div>

<style>
  .sessions-empty { flex: 1 1 auto; min-height: 0; display: flex; align-items: center; justify-content: center; background: var(--panel); }
  .se-inner { text-align: center; color: var(--muted); }
  .se-ico { font-size: 34px; opacity: .5; margin-bottom: 8px; }
  .se-inner p { font-size: 13.5px; }
</style>
