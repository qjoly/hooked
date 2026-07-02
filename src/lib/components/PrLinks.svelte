<script>
  import { prLabel } from '$lib/format.js';
  let { prLinks = [] } = $props();
</script>

{#if prLinks.length}
  <ul class="pr-list">
    {#each prLinks as url (url)}
      <li class="pr-row">
        <a class="pr-link" href={url} target="_blank" rel="noopener"
           onclick={(e) => e.stopPropagation()}>
          <span class="pr-label">{prLabel(url)}</span>
          <span class="pr-url">{url}</span>
        </a>
      </li>
    {/each}
  </ul>
{:else}
  <div class="pane-empty">No linked pull requests.</div>
{/if}

<style>
  .pr-list {
    list-style: none;
    margin: 0;
    padding: 0.75rem 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .pr-row {
    display: flex;
  }
  .pr-link {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    background: var(--bg2);
    text-decoration: none;
    border: 1px solid var(--border);
    transition: background 0.15s;
    min-width: 0;
  }
  .pr-link:hover {
    background: var(--bg3);
  }
  .pr-label {
    font-weight: 600;
    font-size: 0.875rem;
    color: var(--fg);
  }
  .pr-url {
    font-size: 0.75rem;
    color: var(--fg2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
