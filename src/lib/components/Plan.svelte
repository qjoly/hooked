<script>
  import { untrack } from 'svelte';
  import Markdown from './Markdown.svelte';
  import { planAction } from '$lib/api.js';
  import { loadSessions, ui } from '$lib/state.svelte.js';

  // Plan proposed by Claude via ExitPlanMode, awaiting approval. Captured by the hooks
  // (the tool_use only enters the transcript once approved/rejected), rendered as markdown.
  // Review UI: select a passage → attach a comment; comments accumulate (persisted in
  // localStorage while reviewing); acting drives the TUI approval menu via /api/plan.
  let { id, pp } = $props();

  let planBody = $state(null);
  let comments = $state([]);
  let sel = $state(null);       // { text, top, left } current selection anchor for the ✎ button
  let drafting = $state(false);  // the comment textarea is open
  let draftText = $state('');
  let busy = $state(false);
  let status = $state('');

  const storageKey = $derived('hooked:plan-comments:' + id + ':' + (pp?.ts || ''));

  // (Re)load saved comments when the plan (key) changes. untrack the write so it isn't a dep.
  $effect(() => {
    const key = storageKey;
    untrack(() => {
      try { comments = JSON.parse(localStorage.getItem(key) || '[]'); } catch (_) { comments = []; }
    });
  });
  function persist() { try { localStorage.setItem(storageKey, JSON.stringify(comments)); } catch (_) {} }

  function onMouseUp() {
    const s = window.getSelection?.();
    if (!s || s.isCollapsed || !s.rangeCount) { if (!drafting) sel = null; return; }
    const range = s.getRangeAt(0);
    if (!planBody || !planBody.contains(range.commonAncestorContainer)) return;
    const text = s.toString().trim();
    if (!text) { if (!drafting) sel = null; return; }
    const r = range.getBoundingClientRect();
    sel = { text, top: r.top, left: r.left + r.width / 2 };
  }

  function openDraft() { drafting = true; draftText = ''; }
  // Commit the in-progress draft (if any) into the comments and close it. Shared by the explicit
  // "Add comment" button and by act() so a typed-but-not-yet-added draft is never silently dropped
  // on submit.
  function commitDraft() {
    const c = draftText.trim();
    if (drafting && sel && c) { comments = [...comments, { quote: sel.text, comment: c }]; persist(); }
    drafting = false; draftText = ''; sel = null;
  }
  function addComment() {
    if (!draftText.trim()) return;
    commitDraft();
    window.getSelection?.()?.removeAllRanges();
  }
  function cancelDraft() { drafting = false; draftText = ''; sel = null; }
  function removeComment(i) { comments = comments.filter((_, k) => k !== i); persist(); }

  // count including a pending (typed but not yet "Add"-ed) draft, so the button reflects reality.
  const fbCount = $derived(comments.length + ((drafting && sel && draftText.trim()) ? 1 : 0));

  function composeFeedback() {
    const blocks = comments.map(({ quote, comment }) => {
      const q = quote.split('\n').map((l) => '> ' + l).join('\n');
      return q + '\n' + comment;
    });
    return 'Feedback on the plan — please keep planning and revise:\n\n' + blocks.join('\n\n');
  }

  async function act(action) {
    if (busy) return;
    // flush a pending draft so a typed-but-not-added comment is included, not lost.
    if (action === 'keep-feedback') commitDraft();
    busy = true; status = '';
    const feedback = action === 'keep-feedback' ? composeFeedback() : '';
    const res = await planAction(id, action, feedback);
    busy = false;
    if (res.ok) {
      comments = []; try { localStorage.removeItem(storageKey); } catch (_) {}
      // the plan resolves server-side (PostToolUse clears livePlanForSession) → refresh the card away.
      setTimeout(() => { loadSessions(); ui.tick++; }, 400);
    } else {
      status = (res.data && res.data.error) || ('HTTP ' + res.status);
    }
  }
</script>

<svelte:window onmouseup={onMouseUp} />

<div class="plan-card">
  <div class="plan-head">
    <span class="plan-ico">📋</span>
    <span class="plan-title">Proposed plan — awaiting approval</span>
    <span class="plan-hint">select text to comment</span>
  </div>
  <div class="plan-body md" bind:this={planBody}><Markdown text={pp.plan} /></div>

  {#if comments.length}
    <div class="plan-comments">
      {#each comments as c, i}
        <div class="pc">
          <button class="pc-x" title="Remove comment" onclick={() => removeComment(i)}>✕</button>
          <blockquote class="pc-quote">{c.quote}</blockquote>
          <div class="pc-note">{c.comment}</div>
        </div>
      {/each}
    </div>
  {/if}

  {#if drafting && sel}
    <div class="plan-draft">
      <blockquote class="pc-quote">{sel.text}</blockquote>
      <textarea bind:value={draftText} placeholder="Comment on this passage…" rows="2"
        onkeydown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addComment(); if (e.key === 'Escape') cancelDraft(); }}></textarea>
      <div class="draft-actions">
        <button class="btn" onclick={addComment} disabled={!draftText.trim()}>Add comment</button>
        <button class="btn ghost" onclick={cancelDraft}>Cancel</button>
      </div>
    </div>
  {/if}

  <div class="plan-actions">
    <button class="btn approve" disabled={busy} onclick={() => act('approve')}>Approve</button>
    <button class="btn" disabled={busy} onclick={() => act('approve-auto')}>Approve + auto-accept</button>
    <button class="btn" disabled={busy} onclick={() => act('keep')}>Keep planning</button>
    {#if fbCount}
      <button class="btn feedback" disabled={busy} onclick={() => act('keep-feedback')}>
        Keep planning &amp; provide feedback ({fbCount})
      </button>
    {/if}
    {#if status}<span class="plan-status">{status}</span>{/if}
  </div>
</div>

{#if sel && !drafting}
  <button class="sel-comment" style="top:{sel.top - 34}px; left:{sel.left}px" onmousedown={(e) => e.preventDefault()} onclick={openDraft}>✎ Comment</button>
{/if}

<style>
  .plan-card {
    margin-top: 20px; padding: 16px 18px 14px; background: var(--surface);
    border: 1px solid rgba(176,90,52,.35); border-radius: 18px;
    box-shadow: var(--shadow); border-left: 4px solid var(--accent);
  }
  .plan-head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .plan-ico { font-size: 16px; }
  .plan-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent-d); }
  .plan-hint { margin-left: auto; font-size: 11px; color: var(--muted); font-style: italic; }
  .plan-body { font-size: 13.5px; line-height: 1.6; color: var(--text); word-wrap: break-word; overflow-wrap: anywhere; }
  /* le contenu markdown est injecté via {@html} → styliser avec :global (mêmes valeurs que .bubble .md) */
  .plan-body :global(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .plan-body :global(a:hover) { color: var(--accent-d); }
  .plan-body :global(code) { font-family: var(--mono); font-size: 12px; }
  .plan-body :global(:not(pre) > code) { background: var(--code-inline); padding: 1px 5px; border-radius: 5px; }
  .plan-body :global(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; max-width: 100%; }
  .plan-body :global(th), .plan-body :global(td) { border: 1px solid rgba(120,95,60,.28); padding: 4px 9px; text-align: left; vertical-align: top; }
  .plan-body :global(th) { background: rgba(120,95,60,.12); font-weight: 700; }
  .plan-body :global(blockquote) { margin: 6px 0; padding: 2px 0 2px 12px; border-left: 3px solid rgba(120,95,60,.38); color: var(--muted); }

  .plan-comments { margin-top: 14px; display: flex; flex-direction: column; gap: 8px; }
  .pc { position: relative; padding: 8px 10px; background: var(--code-inline); border-radius: 10px; border-left: 3px solid var(--accent); }
  .pc-x { position: absolute; top: 5px; right: 6px; border: none; background: none; color: var(--muted); cursor: pointer; font-size: 11px; line-height: 1; }
  .pc-x:hover { color: var(--accent-d); }
  .pc-quote { margin: 0 0 5px; padding: 0 0 0 9px; border-left: 2px solid rgba(120,95,60,.4); color: var(--muted); font-size: 12px; white-space: pre-wrap; }
  .pc-note { font-size: 13px; color: var(--text); white-space: pre-wrap; }

  .plan-draft { margin-top: 12px; padding: 10px; background: var(--code-inline); border-radius: 10px; }
  .plan-draft textarea { width: 100%; margin-top: 6px; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid rgba(120,95,60,.35); border-radius: 8px; background: var(--surface); color: var(--text); resize: vertical; box-sizing: border-box; }
  .draft-actions { display: flex; gap: 8px; margin-top: 6px; }

  .plan-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; }
  .btn { font: inherit; font-size: 12.5px; font-weight: 600; padding: 6px 12px; border-radius: 9px; border: 1px solid rgba(120,95,60,.35); background: var(--surface); color: var(--text); cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: var(--accent); }
  .btn:disabled { opacity: .5; cursor: default; }
  .btn.approve { background: var(--accent); color: #fff; border-color: var(--accent); }
  .btn.feedback { background: var(--accent-d); color: #fff; border-color: var(--accent-d); }
  .btn.ghost { background: none; }
  .plan-status { font-size: 12px; color: #c0392b; }

  .sel-comment { position: fixed; z-index: 40; transform: translateX(-50%); font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 8px; border: none; background: var(--accent-d); color: #fff; cursor: pointer; box-shadow: var(--shadow); }
</style>
