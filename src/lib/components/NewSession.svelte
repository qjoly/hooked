<script>
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { data, ui } from '$lib/state.svelte.js';
  import { getDefaults, pickFolder } from '$lib/api.js';
  import Composer from './Composer.svelte';
  import ModelEffort from './ModelEffort.svelte';

  // projets uniques triés par activité la plus récente (puis nb de sessions). [[cwd, name], …]
  const projs = $derived.by(() => {
    const m = new Map();
    for (const s of data.sessions) {
      if (!s.project) continue;
      const e = m.get(s.project) || { name: s.projectName || s.project, count: 0, last: '' };
      e.count++;
      const t = s.lastActivity || '';
      if (t > e.last) e.last = t;
      m.set(s.project, e);
    }
    return [...m.entries()]
      .sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
      .map(([cwd, e]) => [cwd, e.name]);
  });

  let search = $state('');
  let selected = $state(null);
  let customCwd = $state('');
  // Défauts provisoires, remplacés au montage par ceux de ~/.claude (config Claude Code).
  let model = $state('opus');
  let effort = $state('high');
  let mode = $state('default'); // mode de permission au lancement (claude --permission-mode)
  let worktree = $state(false); // lance `claude --worktree` (git worktree isolé)

  onMount(async () => {
    try {
      const d = await getDefaults();
      if (d?.model) model = d.model;
      if (d?.effort) effort = d.effort;
      if (d?.mode) mode = d.mode;
    } catch (_) {}
  });

  const hits = $derived.by(() => {
    const q = search.toLowerCase().trim();
    return projs.filter(([c, name]) => !q || (name + ' ' + c).toLowerCase().includes(q));
  });
  // sélection par défaut : 1er projet (ou __custom si aucun) ; recale si le filtre l'a fait sortir.
  $effect(() => {
    if (selected === null) {
      const preset = page.url.searchParams.get('project');
      if (preset) selected = preset;
      else selected = projs.length ? projs[0][0] : '__custom';
    }
    if (selected !== '__custom' && !hits.some(([c]) => c === selected)) selected = hits.length ? hits[0][0] : '__custom';
  });

  const cwd = $derived(selected === '__custom' ? customCwd.trim() : selected);

  // « Other folder… » : ouvre le sélecteur de dossier natif de l'OS (macOS). En cas
  // d'échec/annulation, on retombe sur la saisie manuelle du champ texte.
  let picking = $state(false);
  async function chooseFolder() {
    selected = '__custom';
    if (picking) return;
    picking = true;
    try {
      const r = await pickFolder(customCwd.trim() || undefined);
      if (r.ok && r.data?.dir) customCwd = r.data.dir;
    } catch (_) {
    } finally {
      picking = false;
    }
  }

  // après lancement : on guette l'apparition de la session neuve (cwd + activité postérieure)
  // pour l'ouvrir directement, comme dans une vraie interface de chat.
  let launchAt = 0;
  let launchCwd = null;
  let watching = $state(false);
  function onLaunched(dir) { launchAt = Date.now(); launchCwd = dir; watching = true; }
  $effect(() => {
    if (!watching) return;
    ui.tick;
    untrack(() => {
      const fresh = data.sessions
        .filter((s) => s.project === launchCwd && s.lastActivity && Date.parse(s.lastActivity) >= launchAt - 2000)
        .sort((a, b) => String(b.lastActivity).localeCompare(String(a.lastActivity)))[0];
      if (fresh) { watching = false; goto('/session/' + encodeURIComponent(fresh.id)); }
    });
  });
</script>

<div class="newsession">
  <div class="ns-inner">
    <button class="pane-back" onclick={() => goto('/')} title="Back">←</button>
    <h1 class="ns-title">🪝 New session</h1>
    <p class="ns-sub">Launches <code>claude</code> in a detached <b>tmux</b> session — your subscription, <b>zero token cost</b>.</p>

    <Composer newSession project={cwd} {model} {effort} {mode} {worktree} {onLaunched} />

    <div class="ns-controls">
      <ModelEffort compact showMode bind:model bind:effort bind:mode />
      <label class="me-pill ns-worktree" title="Launch the session in a dedicated git worktree (claude --worktree)">
        <input type="checkbox" bind:checked={worktree} />
        <span class="me-ico">🌿</span> worktree
      </label>
    </div>

    <label class="lf-label">Project</label>
    <input type="search" class="lf-input" placeholder="🔍 Search a project…" bind:value={search} />
    <div class="lf-picklist">
      {#if hits.length}
        {#each hits as [c, name]}
          <div class="lf-pick" class:sel={selected === c} onclick={() => (selected = c)}>
            <span class="pn">{name}</span><span class="pp">{c}</span>
          </div>
        {/each}
      {:else}
        <div class="lf-empty">No project — use "Other folder…"</div>
      {/if}
      <div class="lf-pick custom" class:sel={selected === '__custom'} onclick={chooseFolder}>📁 Other folder…</div>
    </div>
    {#if selected === '__custom'}
      <div class="ns-custom-row">
        <input class="lf-input ns-custom" placeholder="/path/to/the/project" bind:value={customCwd} />
        <button class="ns-browse" onclick={chooseFolder} disabled={picking} title="Pick a folder with the OS file explorer">
          {picking ? '⏳' : '📂'} Browse…
        </button>
      </div>
    {/if}
    {#if watching}<div class="ns-watch">⏳ session launched — opening on first event…</div>{/if}
  </div>
</div>
