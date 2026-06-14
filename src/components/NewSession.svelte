<script>
  import { untrack } from 'svelte';
  import { data, ui } from '../lib/state.svelte.js';
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
  let model = $state('opus');
  let effort = $state('high');

  const hits = $derived.by(() => {
    const q = search.toLowerCase().trim();
    return projs.filter(([c, name]) => !q || (name + ' ' + c).toLowerCase().includes(q));
  });
  // sélection par défaut : 1er projet (ou __custom si aucun) ; recale si le filtre l'a fait sortir.
  $effect(() => {
    if (selected === null) selected = projs.length ? projs[0][0] : '__custom';
    if (selected !== '__custom' && !hits.some(([c]) => c === selected)) selected = hits.length ? hits[0][0] : '__custom';
  });

  const cwd = $derived(selected === '__custom' ? customCwd.trim() : selected);

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
      if (fresh) { watching = false; ui.composing = false; ui.currentSessionId = fresh.id; }
    });
  });
</script>

<div class="newsession">
  <div class="ns-inner">
    <button class="pane-back" onclick={() => (ui.composing = false)} title="Retour">←</button>
    <h1 class="ns-title">🪝 Nouvelle session</h1>
    <p class="ns-sub">Lance <code>claude</code> dans une session <b>tmux</b> détachée — ton abonnement, <b>zéro conso token</b>.</p>

    <Composer newSession project={cwd} {model} {effort} {onLaunched} />

    <div class="ns-controls">
      <ModelEffort compact bind:model bind:effort />
    </div>

    <label class="lf-label">Projet</label>
    <input type="search" class="lf-input" placeholder="🔍 Rechercher un projet…" bind:value={search} />
    <div class="lf-picklist">
      {#if hits.length}
        {#each hits as [c, name]}
          <div class="lf-pick" class:sel={selected === c} onclick={() => (selected = c)}>
            <span class="pn">{name}</span><span class="pp">{c}</span>
          </div>
        {/each}
      {:else}
        <div class="lf-empty">Aucun projet — utilise « Autre dossier… »</div>
      {/if}
      <div class="lf-pick custom" class:sel={selected === '__custom'} onclick={() => (selected = '__custom')}>📁 Autre dossier…</div>
    </div>
    {#if selected === '__custom'}
      <input class="lf-input ns-custom" placeholder="/chemin/vers/le/projet" bind:value={customCwd} />
    {/if}
    {#if watching}<div class="ns-watch">⏳ session lancée — ouverture dès le premier évènement…</div>{/if}
  </div>
</div>
