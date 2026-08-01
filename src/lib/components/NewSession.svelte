<script>
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { data, ui, settings } from '$lib/state.svelte.js';
  import { getDefaults, pickFolder } from '$lib/api.js';
  import Composer from './Composer.svelte';
  import ModelEffort from './ModelEffort.svelte';

  // projets uniques triés par activité la plus récente (puis nb de sessions). [[cwd, name], …]
  // Quand `collapseWorktrees` est actif, un worktree `<projet>/.claude/worktrees/<nom>` est replié
  // sur son projet parent (`<projet>`) : on ne veut pas polluer le sélecteur avec les worktrees
  // éphémères de `claude --worktree`, le projet racine suffit à en relancer un.
  const projs = $derived.by(() => {
    const collapse = ui.collapseWorktrees;
    const m = new Map();
    for (const s of data.sessions) {
      if (!s.project) continue;
      const wt = collapse ? s.project.indexOf('/.claude/worktrees/') : -1;
      const cwd = wt > 0 ? s.project.slice(0, wt) : s.project;
      const native = cwd === s.project; // pas un worktree replié → source fiable pour le nom
      const e = m.get(cwd) || { name: native ? (s.projectName || cwd) : (cwd.split('/').pop() || cwd), count: 0, last: '', native: false };
      e.count++;
      // un nom issu d'une session « native » (dépôt racine) prime sur le basename dérivé d'un worktree
      if (native && !e.native) { e.name = s.projectName || cwd; e.native = true; }
      const t = s.lastActivity || '';
      if (t > e.last) e.last = t;
      m.set(cwd, e);
    }
    return [...m.entries()]
      .sort((a, b) => String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
      .map(([cwd, e]) => [cwd, e.name]);
  });

  let search = $state('');
  let selected = $state(null);
  let customCwd = $state('');
  // Défauts provisoires, remplacés par ceux des Réglages hooked (settings) puis, à défaut, ceux
  // de ~/.claude (config Claude Code). L'utilisateur peut ensuite les changer à la main.
  let model = $state('opus');
  let effort = $state('high');
  let mode = $state('default'); // mode de permission au lancement (claude --permission-mode)
  let worktree = $state(false); // lance `claude --worktree` (git worktree isolé)

  // Défauts de la config Claude Code (~/.claude), chargés au montage. Les défauts hooked (settings)
  // les surchargent quand ils sont définis (non vides).
  let claudeDefaults = $state(null);
  onMount(async () => { try { claudeDefaults = await getDefaults(); } catch (_) {} });
  // Tant que l'utilisateur n'a pas touché aux sélecteurs, on (re)dérive les valeurs depuis
  // settings + claudeDefaults (deps lues AVANT la garde, cf. règle réactivité Svelte 5).
  let picked = false;
  $effect(() => {
    const sm = settings.defaultModel, se = settings.defaultEffort, smo = settings.defaultMode;
    const d = claudeDefaults;
    if (picked) return;
    untrack(() => {
      model = sm || d?.model || 'opus';
      effort = se || d?.effort || 'high';
      mode = smo || d?.mode || 'default';
    });
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
      <ModelEffort compact showMode bind:model bind:effort bind:mode onchange={() => (picked = true)} />
      <label class="me-pill ns-worktree" title="Launch the session in a dedicated git worktree (claude --worktree)">
        <input type="checkbox" bind:checked={worktree} />
        <span class="me-ico">🌿</span> worktree
      </label>
    </div>

    <div class="ns-proj-head">
      <label class="lf-label">Project</label>
      <label class="ns-wt-toggle" title="Hide git worktrees nested in .claude/worktrees/ — list their parent project instead">
        <input type="checkbox" bind:checked={ui.collapseWorktrees} />
        <span>Collapse worktrees</span>
      </label>
    </div>
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
