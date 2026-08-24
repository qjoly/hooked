<script>
  import { onMount } from 'svelte';
  import { ui, closeModal } from '$lib/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';
  import CostModal from './CostModal.svelte';
  import ResumeModal from './ResumeModal.svelte';
  import ForkModal from './ForkModal.svelte';
  import TrashModal from './TrashModal.svelte';
  import EditTagsModal from './EditTagsModal.svelte';
  import ConfirmModal from './ConfirmModal.svelte';

  let card;
  let prevFocus = null;

  function onKey(e) {
    if (e.key === 'Escape') { closeModal(); return; }
    if (e.key === 'Tab' && card) {
      const focusable = card.querySelectorAll('a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  $effect(() => {
    if (ui.modal) {
      prevFocus = document.activeElement;
      requestAnimationFrame(() => {
        // un [autofocus] explicite gagne (ex. bouton Confirm), sinon premier focusable
        const target = card?.querySelector('[autofocus]') || card?.querySelector('a[href],button:not([disabled]),textarea,input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])');
        target?.focus();
      });
    } else if (prevFocus) {
      prevFocus.focus?.();
      prevFocus = null;
    }
  });
</script>

<svelte:window onkeydown={onKey} />

{#if ui.modal}
  <div class="modal" role="dialog" aria-modal="true" aria-label={ui.modal.type}>
    <div class="modal-bg" onclick={closeModal}></div>
    <div class="modal-card" class:narrow={ui.modal.type === 'editTags' || ui.modal.type === 'confirm'} bind:this={card}>
      <button class="modal-close" onclick={closeModal} aria-label="Close"><Icon name="close" /></button>
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
