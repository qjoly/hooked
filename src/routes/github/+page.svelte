<script>
  import GitHub from '#extensions/github/ui/GitHub.svelte';
  import ExtensionGate from '#lib/components/ExtensionGate.svelte';
</script>

<div class="page"><ExtensionGate id="github"><GitHub /></ExtensionGate></div>

<style>
  /* The deck scrolls per column, so the page itself must not. */
  .page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
</style>
