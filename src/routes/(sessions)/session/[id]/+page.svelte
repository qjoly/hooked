<script>
  import { page } from '$app/state';
  import SessionDetail from '$lib/components/SessionDetail.svelte';
</script>

{#key page.params.id}
  <SessionDetail id={page.params.id} />
{/key}
