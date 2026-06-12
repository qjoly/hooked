<script>
  import { data, loadSessions, ui } from '../lib/state.svelte.js';
  import { launch } from '../lib/api.js';
  import ModelEffort from './ModelEffort.svelte';
  import LaunchResult from './LaunchResult.svelte';

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
  let model = $state('');
  let effort = $state('');
  let prompt = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);
  let result = $state(null);

  const hits = $derived.by(() => {
    const q = search.toLowerCase().trim();
    return projs.filter(([c, name]) => !q || (name + ' ' + c).toLowerCase().includes(q));
  });
  // sélection par défaut : 1er projet (ou __custom si aucun)
  $effect(() => {
    if (selected === null) selected = projs.length ? projs[0][0] : '__custom';
    if (selected !== '__custom' && !hits.some(([c]) => c === selected)) selected = hits.length ? hits[0][0] : '__custom';
  });

  async function go() {
    const dir = selected === '__custom' ? customCwd.trim() : selected;
    if (!dir) { status = { text: '✗ choisis un projet ou un dossier', cls: 'err' }; return; }
    busy = true;
    status = { text: 'lancement…', cls: '' };
    const res = await launch({ cwd: dir, prompt: prompt.trim(), model, effort }).catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (res.ok) { result = res.data; setTimeout(() => { loadSessions(); ui.tick++; }, 1200); }
    else status = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
  }
</script>

{#if result}
  <LaunchResult d={result} />
{:else}
  <h2 style="margin:0 0 4px">＋ Nouvelle session Claude</h2>
  <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 18px">
    Lance <code>claude</code> interactif dans une session <b>tmux</b> détachée — ton abonnement,
    <b>aucune conso token</b>, pas de <code>claude -p</code>. Attache-toi ensuite avec la commande affichée.</p>
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
    <input class="lf-input" placeholder="/chemin/vers/le/projet" style="margin-top:8px" bind:value={customCwd} />
  {/if}
  <ModelEffort bind:model bind:effort />
  <label class="lf-label">Premier message <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
  <textarea class="lf-input" rows="3" placeholder="Laisse vide pour démarrer sans prompt…" bind:value={prompt}></textarea>
  <div class="lf-actions">
    <button class="reply-send" disabled={busy} onclick={go}>Lancer ↗</button>
    <div class="reply-status {status.cls}">{status.text}</div>
  </div>
{/if}
