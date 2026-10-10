<script>
  // Manual grouping, the keyboard-friendly twin of drag-and-drop. Two modes:
  //   - move ({ sessionId }) : pick the group the session should join (any other group, lone
  //     sessions included — joining one makes it the mother of a new group), or detach it;
  //   - add ({ groupId })    : pick an existing session to bring into this group.
  import {
    data, closeModal, sessionTitle, isSessionArchived, groupMotherOf, groupSessions, groupName,
    isGrouped, joinGroup, leaveGroup,
  } from '$lib/state.svelte.js';
  import Icon from '$lib/components/Icon.svelte';

  let { r } = $props(); // { mode: 'move', sessionId } | { mode: 'add', groupId }

  let q = $state('');
  const byRecent = (a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
  const matches = (text) => !q.trim() || text.toLowerCase().includes(q.trim().toLowerCase());

  const session = $derived(r.mode === 'move' ? data.sessions.find((s) => s.id === r.sessionId) : null);
  const ownMother = $derived(groupMotherOf(r.mode === 'move' ? r.sessionId : r.groupId));

  // move: one row per group (its mother), other groups only, active ones.
  const groups = $derived.by(() => {
    if (r.mode !== 'move') return [];
    const seen = new Set();
    const out = [];
    for (const s of data.sessions.slice().sort(byRecent)) {
      const m = groupMotherOf(s.id);
      if (m === ownMother || seen.has(m)) continue;
      const members = groupSessions(m);
      if (!members.length || members.every(isSessionArchived)) continue;
      seen.add(m);
      const label = groupName(m);
      if (matches(`${label} ${members[0].repo || members[0].projectName || ''}`)) out.push({ id: m, label, members });
    }
    return out;
  });
  // add: sessions outside this group, active ones.
  const candidates = $derived(r.mode !== 'add' ? [] : data.sessions
    .filter((s) => groupMotherOf(s.id) !== ownMother && !isSessionArchived(s)
      && matches(`${sessionTitle(s)} ${s.repo || s.projectName || ''}`))
    .sort(byRecent));

  function pick(target) {
    if (r.mode === 'move') joinGroup(r.sessionId, target);
    else joinGroup(target, r.groupId);
    closeModal();
  }
  function detach() { leaveGroup(r.sessionId); closeModal(); }
</script>

<div class="gpk">
  <div class="gpk-head">
    <div class="gpk-title">{r.mode === 'move' ? 'Move to group' : 'Add a session to the group'}</div>
    <div class="gpk-sub">{r.mode === 'move' ? sessionTitle(session) : groupName(r.groupId)}</div>
  </div>

  <!-- svelte-ignore a11y_autofocus -->
  <input class="gpk-q" type="search" placeholder={r.mode === 'move' ? 'Search a group…' : 'Search a session…'} bind:value={q} autofocus />

  <div class="gpk-list">
    {#if r.mode === 'move'}
      {#each groups as g (g.id)}
        <button class="gpk-row" onclick={() => pick(g.id)}>
          <Icon name={g.members.length > 1 ? 'sessions' : 'converse'} size={14} />
          <span class="gpk-name">{g.label}</span>
          <span class="gpk-meta">{g.members[0].repo || g.members[0].projectName || ''}</span>
          {#if g.members.length > 1}<span class="gpk-n">{g.members.length}</span>{/if}
        </button>
      {:else}
        <div class="gpk-empty">No other group{q ? ' matching “' + q + '”' : ''}.</div>
      {/each}
    {:else}
      {#each candidates as s (s.id)}
        <button class="gpk-row" onclick={() => pick(s.id)}>
          <Icon name="converse" size={14} />
          <span class="gpk-name">{sessionTitle(s)}</span>
          <span class="gpk-meta">{s.repo || s.projectName || ''}</span>
          {#if isGrouped(s.id)}<span class="gpk-n" title="Leaves its current group">in {groupName(s.id)}</span>{/if}
        </button>
      {:else}
        <div class="gpk-empty">No session{q ? ' matching “' + q + '”' : ''}.</div>
      {/each}
    {/if}
  </div>

  <div class="gpk-foot">
    {#if r.mode === 'move' && isGrouped(r.sessionId)}
      <button class="gpk-detach" onclick={detach}><Icon name="close" size={13} /> Detach from “{groupName(r.sessionId)}”</button>
    {/if}
    <button class="gpk-done" onclick={closeModal}>Cancel</button>
  </div>
</div>

<style>
  .gpk-head { margin-bottom: 14px; padding-right: 24px; }
  .gpk-title { font-size: var(--t-title); line-height: var(--lh-title); font-weight: 800; }
  .gpk-sub { font-size: var(--t-ui); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .gpk-q {
    width: 100%; box-sizing: border-box; background: var(--input); border: 1px solid var(--border); border-radius: 9px;
    padding: 9px 12px; font: inherit; font-size: var(--t-ui); color: var(--text); margin-bottom: 10px;
  }
  .gpk-q:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .gpk-list { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .gpk-empty { color: var(--muted); font-size: var(--t-ui); padding: 10px 2px; }
  .gpk-row {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; min-width: 0;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; color: var(--text);
    padding: 8px 11px; cursor: pointer; font: inherit; font-size: var(--t-ui);
  }
  .gpk-row:hover { border-color: var(--accent); background: var(--accent-soft); }
  .gpk-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .gpk-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--t-meta); color: var(--muted); }
  .gpk-n { flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gpk-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .gpk-detach, .gpk-done {
    background: var(--chip); color: var(--text); border: 1px solid var(--border); border-radius: 9px;
    padding: 8px 14px; font: inherit; font-size: var(--t-ui); font-weight: 600; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .gpk-detach { margin-right: auto; }
  .gpk-detach:hover, .gpk-done:hover { background: var(--hover); }
</style>
