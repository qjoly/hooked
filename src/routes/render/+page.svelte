<script>
  // A markdown file of the review, rendered on its own (opened in a new tab from the Review lens).
  // The bytes come from /api/session/source, so the same confinement applies (session repos only).
  import { page } from '$app/state';
  import { getSource } from '$lib/api.js';
  import Markdown from '$lib/components/Markdown.svelte';

  const q = page.url.searchParams;
  const id = q.get('id') || '';
  const file = q.get('file') || '';
  const rev = q.get('rev') || '';
  let text = $state(null);
  let error = $state('');

  // readSlice serves 400-line windows: walk them until the end of the file.
  async function load() {
    const lines = [];
    for (let from = 1; ; ) {
      const r = await getSource(id, file, rev, from, from + 399);
      if (!r || !r.supported) throw new Error('File not readable from this session.');
      lines.push(...r.lines);
      if (r.to >= r.total) break;
      from = r.to + 1;
    }
    text = lines.join('\n');
  }
  load().catch((e) => { error = e.message || String(e); });
</script>

<svelte:head><title>{file.split('/').pop() || 'Markdown'}</title></svelte:head>

<div class="rd"><div class="rd-in">
  <div class="rd-path" title={file}>{file}{rev ? ` @ ${rev.slice(0, 8)}` : ''}</div>
  {#if error}
    <p class="rd-msg">{error}</p>
  {:else if text === null}
    <p class="rd-msg">Loading…</p>
  {:else}
    <div class="md md-doc"><Markdown {text} breaks={false} /></div>
  {/if}
</div></div>

<style>
  .rd { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .rd-in { max-width: 860px; margin: 0 auto; padding: 24px 32px 64px; font-size: var(--t-body); line-height: 1.6; color: var(--text); }
  .rd-path { color: var(--muted); font-family: var(--mono); font-size: var(--t-micro); margin-bottom: 16px; word-break: break-all; }
  .rd-msg { color: var(--muted); font-style: italic; }
</style>
