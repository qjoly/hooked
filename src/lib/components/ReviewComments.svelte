<script>
  // The review's comment lists, folded under the "Send N comments" button of the Ship / Branch
  // panels: the live comments first, the archived ones under them.
  //
  // Inline threads live IN the diff, so they are only visible while their file is the one on
  // screen: a comment left on a file scrolled past three files ago cannot be re-read, and the
  // only delete button (DiffView's ×) is anchored to it. This lists every thread of the review
  // at once — what it says, where it is anchored, whether it went out — with a click that jumps
  // straight to the thread in the diff (opens its file, scrolls the card into view, flashes it).
  //
  // ARCHIVING is the reviewer's "done", and the only way a comment leaves the diff. It used to
  // happen behind their back: the prompt told Claude to resolve each thread once the code was
  // fixed, so a review answered itself into an empty diff. An archived thread is not deleted —
  // it keeps its conversation, sits in the second list, and comes back with Restore.
  //
  // Deleting is two-step (× arms the row, "Delete?" confirms): unlike the inline × this list
  // also drops SENT threads, which may carry Claude's replies — a stray click there loses a
  // conversation, not a draft.
  import Icon from '$lib/components/Icon.svelte';

  // canJump: (thread) => bool — a thread carries the diff SECTION it was written on, and the
  // lens can only reveal the ones its own views produce (a Branch comment is unreachable from
  // Ship, and the reverse). Those rows say so instead of being a click that does nothing.
  let {
    threads = [],
    onDelete = null,
    onJump = null,
    canJump = null,
    onArchive = null,   // (id, archived) => void
  } = $props();

  let open = $state(false);
  let openArchive = $state(false);
  let armed = $state(null);  // thread id whose delete is armed
  let picked = $state(null); // last row jumped to — the list stays open, so it marks where you went

  const isArchived = (t) => t.status === 'archived';
  const live = $derived(threads.filter((t) => !isArchived(t)));
  const archived = $derived(threads.filter(isArchived));
  const pending = $derived(live.filter((t) => !t.sent).length);

  // Grouped per file (files in the order their first comment was left), pending first inside a
  // file — the pending ones are the batch the Send button ships.
  function groupsOf(list) {
    const by = new Map();
    for (const t of list) {
      if (!by.has(t.file)) by.set(t.file, []);
      by.get(t.file).push(t);
    }
    return [...by].map(([file, ofFile]) => ({
      file,
      name: file.split('/').pop(),
      list: [...ofFile].sort((a, b) => Number(!!a.sent) - Number(!!b.sent) || a.start - b.start),
    }));
  }

  const anchorLabel = (t) => (t.side === 'old' ? '−L' : '+L') + (t.start === t.end ? t.end : t.start + '–' + t.end);
  const firstText = (t) => (t.messages && t.messages[0]?.text) || '';

  function del(t) {
    if (armed !== t.id) { armed = t.id; return; }
    armed = null;
    onDelete?.(t.id);
  }
  // An archived thread is not in the diff, so there is nothing to jump to — that row is inert by
  // nature, on top of the cross-lens case `canJump` covers.
  const reachable = (t) => !isArchived(t) && (!canJump || canJump(t));
  // A jump can also fail on data: the file the thread points at may have left the diff it was
  // written on (committed since, branch rewritten). The lens answers false, and the row says so
  // for a few seconds — a click that visibly does nothing reads as a bug.
  let missed = $state(null);
  let missTimer = 0;
  async function jump(t) {
    armed = null;
    if (!reachable(t)) return;
    picked = t.id;
    clearTimeout(missTimer);
    missed = null;
    const landed = await onJump?.(t);
    if (landed === false) {
      missed = t.id;
      missTimer = setTimeout(() => { missed = null; }, 5000);
    }
  }
</script>

{#snippet rows(groups)}
  <div class="rc-list">
    {#each groups as g (g.file)}
      <div class="rc-file" title={g.file}>{g.name}</div>
      {#each g.list as t (t.id)}
        {@const here = reachable(t)}
        {@const arch = isArchived(t)}
        <div class="rc-row" class:archived={arch} class:picked={picked === t.id}>
          <!-- not `disabled`: a disabled button gets no mouse events, so its title — the only
               place that explains WHY the row is inert — would never show. -->
          <button class="rc-main" class:dead={!here} aria-disabled={!here} onclick={() => jump(t)}
                  title={arch ? 'Archived — restore it to see it in the diff again'
                         : !here ? 'Left in the other diff lens — open it there to read it in context'
                         : onJump ? 'Jump to this comment in ' + g.file : g.file}>
            <span class="rc-meta">
              <span class="rc-anchor">{anchorLabel(t)}</span>
              {#if !t.sent}<span class="rc-tag pending">{arch ? 'never sent' : 'pending'}</span>{/if}
              {#if !arch && !here}<span class="rc-tag other">other lens</span>
              {:else if missed === t.id}<span class="rc-tag gone">not in this diff</span>{/if}
              {#if t.messages && t.messages.length > 1}<span class="rc-n">{t.messages.length} msg</span>{/if}
            </span>
            <span class="rc-text">{firstText(t)}</span>
          </button>
          {#if armed === t.id}
            <span class="rc-confirm">
              <button class="rc-yes" onclick={() => del(t)} title="Delete this comment for good">Delete?</button>
              <button class="rc-no" onclick={() => (armed = null)} title="Keep it"><Icon name="close" size={11} /></button>
            </span>
          {:else}
            <span class="rc-acts">
              {#if onArchive}
                <button class="rc-act" onclick={() => onArchive(t.id, !arch)}
                        title={arch ? 'Restore — put it back in the diff' : 'Archive — take it out of the diff, keep the conversation'}>
                  <Icon name={arch ? 'unarchive' : 'archive'} size={12} />
                </button>
              {/if}
              {#if onDelete}
                <button class="rc-act del" onclick={() => del(t)} title="Delete this comment"><Icon name="trash" size={12} /></button>
              {/if}
            </span>
          {/if}
        </div>
      {/each}
    {/each}
  </div>
{/snippet}

{#if live.length}
  <div class="rc">
    <button class="rc-toggle" onclick={() => { open = !open; armed = null; }} aria-expanded={open}
            title={open ? 'Hide the comments' : 'Show every comment of this review'}>
      <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      {live.length} comment{live.length > 1 ? 's' : ''}
      <span class="rc-sub">{pending ? pending + ' pending' : 'all sent'}</span>
    </button>
    {#if open}{@render rows(groupsOf(live))}{/if}
  </div>
{/if}

{#if archived.length}
  <div class="rc">
    <button class="rc-toggle" onclick={() => { openArchive = !openArchive; armed = null; }} aria-expanded={openArchive}
            title={openArchive ? 'Hide the archived comments' : 'Show the comments taken out of the diff'}>
      <Icon name={openArchive ? 'chevron-down' : 'chevron-right'} size={13} />
      {archived.length} archived
      <span class="rc-sub">out of the diff</span>
    </button>
    {#if openArchive}{@render rows(groupsOf(archived))}{/if}
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
  .rc-row.archived { opacity: .6; }
  /* the row you last jumped from, so a list of near-identical comments stays navigable */
  .rc-row.picked { background: rgba(var(--accent-rgb), .09); box-shadow: inset 2px 0 0 var(--accent); }
  .rc-main {
    flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px;
    background: none; border: none; color: var(--text); font: inherit; text-align: left;
    padding: 4px 0; cursor: pointer;
  }
  .rc-main.dead { cursor: default; }
  .rc-meta { display: flex; align-items: center; gap: 6px; }
  .rc-anchor { font-family: var(--mono); font-size: 10px; color: var(--muted); }
  .rc-tag {
    display: inline-flex; align-items: center; gap: 3px; border-radius: 999px; padding: 0 6px;
    font-family: var(--mono); font-size: 9px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase;
  }
  .rc-tag.pending { background: rgba(var(--waiting-rgb), .16); color: var(--waiting); }
  .rc-tag.other { background: var(--input); color: var(--muted); }
  .rc-tag.gone { background: color-mix(in srgb, var(--warning, #c98a1b) 18%, transparent); color: var(--warning, #c98a1b); }
  .rc-n { font-family: var(--mono); font-size: 9.5px; color: var(--muted); }
  .rc-text {
    font-size: 12px; line-height: 1.4; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }

  /* Row actions stay invisible until the row is hovered or focused: two icons on every row of a
     30-comment list is noise, and the destructive one should not be the first thing you see. */
  .rc-acts { flex: 0 0 auto; display: flex; align-items: center; gap: 1px; margin-top: 3px; }
  .rc-act {
    background: none; border: none; border-radius: 6px; color: var(--muted); padding: 3px;
    cursor: pointer; opacity: 0;
  }
  .rc-row:hover .rc-act, .rc-act:focus-visible { opacity: 1; }
  .rc-act:hover { color: var(--text); background: var(--input); }
  .rc-act.del:hover { color: var(--danger); }
  .rc-confirm { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; margin-top: 3px; }
  .rc-yes {
    background: var(--danger); color: #fff; border: none; border-radius: 6px;
    font: inherit; font-size: 10.5px; font-weight: 800; padding: 3px 7px; cursor: pointer;
  }
  .rc-no { background: none; border: none; color: var(--muted); padding: 3px; cursor: pointer; border-radius: 6px; }
  .rc-no:hover { color: var(--text); background: var(--input); }
</style>
