<script>
  import Memory from '$lib/components/Memory.svelte';
</script>

<div class="page-scroll"><Memory /></div>

<style>
  /* Memory manages its own inner layout but has no scroll container of its own → give it one. */
  .page-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
</style>
