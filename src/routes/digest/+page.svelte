<script>
  import Digest from '$lib/components/Digest.svelte';
</script>

<!-- Digest manages its own two-pane layout + inner scroll (`.digest { height:100% }`). -->
<div class="page-fill"><Digest /></div>

<style>
  .page-fill { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
  .page-fill > :global(*) { flex: 1 1 auto; min-height: 0; }
</style>
