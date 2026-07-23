<script>
  import { ui, closeModal } from '$lib/state.svelte.js';
  import CostModal from './CostModal.svelte';
  import ResumeModal from './ResumeModal.svelte';
  import ForkModal from './ForkModal.svelte';
  import TrashModal from './TrashModal.svelte';
  import EditTagsModal from './EditTagsModal.svelte';
  import ConfirmModal from './ConfirmModal.svelte';

  function onKey(e) { if (e.key === 'Escape') closeModal(); }
</script>

<svelte:window onkeydown={onKey} />

{#if ui.modal}
  <div class="modal">
    <div class="modal-bg" onclick={closeModal}></div>
    <div class="modal-card" class:narrow={ui.modal.type === 'editTags' || ui.modal.type === 'confirm'}>
      <button class="modal-close" onclick={closeModal}>✕</button>
      <div>
        {#if ui.modal.type === 'cost'}
          <CostModal />
        {:else if ui.modal.type === 'resume'}
          <ResumeModal r={ui.modal.data} />
        {:else if ui.modal.type === 'fork'}
          <ForkModal r={ui.modal.data} />
        {:else if ui.modal.type === 'trash'}
          <TrashModal />
        {:else if ui.modal.type === 'editTags'}
          <EditTagsModal r={ui.modal.data} />
        {:else if ui.modal.type === 'confirm'}
          <ConfirmModal r={ui.modal.data} />
        {/if}
      </div>
    </div>
  </div>
{/if}
