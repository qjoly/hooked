<script>
  // The review's comment list, folded under the "Send N comments" button of the Ship / Branch
  // panels.
  //
  // Inline threads live IN the diff, so they are only visible while their file is the one on
  // screen: a comment left on a file scrolled past three files ago cannot be re-read, and the
  // only delete button (DiffView's ×) is anchored to it. This lists every thread of the review
  // at once — what it says, where it is anchored, whether it went out — with a delete per row
  // and a click to jump to the file it belongs to.
  //
  // Deleting is two-step (× arms the row, "Delete?" confirms): unlike the inline × this list
  // also drops SENT threads, which may carry Claude's replies — a stray click there loses a
  // conversation, not a draft.
  import Icon from '$lib/components/Icon.svelte';

  let { threads = [], onDelete = null, onJump = null } = $props();

  let open = $state(false);
  let armed = $state(null); // thread id whose delete is armed

  // Grouped per file (files in the order their first comment was left), pending first inside a
  // file — the pending ones are the batch the Send button ships.
  const groups = $derived.by(() => {
    const by = new Map();
    for (const t of threads) {
      if (!by.has(t.file)) by.set(t.file, []);
      by.get(t.file).push(t);
    }
    return [...by].map(([file, list]) => ({
      file,
      name: file.split('/').pop(),
      list: [...list].sort((a, b) => Number(!!a.sent) - Number(!!b.sent) || a.start - b.start),
    }));
  });
  const pending = $derived(threads.filter((t) => !t.sent).length);

  const anchorLabel = (t) => (t.side === 'old' ? '−L' : '+L') + (t.start === t.end ? t.end : t.start + '–' + t.end);
  const firstText = (t) => (t.messages && t.messages[0]?.text) || '';

  function del(t) {
    if (armed !== t.id) { armed = t.id; return; }
    armed = null;
    onDelete?.(t.id);
  }
  function jump(t) {
    armed = null;
    onJump?.(t);
  }
</script>

{#if threads.length}
  <div class="rc">
    <button class="rc-toggle" onclick={() => { open = !open; armed = null; }} aria-expanded={open}
            title={open ? 'Hide the comments' : 'Show every comment of this review'}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      {threads.length} comment{threads.length > 1 ? 's' : ''}
      <span class="rc-sub">{pending ? pending + ' pending' : 'all sent'}</span>
    </button>

    {#if open}
      <div class="rc-list">
        {#each groups as g (g.file)}
          <div class="rc-file" title={g.file}>{g.name}</div>
          {#each g.list as t (t.id)}
            <div class="rc-row" class:resolved={t.status === 'resolved'}>
              <button class="rc-main" onclick={() => jump(t)} title={onJump ? 'Open ' + g.file : g.file}>
                <span class="rc-meta">
                  <span class="rc-anchor">{anchorLabel(t)}</span>
                  {#if !t.sent}<span class="rc-tag pending">pending</span>
                  {:else if t.status === 'resolved'}<span class="rc-tag done"><Icon name="check" size={10} /> resolved</span>{/if}
                  {#if t.messages && t.messages.length > 1}<span class="rc-n">{t.messages.length} msg</span>{/if}
                </span>
                <span class="rc-text">{firstText(t)}</span>
              </button>
              {#if onDelete}
                {#if armed === t.id}
                  <span class="rc-confirm">
                    <button class="rc-yes" onclick={() => del(t)} title="Delete this comment for good">Delete?</button>
                    <button class="rc-no" onclick={() => (armed = null)} title="Keep it"><Icon name="close" size={11} /></button>
                  </span>
                {:else}
                  <button class="rc-del" onclick={() => del(t)} title="Delete this comment"><Icon name="trash" size={12} /></button>
                {/if}
              {/if}
            </div>
          {/each}
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .rc { border-bottom: 1px solid var(--border); }
  .rc-toggle {
    display: flex; align-items: center; gap: 6px; width: 100%; background: none; border: none;
    color: var(--muted); font: inherit; font-size: 12px; font-weight: 700; text-align: left;
    padding: 9px 14px; cursor: pointer;
  }
  .rc-toggle:hover { color: var(--text); background: var(--hover); }
  .rc-sub { margin-left: auto; font-family: var(--mono); font-size: 10px; font-weight: 600; opacity: .8; }

  .rc-list { max-height: 320px; overflow-y: auto; padding-bottom: 6px; }
  .rc-file {
    position: sticky; top: 0; z-index: 1; background: var(--bg2);
    font-family: var(--mono); font-size: 10px; font-weight: 700; letter-spacing: .04em;
    color: var(--muted); padding: 5px 14px 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .rc-row { display: flex; align-items: flex-start; gap: 4px; padding: 0 8px 0 14px; }
  .rc-row:hover { background: var(--hover); }
  .rc-row.resolved { opacity: .55; }
  .rc-main {
    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px;
    background: none; border: none; color: var(--text); font: inherit; text-align: left;
    padding: 4px 0; cursor: pointer;
  }
  .rc-meta { display: flex; align-items: center; gap: 6px; }
  .rc-anchor { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .rc-tag {
    display: inline-flex; align-items: center; gap: 3px; border-radius: 999px; padding: 0 6px;
    font-family: var(--mono); font-size: 9px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
  }
  .rc-tag.pending { background: rgba(var(--waiting-rgb), .16); color: var(--waiting); }
  .rc-tag.done { background: color-mix(in srgb, var(--success) 16%, transparent); color: var(--success); }
  .rc-n { font-family: var(--mono); font-size: 9.5px; color: var(--muted); }
  .rc-text {
    font-size: 12px; line-height: 1.4; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  .rc-del {
    flex: 0 0 auto; margin-top: 4px; background: none; border: none; border-radius: 6px;
    color: var(--muted); padding: 3px; cursor: pointer; opacity: 0;
  }
  .rc-row:hover .rc-del, .rc-del:focus-visible { opacity: 1; }
  .rc-del:hover { color: var(--danger); background: var(--input); }
  .rc-confirm { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; margin-top: 3px; }
  .rc-yes {
    background: var(--danger); color: #fff; border: none; border-radius: 6px;
    font: inherit; font-size: 10.5px; font-weight: 800; padding: 3px 7px; cursor: pointer;
  }
  .rc-no { background: none; border: none; color: var(--muted); padding: 3px; cursor: pointer; border-radius: 6px; }
  .rc-no:hover { color: var(--text); background: var(--input); }
</style>
