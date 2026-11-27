<script>
  import { extensions, loadExtensionPage } from '#lib/extensions.svelte.js';
  import ExtensionGate from '#lib/components/ExtensionGate.svelte';

  let { data } = $props();
  const ext = $derived(extensions.list.find((e) => e.page?.key === data.key));
  const url = $derived(ext?.pageModule);
  let Page = $state(null);
  let failed = $state('');

  // Reloads when the server compiled a new version of the page (its URL carries the content key).
  $effect(() => {
    const u = url;
    Page = null;
    failed = '';
    if (!u) return;
    loadExtensionPage(u).then((c) => { if (u === url) Page = c; }).catch((e) => { failed = e.message || String(e); });
  });
</script>

<ExtensionGate id={ext?.id ?? data.key}>
  {#if failed}
    <p class="ext-msg">Could not load the {ext.label} page: {failed}</p>
  {:else if Page}
    <Page rest={data.rest} />
  {/if}
</ExtensionGate>

<style>
  .ext-msg { margin: 12vh auto 0; color: var(--danger); text-align: center; }
</style>
