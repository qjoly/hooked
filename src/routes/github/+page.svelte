<script>
  import GitHub from '$lib/components/GitHub.svelte';
</script>

<div class="page"><GitHub /></div>

<style>
  /* The deck scrolls per column, so the page itself must not. */
  .page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
</style>
