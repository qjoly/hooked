<script>
  import { ui, closeModal } from '../lib/state.svelte.js';
  import CostModal from './CostModal.svelte';
  import ResumeModal from './ResumeModal.svelte';

  function onKey(e) { if (e.key === 'Escape') closeModal(); }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.modal}
  <div class="modal">
    <div class="modal-bg" onclick={closeModal}></div>
    <div class="modal-card">
      <button class="modal-close" onclick={closeModal}>✕</button>
      <div>
        {#if ui.modal.type === 'cost'}
          <CostModal />
        {:else if ui.modal.type === 'resume'}
          <ResumeModal r={ui.modal.data} />
        {/if}
      </div>
    </div>
  </div>
{/if}
