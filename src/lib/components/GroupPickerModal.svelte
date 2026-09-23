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

<div class="gp">
  <div class="gp-head">
    <div class="gp-title">{r.mode === 'move' ? 'Move to group' : 'Add a session to the group'}</div>
    <div class="gp-sub">{r.mode === 'move' ? sessionTitle(session) : groupName(r.groupId)}</div>
  </div>

  <!-- svelte-ignore a11y_autofocus -->
  <input class="gp-q" type="search" placeholder={r.mode === 'move' ? 'Search a group…' : 'Search a session…'} bind:value={q} autofocus />

  <div class="gp-list">
    {#if r.mode === 'move'}
      {#each groups as g (g.id)}
        <button class="gp-row" onclick={() => pick(g.id)}>
          <Icon name={g.members.length > 1 ? 'sessions' : 'converse'} size={14} />
          <span class="gp-name">{g.label}</span>
          <span class="gp-meta">{g.members[0].repo || g.members[0].projectName || ''}</span>
          {#if g.members.length > 1}<span class="gp-n">{g.members.length}</span>{/if}
        </button>
      {:else}
        <div class="gp-empty">No other group{q ? ' matching “' + q + '”' : ''}.</div>
      {/each}
    {:else}
      {#each candidates as s (s.id)}
        <button class="gp-row" onclick={() => pick(s.id)}>
          <Icon name="converse" size={14} />
          <span class="gp-name">{sessionTitle(s)}</span>
          <span class="gp-meta">{s.repo || s.projectName || ''}</span>
          {#if isGrouped(s.id)}<span class="gp-n" title="Leaves its current group">in {groupName(s.id)}</span>{/if}
        </button>
      {:else}
        <div class="gp-empty">No session{q ? ' matching “' + q + '”' : ''}.</div>
      {/each}
    {/if}
  </div>

  <div class="gp-foot">
    {#if r.mode === 'move' && isGrouped(r.sessionId)}
      <button class="gp-detach" onclick={detach}><Icon name="close" size={13} /> Detach from “{groupName(r.sessionId)}”</button>
    {/if}
    <button class="gp-done" onclick={closeModal}>Cancel</button>
  </div>
</div>

<style>
  .gp-head { margin-bottom: 14px; padding-right: 24px; }
  .gp-title { font-size: 16px; font-weight: 800; }
  .gp-sub { font-size: 12.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .gp-q {
    width: 100%; box-sizing: border-box; background: var(--input); border: 1px solid var(--border); border-radius: 9px;
    padding: 9px 12px; font: inherit; font-size: 13px; color: var(--text); margin-bottom: 10px;
  }
  .gp-q:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .gp-list { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
  .gp-empty { color: var(--muted); font-size: 12.5px; padding: 10px 2px; }
  .gp-row {
    display: flex; align-items: center; gap: 9px; width: 100%; text-align: left; min-width: 0;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; color: var(--text);
    padding: 8px 11px; cursor: pointer; font: inherit; font-size: 13px;
  }
  .gp-row:hover { border-color: var(--accent); background: var(--accent-soft); }
  .gp-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  .gp-meta { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--muted); }
  .gp-n { flex: 0 0 auto; font-family: var(--mono); font-size: 10.5px; color: var(--muted); max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gp-foot { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .gp-detach, .gp-done {
    background: var(--chip); color: var(--text); border: 1px solid var(--border); border-radius: 9px;
    padding: 8px 14px; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px;
  }
  .gp-detach { margin-right: auto; }
  .gp-detach:hover, .gp-done:hover { background: var(--hover); }
</style>
