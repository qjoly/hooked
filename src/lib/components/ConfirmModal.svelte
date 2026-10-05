<script>
  import { closeModal } from '$lib/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';
  // r = { title, message?, confirmLabel?, confirmIcon?, cancelLabel?, danger?, onConfirm }
  let { r } = $props();
  function doConfirm() {
    const cb = r.onConfirm;
    closeModal();      // ferme d'abord, puis exécute (l'action peut naviguer, ex. delete → '/')
    if (typeof cb === 'function') cb();
  }
</script>

<div class="cf">
  <div class="cf-title">{r.title}</div>
  {#if r.message}<div class="cf-msg">{r.message}</div>{/if}
  <div class="cf-foot">
    <button class="cf-btn cf-cancel" onclick={closeModal}>{r.cancelLabel || 'Cancel'}</button>
    <!-- svelte-ignore a11y_autofocus -->
    <button class="cf-btn cf-confirm" class:danger={r.danger} autofocus onclick={doConfirm}>{#if r.confirmIcon}<Icon name={r.confirmIcon} size={14} tint={false} />{/if}{r.confirmLabel || 'Confirm'}</button>
  </div>
</div>

<style>
  .cf-title { font-size: var(--t-title); line-height: var(--lh-title); font-weight: 800; padding-right: 24px; }
  .cf-msg { font-size: var(--t-ui); color: var(--muted); line-height: 1.55; margin-top: 8px; white-space: pre-wrap; }
  .cf-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  .cf-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; border-radius: 9px; padding: 8px 16px; font: inherit; font-size: var(--t-ui); font-weight: 600; cursor: pointer; border: 1px solid transparent; }
  .cf-cancel { background: var(--chip); color: var(--text); border-color: var(--border); }
  .cf-cancel:hover { background: var(--hover); }
  .cf-confirm { background: var(--accent); color: var(--accent-fg); font-weight: 700; }
  .cf-confirm:hover { background: var(--accent-d); }
  .cf-confirm.danger { background: var(--danger); }
  .cf-confirm.danger:hover { filter: brightness(.93); }
</style>
