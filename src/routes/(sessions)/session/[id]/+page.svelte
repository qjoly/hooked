<script>
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import {
    split, ui, data, sessionTitle, isSessionArchived, isIncognito, toggleIncognitoMode,
    splitPanes, anchorSplit, setPaneSession, closePane, splitRight, splitDown, canSplit,
  } from '$lib/state.svelte.js';
  import SessionDetail from '$lib/components/SessionDetail.svelte';
  import GroupTabs from '$lib/components/GroupTabs.svelte';
  import Icon from '$lib/components/Icon.svelte';

  const primary = $derived(page.params.id);
  // The anchor pane (col 0, row 0) always mirrors the route session.
  $effect(() => { const p = primary; untrack(() => anchorSplit(p)); });
  // remember the last visited session — the Sessions tab reopens it (persisted).
  $effect(() => { const p = primary; untrack(() => { if (p) ui.lastSessionId = p; }); });

  // Incognito : filtrer les LISTES ne suffit pas, un pane rend sa session par id — sans ce garde
  // la conversation privée reste affichée au moment même où on active le mode. Déclaratif à
  // dessein (pas de redirection) : rien à défaire, et ça se corrige tout seul quand ui.meta arrive.
  const hidden = (id) => !!(ui.incognito && id && !isIncognito(id));

  const cols = $derived(split.cols);
  const paneList = $derived(splitPanes());              // [{ id, col, row }]
  const isSplit = $derived(paneList.length > 1);

  // focused pane = keyboard target (only it reacts to the 1-4 lens keys / Esc). Follows the route.
  let focusedId = $state(primary);
  $effect(() => { primary; untrack(() => { focusedId = primary; }); });
  $effect(() => { const list = paneList.map((p) => p.id); untrack(() => { if (!list.includes(focusedId)) focusedId = primary; }); });

  // sessions offered in the per-pane picker: ACTIVE ones only (not archived/finished — the
  // all-time list made finding the right session impossible), most-recent first. Sessions
  // already shown in the grid still appear (so the current value stays selectable).
  const pickable = $derived.by(() => {
    const inGrid = new Set(paneList.map((p) => p.id));
    return data.sessions
      .filter((s) => inGrid.has(s.id) || !isSessionArchived(s))
      .sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  });
  function choosePane(col, row, id) {
    if (!id) return;
    if (col === 0 && row === 0) goto('/session/' + encodeURIComponent(id)); // anchor ↔ route
    else setPaneSession(col, row, id);
  }

  // ── compact detection: when each pane gets too narrow, hide the side menus (left sidebar + dock)
  let gridEl;
  $effect(() => {
    if (!gridEl || !isSplit) { ui.splitCompact = false; return; }
    const ro = new ResizeObserver(() => {
      const perPane = gridEl.clientWidth / Math.max(1, cols.length);
      ui.splitCompact = perPane < 560;
    });
    ro.observe(gridEl);
    return () => { ro.disconnect(); ui.splitCompact = false; };
  });

  // ── column resize (drag the vertical handle between two columns) ──
  function dragCol(e, i) {
    e.preventDefault();
    const rect = gridEl?.getBoundingClientRect();
    if (!rect) return;
    const total = rect.width || 1;
    const start = e.clientX;
    const a = cols[i].w ?? 1, b = cols[i + 1].w ?? 1, sum = a + b;
    const move = (ev) => {
      const frac = Math.max(0.15, Math.min(0.85, ((ev.clientX - start) / total) + a / sum));
      split.cols = cols.map((c, k) => k === i ? { ...c, w: sum * frac } : k === i + 1 ? { ...c, w: sum * (1 - frac) } : c);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // ── row resize (drag the horizontal handle between two rows inside a column) ──
  function dragRow(e, col, i, colEl) {
    e.preventDefault();
    const rect = colEl?.getBoundingClientRect();
    if (!rect) return;
    const total = rect.height || 1;
    const start = e.clientY;
    const rows = cols[col].rows;
    const a = rows[i].h ?? 1, b = rows[i + 1].h ?? 1, sum = a + b;
    const move = (ev) => {
      const frac = Math.max(0.15, Math.min(0.85, ((ev.clientY - start) / total) + a / sum));
      const nr = rows.map((r, k) => k === i ? { ...r, h: sum * frac } : k === i + 1 ? { ...r, h: sum * (1 - frac) } : r);
      split.cols = cols.map((c, k) => k === col ? { ...c, rows: nr } : c);
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
</script>

<div class="group-shell">
<GroupTabs id={primary} />
<div class="group-body">
{#if isSplit}
  <div class="split-grid" bind:this={gridEl}>
    {#each cols as c, ci (ci)}
      {@const colEl = { el: null }}
      <div class="split-col" style="flex-grow:{c.w ?? 1}">
        <div class="split-col-inner" bind:this={colEl.el}>
          {#each c.rows as r, ri (r.id ?? ('empty-' + ci + '-' + ri))}
            <div class="split-cell" style="flex-grow:{r.h ?? 1}"
                 class:focused={focusedId === r.id}
                 onpointerdowncapture={() => { if (r.id) focusedId = r.id; }}
                 role="group" tabindex="-1">
              <!-- pane toolbar : switch de session · split ↓ / → · fermer -->
              <div class="pane-bar">
                <select class="pane-pick" value={r.id ?? ''}
                        onchange={(e) => choosePane(ci, ri, e.currentTarget.value)}
                        title="Show another session in this pane">
                  {#if !r.id}<option value="" disabled selected>Pick a session…</option>{/if}
                  {#each pickable as s (s.id)}
                    <option value={s.id}>{sessionTitle(s)}</option>
                  {/each}
                </select>
                <span class="pane-bar-sp"></span>
                <button class="pane-btn" disabled={!canSplit()} title="Split down (vertical)"
                        onclick={() => splitDown(ci)} aria-label="Split down">▤</button>
                <button class="pane-btn" disabled={!canSplit()} title="Split right (horizontal)"
                        onclick={() => splitRight()} aria-label="Split right">▥</button>
                {#if !(ci === 0 && ri === 0)}
                  <button class="pane-btn close" title="Close this pane"
                          onclick={() => closePane(ci, ri)} aria-label="Close pane"><Icon name="close" /></button>
                {/if}
              </div>
              <div class="pane-body-wrap">
                {#if hidden(r.id)}
                  <div class="pane-empty">Hidden by incognito mode.</div>
                {:else if r.id}
                  {#key r.id}
                    <SessionDetail id={r.id} inSplit focused={focusedId === r.id} />
                  {/key}
                {:else}
                  <div class="pane-empty">Pick a session for this pane.</div>
                {/if}
              </div>
            </div>
            {#if ri < c.rows.length - 1}
              <!-- svelte-ignore a11y_no_static_element_interactions -->
              <div class="row-handle" onpointerdown={(e) => dragRow(e, ci, ri, colEl.el)} title="Drag to resize"></div>
            {/if}
          {/each}
        </div>
      </div>
      {#if ci < cols.length - 1}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="col-handle" onpointerdown={(e) => dragCol(e, ci)} title="Drag to resize"></div>
      {/if}
    {/each}
  </div>
{:else if hidden(primary)}
  <div class="incog-hidden">
    <p>This session wasn't started in incognito mode, so it stays hidden.</p>
    <button onclick={toggleIncognitoMode}>Leave incognito mode</button>
  </div>
{:else}
  {#key primary}
    <SessionDetail id={primary} />
  {/key}
{/if}
</div>
</div>

<style>
  .group-shell { display: flex; flex-direction: column; height: 100%; min-height: 0; min-width: 0; }
  .group-body { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; flex-direction: column; }
  .group-body > :global(*) { flex: 1 1 auto; min-height: 0; }
  .incog-hidden {
    flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 10px; color: var(--muted); font-size: var(--t-body); background: var(--panel);
  }
  .incog-hidden button {
    border: 1px solid var(--border); background: var(--bg2); color: var(--text);
    border-radius: 8px; padding: 6px 12px; font-size: var(--t-ui); cursor: pointer;
  }
  .split-grid { display: flex; height: 100%; min-height: 0; min-width: 0; }
  .split-col { display: flex; min-width: 0; flex: 1 1 0; }
  .split-col-inner { display: flex; flex-direction: column; min-height: 0; min-width: 0; flex: 1 1 auto; }
  .split-cell {
    display: flex; flex-direction: column; min-height: 0; min-width: 0; flex: 1 1 0;
    border: 1px solid transparent; border-radius: 2px; overflow: hidden;
  }
  .split-cell.focused { box-shadow: inset 0 2px 0 var(--accent); }

  /* pane toolbar */
  .pane-bar {
    flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 4px 6px;
    background: var(--bg2); border-bottom: 1px solid var(--border); min-width: 0;
  }
  .pane-pick {
    flex: 0 1 auto; min-width: 0; max-width: 60%; font: inherit; font-size: var(--t-meta); font-weight: 600;
    background: var(--input); border: 1px solid var(--border); border-radius: 7px; padding: 3px 7px; color: var(--text);
  }
  .pane-pick:focus { outline: none; border-color: var(--accent); }
  .pane-bar-sp { flex: 1 1 auto; }
  .pane-btn {
    flex: 0 0 auto; width: 24px; height: 24px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid var(--border2); background: transparent; color: var(--muted);
    border-radius: 6px; cursor: pointer; font-size: var(--t-meta); line-height: 1;
  }
  .pane-btn:hover:not(:disabled) { background: var(--hover); color: var(--text); border-color: var(--accent); }
  .pane-btn:disabled { opacity: .35; cursor: default; }
  .pane-btn.close:hover { color: var(--danger, #e5484d); border-color: var(--danger, #e5484d); }

  .pane-body-wrap { flex: 1 1 auto; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
  .pane-body-wrap > :global(*) { flex: 1 1 auto; min-width: 0; }
  .pane-empty { flex: 1 1 auto; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: var(--t-ui); }

  /* resize handles */
  .col-handle { flex: 0 0 6px; cursor: col-resize; background: var(--border); transition: background .12s; }
  .col-handle:hover { background: var(--accent); }
  .row-handle { flex: 0 0 6px; cursor: row-resize; background: var(--border); transition: background .12s; }
  .row-handle:hover { background: var(--accent); }
</style>
