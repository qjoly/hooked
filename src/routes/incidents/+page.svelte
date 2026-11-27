<script>
  import Incidents from '#extensions/incidents/ui/Incidents.svelte';
  import ExtensionGate from '#lib/components/ExtensionGate.svelte';
</script>

<ExtensionGate id="incidents"><Incidents /></ExtensionGate>
