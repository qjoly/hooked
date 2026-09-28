<script>
  // Group tab strip above the open session (Orca-style): one tab per member, mother first. Only
  // rendered for a multi-session group — a lone session looks exactly as before. The group name
  // (double-click to rename), promote-to-mother / detach per tab, and « + » to add an existing
  // session or start a new one inside the group. Tabs are drop targets too.
  import { sessionDot as dotClass } from '$lib/format.js';
  import { goto } from '$app/navigation';
  import {
    groupSessions, groupMotherOf, groupName, renameGroup, setGroupMother, leaveGroup,
    sessionTitle, isSessionArchived, openModal,
  } from '$lib/state.svelte.js';
  import { dragSession, dropSession } from '$lib/groupDnd.js';
  import Icon from '$lib/components/Icon.svelte';

  let { id } = $props();

  const members = $derived(groupSessions(id));
  const mother = $derived(groupMotherOf(id));

  let editing = $state(false);
  let draft = $state('');
  function startRename() { draft = groupName(id); editing = true; }
  function commitRename() {
    if (!editing) return;
    editing = false;
    const name = draft.trim();
    // Typing the mother's own title back means « no custom name ».
    const motherTitle = sessionTitle(members.find((s) => s.id === mother));
    renameGroup(mother, name === motherTitle ? '' : name);
  }
  const focusSelect = (node) => { node.focus(); node.select(); };

  let plusOpen = $state(false);
  $effect(() => {
    if (!plusOpen) return;
    const away = (e) => { if (!(e.target instanceof Element) || !e.target.closest('.gt-plus-wrap')) plusOpen = false; };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  });
  function newInGroup() {
    plusOpen = false;
    const m = members.find((s) => s.id === mother) || members[0];
    goto('/new?group=' + encodeURIComponent(mother) + (m?.project ? '&project=' + encodeURIComponent(m.project) : ''));
  }
  function addExisting() { plusOpen = false; openModal('groupPicker', { mode: 'add', groupId: mother }); }

  const open = (s) => goto('/session/' + encodeURIComponent(s.id));
</script>

{#if members.length > 1}
  <div class="gt" use:dropSession={mother}>
    <div class="gt-name" title="Session group — double-click to rename">
      <Icon name="sessions" size={13} />
      {#if editing}
        <input class="gt-input" bind:value={draft} use:focusSelect onblur={commitRename}
               onkeydown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') editing = false; }} />
      {:else}
        <button class="gt-label" ondblclick={startRename}>{groupName(id)}</button>
      {/if}
    </div>
    <div class="gt-tabs" role="tablist">
      {#each members as s (s.id)}
        {@const isMother = s.id === mother}
        <div class="gt-tab" class:on={s.id === id} class:dim={isSessionArchived(s)} role="tab" tabindex="0"
             aria-selected={s.id === id} title={sessionTitle(s)}
             use:dragSession={s.id}
             onclick={() => open(s)}
             onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(s); } }}>
          <span class="state-dot gt-dot d-{dotClass(s)}"></span>
          {#if isMother}<span class="gt-mother" title="Mother session"><Icon name="star" size={11} /></span>{/if}
          <span class="gt-title">{sessionTitle(s)}</span>
          <span class="gt-acts">
            {#if !isMother}
              <button class="gt-act" title="Make it the mother session" aria-label="Make mother"
                      onclick={(e) => { e.stopPropagation(); setGroupMother(s.id); }}><Icon name="star" size={11} /></button>
            {/if}
            <button class="gt-act" title="Remove from the group" aria-label="Remove from group"
                    onclick={(e) => { e.stopPropagation(); leaveGroup(s.id); }}><Icon name="close" size={11} /></button>
          </span>
        </div>
      {/each}
    </div>
    <div class="gt-plus-wrap">
      <button class="gt-plus" title="Add a session to this group" aria-label="Add a session to this group"
              aria-haspopup="menu" aria-expanded={plusOpen} onclick={() => (plusOpen = !plusOpen)}><Icon name="plus" size={14} /></button>
      {#if plusOpen}
        <div class="gt-menu" role="menu">
          <button class="gt-mi" role="menuitem" onclick={newInGroup}><Icon name="send" size={13} /> New session in this group</button>
          <button class="gt-mi" role="menuitem" onclick={addExisting}><Icon name="sessions" size={13} /> Add an existing session…</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .gt {
    flex: 0 0 auto; display: flex; align-items: center; gap: 6px; min-width: 0;
    padding: 4px 8px; background: var(--bg2); border-bottom: 1px solid var(--border);
  }
  :global(body.focus) .gt { display: none; }
  .gt:global(.drop-over) { box-shadow: inset 0 0 0 2px var(--accent); }
  .gt-name { display: flex; align-items: center; gap: 5px; flex: 0 1 auto; min-width: 0; max-width: 28%; color: var(--muted); }
  .gt-label {
    background: none; border: none; padding: 2px 4px; font: inherit; font-size: 12px; font-weight: 800;
    color: var(--text); cursor: text; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
  }
  .gt-input {
    font: inherit; font-size: 12px; font-weight: 700; min-width: 0; width: 160px;
    background: var(--input); border: 1px solid var(--accent); border-radius: 6px; padding: 2px 6px; color: var(--text);
  }
  .gt-input:focus { outline: none; }
  .gt-tabs { display: flex; gap: 3px; flex: 1 1 auto; min-width: 0; overflow-x: auto; scrollbar-width: none; }
  .gt-tab {
    display: inline-flex; align-items: center; gap: 5px; flex: 0 1 auto; min-width: 0; max-width: 220px;
    padding: 3px 6px 3px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600;
    color: var(--muted); border: 1px solid transparent;
  }
  .gt-tab:hover { background: var(--hover); color: var(--text); }
  .gt-tab.on { background: var(--panel); color: var(--text); border-color: var(--border2); }
  .gt-tab.dim { opacity: .55; }
  .gt-tab:global(.dragging) { opacity: .4; }
  .gt-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .gt-mother { color: var(--waiting); display: inline-flex; flex: 0 0 auto; }
  .gt-dot { width: 7px; height: 7px; }
  .gt-acts { display: none; gap: 1px; flex: 0 0 auto; }
  .gt-tab:hover .gt-acts { display: inline-flex; }
  .gt-act {
    width: 18px; height: 18px; padding: 0; border: none; border-radius: 5px; background: transparent;
    color: var(--muted); cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  }
  .gt-act:hover { background: var(--hover); color: var(--text); }
  .gt-plus-wrap { position: relative; flex: 0 0 auto; }
  .gt-plus {
    width: 24px; height: 24px; border: none; border-radius: 7px; background: transparent; color: var(--muted);
    cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
  }
  .gt-plus:hover { background: var(--hover); color: var(--text); }
  .gt-menu {
    position: absolute; right: 0; top: calc(100% + 4px); z-index: 40; min-width: 220px;
    background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; box-shadow: var(--shadow-sm); padding: 4px;
  }
  .gt-mi {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; background: none; border: none;
    font: inherit; font-size: 12.5px; padding: 6px 8px; border-radius: 7px; color: var(--text); cursor: pointer;
  }
  .gt-mi:hover { background: var(--hover); }
</style>
