<script>
  import GitHub from '#modules/github/ui/GitHub.svelte';
  import ModuleGate from '#lib/components/ModuleGate.svelte';
</script>

<div class="page"><ModuleGate id="github"><GitHub /></ModuleGate></div>

<style>
  /* The deck scrolls per column, so the page itself must not. */
  .page { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
</style>
