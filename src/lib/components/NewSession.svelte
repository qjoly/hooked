<script>
  import { onMount, untrack } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { data, ui, settings, updateSettings } from '$lib/state.svelte.js';
  import { getDefaults, pickFolder, getUsage } from '$lib/api.js';
  import Composer from './Composer.svelte';
  import ModelEffort from './ModelEffort.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { defaultModelForQuota, isFableModel, isQuotaExhausted } from '$lib/models.js';

  // projets uniques triés favoris d'abord, puis par activité la plus récente (puis nb de sessions).
  // [[cwd, name, fav], …]. Quand `collapseWorktrees` est actif, un worktree
  // `<projet>/.claude/worktrees/<nom>` est replié sur son projet parent (`<projet>`) : on ne veut pas
  // polluer le sélecteur avec les worktrees éphémères de `claude --worktree`, le projet racine suffit.
  const projs = $derived.by(() => {
    const collapse = ui.collapseWorktrees;
    const fav = new Set(settings.favoriteProjects || []);
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
    // un favori sans session enregistrée doit tout de même apparaître (nom = basename du chemin).
    for (const cwd of fav) if (!m.has(cwd)) m.set(cwd, { name: cwd.split('/').pop() || cwd, count: 0, last: '', native: false });
    return [...m.entries()]
      .sort((a, b) =>
        ((fav.has(b[0]) ? 1 : 0) - (fav.has(a[0]) ? 1 : 0)) ||
        String(b[1].last).localeCompare(String(a[1].last)) || b[1].count - a[1].count)
      .map(([cwd, e]) => [cwd, e.name, fav.has(cwd)]);
  });

  // Pastille duotone du picker : teinte déterministe par chemin, pour qu'un projet garde sa
  // couleur d'une visite à l'autre. Jetons uniquement (fonds soft via les triplets --*-rgb),
  // donc light / dark / scheme legacy résolvent tout seuls.
  const HUES = [
    ['var(--accent)', 'rgba(var(--accent-rgb),.12)'],
    ['var(--info)', 'rgba(var(--info-rgb),.12)'],
    ['var(--success)', 'rgba(var(--success-rgb),.12)'],
    ['var(--warn)', 'rgba(var(--warn-rgb),.14)'],
    ['var(--background)', 'rgba(var(--bgjob-rgb),.12)'],
  ];
  function hue(cwd) {
    let h = 0;
    for (let i = 0; i < cwd.length; i++) h = (h * 31 + cwd.charCodeAt(i)) | 0;
    return HUES[Math.abs(h) % HUES.length];
  }

  // Épingle/désépingle un projet (maj optimiste du miroir réactif puis persistance côté serveur).
  function toggleFavorite(cwd) {
    const cur = settings.favoriteProjects || [];
    const next = cur.includes(cwd) ? cur.filter((p) => p !== cwd) : [...cur, cwd];
    settings.favoriteProjects = next;
    updateSettings({ favoriteProjects: next });
  }

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

  // Quota hebdomadaire propre à Fable (même source que les jauges de la TopBar). Il ne dit rien des
  // buckets 5 h / 7 j : c'est une limite SCOPÉE au modèle, et une fois pleine, lancer sur Fable
  // n'échoue pas gentiment — la session part en erreur au premier tour. On s'en sert donc pour
  // rabattre le DÉFAUT sur « Opus (default) » (cf. defaultModelForQuota).
  let fableQuota = $state(null);
  $effect(() => {
    ui.tick; // dépendance : re-fetch à chaque tick live, le quota peut se libérer (reset hebdo)
    getUsage().then((u) => { fableQuota = u?.account?.fable ?? null; }).catch(() => {});
  });
  // Le défaut configuré (réglages hooked, sinon ~/.claude) AVANT rabattement — c'est lui qu'on
  // nomme dans l'avertissement, et sa présence conditionne l'affichage de celui-ci.
  const wantedModel = $derived(settings.defaultModel || claudeDefaults?.model || 'opus');
  const fableFallback = $derived(isFableModel(wantedModel) && isQuotaExhausted(fableQuota));

  // Tant que l'utilisateur n'a pas touché aux sélecteurs, on (re)dérive les valeurs depuis
  // settings + claudeDefaults (deps lues AVANT la garde, cf. règle réactivité Svelte 5).
  let picked = false;
  $effect(() => {
    const sm = settings.defaultModel, se = settings.defaultEffort, smo = settings.defaultMode;
    const d = claudeDefaults;
    const q = fableQuota;
    if (picked) return;
    untrack(() => {
      // Rabattement UNIQUEMENT sur le défaut : choisir Fable à la main reste possible (le quota lu
      // peut avoir plusieurs minutes — repli sur le cache de Claude Code — et l'utilisateur peut
      // en savoir plus que nous).
      model = defaultModelForQuota(sm || d?.model || 'opus', q);
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
    <button class="pane-back" onclick={() => goto('/')} title="Back"><Icon name="arrow-left" /></button>
    <h1 class="ns-title"><Icon name="hook" size={28} /> New session</h1>
    <p class="ns-sub">Launches <code>claude</code> through the <b>Agent SDK</b>, driven by hooked — your subscription, <b>zero token cost</b>.</p>

    <Composer newSession project={cwd} {model} {effort} {mode} {worktree} {onLaunched} />

    {#if fableFallback}
      <div class="ns-quota" role="status">
        <Icon name="warning" size={14} />
        <span><b>{fableQuota?.label || 'Fable'}</b> weekly limit reached{fableQuota?.resetInMin != null
          ? ` — resets in ${fableQuota.resetInMin >= 60 ? Math.round(fableQuota.resetInMin / 60) + 'h' : fableQuota.resetInMin + 'm'}`
          : ''}. Defaulting to <b>Opus</b> so the session doesn't fail on its first turn.</span>
      </div>
    {/if}

    <div class="ns-controls">
      <ModelEffort compact showMode bind:model bind:effort bind:mode onchange={() => (picked = true)} />
      <label class="me-pill ns-worktree" title="Launch the session in a dedicated git worktree (claude --worktree)">
        <input type="checkbox" bind:checked={worktree} />
        <span class="me-ico"><Icon name="git-branch" size={14} /></span> worktree
      </label>
    </div>

    <div class="ns-proj-head">
      <label class="lf-label">Project</label>
      <label class="ns-wt-toggle" title="Hide git worktrees nested in .claude/worktrees/ — list their parent project instead">
        <input type="checkbox" bind:checked={ui.collapseWorktrees} />
        <span>Collapse worktrees</span>
      </label>
    </div>
    <input type="search" class="lf-input" placeholder="Search a project…" bind:value={search} />
    <div class="lf-picklist" role="listbox" aria-label="Projects">
      {#if hits.length}
        {#each hits as [c, name, fav]}
          {@const [hc, hbg] = hue(c)}
          <div class="lf-pick" class:sel={selected === c} tabindex="0" role="option" aria-selected={selected === c}
               onclick={() => (selected = c)}
               onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selected = c; } }}>
            <span class="lf-chip" style="background:{hbg}"><Icon name="folder" size={15} color={hc} /></span>
            <span class="lf-pick-main"><span class="pn">{name}</span><span class="pp">{c}</span></span>
            <button class="lf-star" class:on={fav} aria-pressed={fav}
                    title={fav ? 'Remove from favorites' : 'Add to favorites'}
                    aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
                    onclick={(e) => { e.stopPropagation(); toggleFavorite(c); }}><Icon name="star" size={14} /></button>
          </div>
        {/each}
      {:else}
        <div class="lf-empty">No project — use "Other folder…"</div>
      {/if}
      <div class="lf-pick custom" class:sel={selected === '__custom'} tabindex="0" role="option" aria-selected={selected === '__custom'}
           onclick={chooseFolder}
           onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); chooseFolder(); } }}><span class="lf-chip" style="background:var(--accent-soft)"><Icon name="folder-open" size={15} color="var(--accent)" /></span> Other folder…</div>
    </div>
    {#if selected === '__custom'}
      <div class="ns-custom-row">
        <input class="lf-input ns-custom" placeholder="/path/to/the/project" bind:value={customCwd} />
        <button class="ns-browse" onclick={chooseFolder} disabled={picking} title="Pick a folder with the OS file explorer">
          {#if picking}<Icon name="queued" size={14} />{:else}<Icon name="folder-open" size={14} />{/if} Browse…
        </button>
      </div>
    {/if}
    {#if watching}<div class="ns-watch"><Icon name="queued" size={14} /> session launched — opening on first event…</div>{/if}
  </div>
</div>
