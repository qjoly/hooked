<script>
  import Mcp from '$lib/components/Mcp.svelte';
</script>

<div class="page-scroll"><Mcp /></div>

<style>
  /* Mcp owns its inner layout but no scroll container of its own. */
  .page-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; width: 100%; }
</style>
