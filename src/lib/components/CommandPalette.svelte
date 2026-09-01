<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ui, data, settings, sessionTitle, cycleScheme, setTheme, toggleFocus, toggleNotify, openModal } from '$lib/state.svelte.js';
  import { editorFor } from '$lib/editors.js';
  import { kill, interrupt, openInEditor, openInGhostty, resync } from '$lib/api.js';
  import { shortcutForCommand, formatKeys } from '$lib/shortcuts.js';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let query = $state('');
  let sel = $state(0);
  let input;

  const STATUS_ICONS = { working: 'working', waiting: 'waiting', attention: 'attention', background: 'background', ended: 'ended', idle: 'idle' };

  const currentSessionId = $derived.by(() => {
    const m = page.url.pathname.match(/^\/session\/(.+)/);
    return m ? decodeURIComponent(m[1]) : null;
  });
  const currentSession = $derived.by(() => {
    const id = currentSessionId;
    return id ? data.sessions.find(s => s.id === id) : null;
  });

  const NAV_COMMANDS = [
    { id: 'nav:deck', label: 'Go to Deck', section: 'Navigation', icon: 'deck', action: () => goto('/') },
    { id: 'nav:sessions', label: 'Go to Sessions', section: 'Navigation', icon: 'sessions', action: () => goto('/sessions') },
    { id: 'nav:new', label: 'New session', section: 'Navigation', icon: 'plus', action: () => goto('/new') },
    { id: 'nav:search', label: 'Go to Search', section: 'Navigation', icon: 'search', action: () => goto('/search') },
    { id: 'nav:stats', label: 'Go to Stats', section: 'Navigation', icon: 'stats', action: () => goto('/stats') },
    { id: 'nav:digest', label: 'Go to Digest', section: 'Navigation', icon: 'digest', action: () => goto('/digest') },
    { id: 'nav:memory', label: 'Go to Memory', section: 'Navigation', icon: 'memory', action: () => goto('/memory') },
  { id: 'nav:mcp', label: 'Go to MCP', section: 'Navigation', icon: 'mcp', action: () => goto('/mcp') },
    { id: 'nav:settings', label: 'Go to Settings', section: 'Navigation', icon: 'settings', action: () => goto('/settings') },
  ];

  const commands = $derived.by(() => {
    const cs = currentSession;
    const cmds = [
      ...NAV_COMMANDS,
      { id: 'act:theme-light', label: 'Theme: Light', section: 'Appearance', icon: 'theme-light', action: () => setTheme('light') },
      { id: 'act:theme-dark', label: 'Theme: Dark', section: 'Appearance', icon: 'theme-dark', action: () => setTheme('dark') },
      { id: 'act:theme-system', label: 'Theme: System', section: 'Appearance', icon: 'theme-system', action: () => setTheme('system') },
      { id: 'act:scheme-default', label: 'Color scheme: Default', section: 'Appearance', icon: 'dot', color: '#7d74f5', action: () => setScheme('default') },
      { id: 'act:scheme-legacy', label: 'Color scheme: Legacy', section: 'Appearance', icon: 'dot', color: '#a07a55', action: () => setScheme('legacy') },
      { id: 'act:scheme-ocean', label: 'Color scheme: Ocean', section: 'Appearance', icon: 'dot', color: '#2b8fb3', action: () => setScheme('ocean') },
      { id: 'act:scheme-forest', label: 'Color scheme: Forest', section: 'Appearance', icon: 'dot', color: '#3f9d5a', action: () => setScheme('forest') },
      { id: 'act:scheme-rose', label: 'Color scheme: Rosé', section: 'Appearance', icon: 'dot', color: '#d16a9a', action: () => setScheme('rose') },
      { id: 'act:scheme-dracula', label: 'Color scheme: Dracula', section: 'Appearance', icon: 'dot', color: '#bd93f9', action: () => setScheme('dracula') },
      { id: 'act:focus', label: ui.focus ? 'Exit focus mode' : 'Enter focus mode', section: 'Actions', icon: 'focus', action: toggleFocus },
      { id: 'act:notify', label: ui.notify ? 'Disable notifications' : 'Enable notifications', section: 'Actions', icon: ui.notify ? 'bell' : 'bell-off', action: toggleNotify },
      { id: 'act:trash', label: 'Open trash', section: 'Actions', icon: 'trash', action: () => openModal('trash') },
      { id: 'act:tools', label: `Tool details: ${ui.toolsOpen ? 'collapse all' : 'expand all'}`, section: 'Actions', icon: 'tool', action: () => { ui.toolsOpen = !ui.toolsOpen; } },
      { id: 'act:diffmode', label: `Diff: switch to ${ui.diffSplit ? 'unified' : 'split'}`, section: 'Actions', icon: 'diff', action: () => { ui.diffSplit = !ui.diffSplit; } },
      { id: 'act:grouping', label: `Sidebar: group by ${ui.groupByProject ? 'status' : 'project'}`, section: 'Actions', icon: 'folder-open', action: () => { ui.groupByProject = !ui.groupByProject; } },
      { id: 'act:resync', label: 'Force resync all sessions', section: 'Actions', icon: 'resync', action: () => resync() },
    ];
    if (cs) {
      cmds.push(
        { id: 'ctx:lens-chat', label: 'Lens: Converse', section: 'Current session', icon: 'converse', action: () => goto('/session/' + encodeURIComponent(cs.id) + '?lens=chat') },
        { id: 'ctx:lens-terminal', label: 'Lens: Shell', section: 'Current session', icon: 'shell', action: () => goto('/session/' + encodeURIComponent(cs.id) + '?lens=terminal') },
        { id: 'ctx:lens-ship', label: 'Lens: Ship (review)', section: 'Current session', icon: 'ship', action: () => goto('/session/' + encodeURIComponent(cs.id) + '?lens=ship') },
        { id: 'ctx:copy-path', label: `Copy project path: ${cs.projectName || cs.cwd}`, section: 'Current session', icon: 'clipboard', action: () => navigator.clipboard.writeText(cs.cwd) },
        { id: 'ctx:editor', label: `Open project in ${editorFor(settings.editor).label}`, section: 'Current session', icon: editorFor(settings.editor).icon, action: () => openInEditor(cs.id) },
        { id: 'ctx:ghostty', label: 'Open in Ghostty', section: 'Current session', icon: 'ghostty', action: () => openInGhostty(cs.id) },
        { id: 'ctx:interrupt', label: 'Interrupt session', section: 'Current session', icon: 'interrupt', action: () => interrupt(cs.id), hidden: cs.state !== 'working' },
        { id: 'ctx:stop', label: 'Stop session', section: 'Current session', icon: 'stop', action: () => kill(cs.id), hidden: cs.state === 'ended' },
      );
    }
    return cmds.filter(c => !c.hidden);
  });

  const ACTIVE_STATES = new Set(['attention', 'waiting', 'working', 'background']);
  const sessionItems = $derived.by(() => {
    return data.sessions
      .slice()
      .sort((a, b) => {
        const aa = ACTIVE_STATES.has(a.state), ab = ACTIVE_STATES.has(b.state);
        if (aa !== ab) return aa ? -1 : 1;
        return String(b.lastActivity || '').localeCompare(String(a.lastActivity || ''));
      })
      .map(s => ({
        id: 'session:' + s.id,
        label: sessionTitle(s),
        detail: [s.projectName, s.gitBranch].filter(Boolean).join(' · '),
        icon: STATUS_ICONS[s.state] || 'idle',
        color: `var(--${STATUS_ICONS[s.state] || 'idle'})`,
        section: 'Sessions',
        sessionId: s.id,
        active: ACTIVE_STATES.has(s.state),
        action: () => goto('/session/' + encodeURIComponent(s.id)),
      }));
  });

  function fuzzy(text, q) {
    const lower = text.toLowerCase();
    const ql = q.toLowerCase();
    let score = 0;
    let j = 0;
    for (let i = 0; i < ql.length; i++) {
      const idx = lower.indexOf(ql[i], j);
      if (idx === -1) return -1;
      score += (idx === j) ? 2 : (idx === 0 || text[idx - 1] === ' ' || text[idx - 1] === '/') ? 1 : 0;
      j = idx + 1;
    }
    if (lower.startsWith(ql)) score += 10;
    else if (lower.includes(ql)) score += 5;
    return score;
  }

  const filtered = $derived.by(() => {
    const q = query.trim();
    if (!q) return [...sessionItems.slice(0, 8), ...commands];
    const isCmd = q.startsWith('>');
    const search = isCmd ? q.slice(1).trim() : q;
    if (!search && isCmd) return commands;

    const scored = [];
    const pool = isCmd ? commands : [...sessionItems, ...commands];
    for (const item of pool) {
      const haystack = item.label + ' ' + (item.detail || '');
      const s = fuzzy(haystack, search);
      if (s >= 0) scored.push({ item, score: s });
    }
    scored.sort((a, b) => {
      if (!!a.item.active !== !!b.item.active) return a.item.active ? -1 : 1;
      return b.score - a.score;
    });
    return scored.map(s => s.item);
  });

  $effect(() => {
    query;
    sel = 0;
  });

  export function toggle() {
    open = !open;
    if (open) {
      query = '';
      sel = 0;
      requestAnimationFrame(() => input?.focus());
    }
  }

  export function openCommands() {
    open = true;
    query = '>';
    sel = 0;
    requestAnimationFrame(() => input?.focus());
  }

  function execute(item) {
    if (!item) return;
    open = false;
    item.action();
  }

  function onKeydown(e) {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); open = false; return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); scrollIntoView(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); scrollIntoView(); return; }
    if (e.key === 'Enter') { e.preventDefault(); execute(filtered[sel]); return; }
  }

  let listEl;
  function scrollIntoView() {
    requestAnimationFrame(() => {
      const el = listEl?.querySelector('[aria-selected="true"]');
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function sectionHeader(item, i) {
    if (i === 0) return item.section;
    const prev = filtered[i - 1];
    return prev.section !== item.section ? item.section : null;
  }

  function shortcutHint(item) {
    const keys = shortcutForCommand(item.id);
    return keys ? formatKeys(keys) : '';
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="palette-overlay" onclick={() => { open = false; }} role="presentation">
    <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onclick={(e) => e.stopPropagation()}>
      <div class="palette-input-row">
        <svg class="palette-search-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input
          bind:this={input}
          bind:value={query}
          class="palette-input"
          placeholder="Search sessions and commands… (type > for commands)"
          spellcheck="false"
          autocomplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-listbox"
          aria-activedescendant={filtered.length ? `palette-item-${sel}` : undefined}
        />
        <kbd class="palette-kbd">esc</kbd>
      </div>
      <div class="palette-list" bind:this={listEl} id="palette-listbox" role="listbox" aria-label="Results">
        {#if filtered.length === 0}
          <div class="palette-empty">No results</div>
        {/if}
        {#each filtered as item, i}
          {@const section = sectionHeader(item, i)}
          {@const hint = shortcutHint(item)}
          {#if section}
            <div class="palette-section" role="presentation">{section}</div>
          {/if}
          <div
            id="palette-item-{i}"
            class="palette-item"
            class:selected={i === sel}
            role="option"
            aria-selected={i === sel}
            onmouseenter={() => { sel = i; }}
            onclick={() => execute(item)}
          >
            <span class="palette-icon"><Icon name={item.icon} color={item.color} /></span>
            <span class="palette-label">{item.label}</span>
            {#if item.detail}
              <span class="palette-detail">{item.detail}</span>
            {/if}
            {#if hint}
              <kbd class="palette-shortcut">{hint}</kbd>
            {/if}
          </div>
        {/each}
      </div>
      <div class="palette-footer">
        <span><kbd>↑↓</kbd> navigate</span>
        <span><kbd>↵</kbd> select</span>
        <span><kbd>esc</kbd> close</span>
        <span><kbd>&gt;</kbd> commands only</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .palette-overlay {
    position: fixed; inset: 0; z-index: 1000;
    background: var(--overlay);
    display: flex; justify-content: center; padding-top: min(20vh, 120px);
  }
  .palette {
    width: min(640px, calc(100vw - 32px));
    max-height: min(480px, 70vh);
    background: var(--bg2);
    border: 1px solid var(--border2);
    border-radius: 12px;
    box-shadow: 0 16px 48px -8px rgba(0,0,0,.4);
    display: flex; flex-direction: column;
    overflow: hidden;
    align-self: flex-start;
  }
  .palette-input-row {
    display: flex; align-items: center; gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .palette-search-icon { flex: 0 0 auto; color: var(--muted); }
  .palette-input {
    flex: 1; background: none; border: none; outline: none;
    font: 15px/1.4 var(--font); color: var(--text);
  }
  .palette-input::placeholder { color: var(--muted); }
  .palette-kbd {
    flex: 0 0 auto;
    font: 11px/1 var(--mono); color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 6px;
  }
  .palette-list {
    flex: 1 1 auto; overflow-y: auto; padding: 4px 0;
  }
  .palette-empty {
    padding: 24px 16px; text-align: center;
    color: var(--muted); font: 14px/1.4 var(--font);
  }
  .palette-section {
    padding: 8px 16px 4px;
    font: 600 11px/1 var(--font); color: var(--muted);
    text-transform: uppercase; letter-spacing: .06em;
  }
  .palette-item {
    display: flex; align-items: center; gap: 10px;
    width: 100%; padding: 7px 16px;
    background: none; border: none; cursor: pointer;
    font: 14px/1.4 var(--font); color: var(--text);
    text-align: left; transition: background .06s;
  }
  .palette-item:hover, .palette-item.selected {
    background: var(--hover);
  }
  .palette-item.selected {
    background: var(--accent-soft);
  }
  .palette-icon { flex: 0 0 auto; font-size: 15px; width: 22px; text-align: center; }
  .palette-label { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .palette-detail {
    flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: var(--muted); font-size: 12px; max-width: 200px;
  }
  .palette-shortcut {
    flex: 0 0 auto;
    font: 11px/1 var(--mono); color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border);
    border-radius: 4px; padding: 2px 6px; white-space: nowrap;
  }
  .palette-footer {
    display: flex; gap: 16px; padding: 8px 16px;
    border-top: 1px solid var(--border);
    font: 12px/1 var(--font); color: var(--muted);
  }
  .palette-footer kbd {
    font: 11px/1 var(--mono); background: var(--bg3);
    border: 1px solid var(--border); border-radius: 3px;
    padding: 1px 4px; margin-right: 2px;
  }
</style>
