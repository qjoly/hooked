<script>
  // Un run de workflow (outil `Workflow`), rendu comme le `/workflows` du TUI mais empilé
  // verticalement — le dock est étroit, on ne met pas phases et agents côte à côte.
  //
  // Deux régimes, portés par `w.live` (cf. server/workflows.js) :
  //   - run TERMINÉ  : l'enregistrement final donne les vrais labels et le découpage phase→agents ;
  //   - run EN COURS : ni label ni phase sur disque. On liste les phases DÉCLARÉES par le script,
  //     puis les agents démarrés (rang + consigne qui les distingue + outil en cours). La note
  //     l'explique une fois, plutôt que de laisser croire à un affichage incomplet.
  import { ago, fmtTokens, fmtCost } from '$lib/format.js';
  import AgentTrace from './AgentTrace.svelte';
  import Markdown from './Markdown.svelte';
  import Icon from '$lib/components/Icon.svelte';

  let { w, session } = $props();

  // état du run → libellé + variable de couleur (mêmes tokens que les jobs de fond).
  const STATUS = {
    running:   { label: 'Running',   var: 'background' },
    completed: { label: 'Completed', var: 'ended' },
    failed:    { label: 'Failed',    var: 'attention' },
    error:     { label: 'Failed',    var: 'attention' },
    killed:    { label: 'Killed',    var: 'waiting' },
    cancelled: { label: 'Cancelled', var: 'waiting' },
    timeout:   { label: 'Timed out', var: 'waiting' },
  };
  const stat = $derived(STATUS[w.status] || { label: w.status || 'Running', var: 'muted' });

  // États d'agent observés dans les enregistrements réels : `done`, `progress`, `start`, `error`
  // — les deux du milieu n'apparaissent que sur un run TUÉ (agent interrompu en vol). `running`
  // est la valeur que le back synthétise pour un run live. Ne pas tout rabattre sur « terminé » :
  // un agent interrompu rendu en coche verte ment sur ce qui s'est passé.
  const STATE = {
    done:     { icon: 'circle-check', tint: 'ended',     label: 'finished' },
    running:  { icon: 'working',      tint: 'working',   label: 'running' },
    // `progress` = interrompu EN VOL. Il lui faut un glyphe à lui, pas le spinner de `running` :
    // Icon résout sa couleur en `color ?? TINTS[name]`, donc réutiliser l'icône `working` en
    // espérant la reteinter depuis le parent ne donnait rien — les deux états s'affichaient à
    // l'identique, et la distinction n'existait qu'au survol.
    progress: { icon: 'ban',          tint: 'waiting',   label: 'interrupted while running' },
    start:    { icon: 'queued',       tint: 'muted',     label: 'never got past launch' },
    error:    { icon: 'attention',    tint: 'attention', label: 'errored' },
  };
  const agentState = (st) => STATE[st] || { icon: 'circle', tint: 'muted', label: st || 'unknown' };

  const dur = (ms) => {
    if (!ms && ms !== 0) return '';
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  let open = $state(false);

  // La phase COURANTE d'un run terminé : la dernière qui a des agents. En live on n'en sait rien
  // (l'attribution agent→phase n'existe pas sur disque) → aucun marqueur plutôt qu'un faux.
  const currentPhase = $derived(w.live ? -1
    : w.phases.reduce((acc, p, i) => (p.agents.length ? i : acc), -1));
</script>

<div class="wf" class:open>
  <button class="wf-head" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="wf-arrow"><Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} /></span>
    <span class="wf-name" title={w.name}>{w.name}</span>
    <span class="wf-status" style="color: var(--{stat.var}); border-color: var(--{stat.var});">{stat.label}</span>
  </button>

  {#if w.summary}<div class="wf-sum" class:clamp={!open}>{w.summary}</div>{/if}

  <div class="wf-bar" title="{w.doneCount} of {w.agentCount} agents finished">
    <i style="width:{w.agentCount ? Math.round((w.doneCount / w.agentCount) * 100) : 0}%"></i>
  </div>

  <div class="wf-stats">
    <span>{w.doneCount}/{w.agentCount} agent{w.agentCount === 1 ? '' : 's'}</span>
    {#if w.durationMs != null}<span>{dur(w.durationMs)}</span>{/if}
    {#if w.model}<span>{w.model}</span>{/if}
    {#if w.totalTokens}<span>{fmtTokens(w.totalTokens)} tok</span>{/if}
    {#if w.totalToolCalls}<span>{w.totalToolCalls} tools</span>{/if}
    {#if w.cost}<span>{fmtCost(w.cost)}</span>{/if}
    {#if w.startedAt}<span class="wf-ago">{ago(new Date(w.startedAt).toISOString())}</span>{/if}
  </div>

  {#if open}
    {#if w.phases.length}
      <div class="wf-sec">Phases</div>
      <ol class="wf-phases">
        {#each w.phases as p, i}
          <li class:cur={i === currentPhase}>
            <span class="wf-pn">{i + 1}</span>
            <span class="wf-pt">{p.title}</span>
            {#if !w.live}<span class="wf-pc">{p.agents.length}</span>{/if}
            {#if p.detail}<span class="wf-pd">{p.detail}</span>{/if}
          </li>
        {/each}
      </ol>
    {/if}

    <div class="wf-sec">
      Agents
      {#if w.live && w.agentCount}<span class="wf-note">labels and phase grouping resolve when the run finishes</span>{/if}
    </div>
    {#if !w.agentCount}
      <div class="pane-empty">No agent has started yet.</div>
    {:else if w.live}
      {#each w.agents as a (a.agentId)}
        {@render agentRow(a)}
      {/each}
    {:else}
      {#each w.phases.filter((p) => p.agents.length) as p}
        <div class="wf-group">{p.title}</div>
        {#each p.agents as a (a.agentId || a.index)}{@render agentRow(a)}{/each}
      {/each}
      {#each w.unphased as a (a.agentId || a.index)}{@render agentRow(a)}{/each}
    {/if}

    {#if w.logs.length}
      <div class="wf-sec">Log</div>
      <ul class="wf-logs">{#each w.logs as l}<li>{l}</li>{/each}</ul>
    {/if}
  {/if}
</div>

<!-- Une ligne d'agent : repliée = état + libellé + compteurs ; dépliée = prompt, résultat, et le
     déroulé interne complet (même drill-in que les sous-agents — /api/agent sait désormais
     trouver les transcripts rangés sous le dossier du run). -->
{#snippet agentRow(a)}
  <details class="wa">
    <summary>
      <!-- `title` sur le span = infobulle au survol ; celui d'Icon devient un aria-label (pas de
           tooltip visuelle). Les deux, pour que l'état soit lisible à la souris ET au lecteur. -->
      <span class="wa-st" title={agentState(a.state).label}>
        <Icon name={agentState(a.state).icon} size={13}
              color="var(--{agentState(a.state).tint})" title={agentState(a.state).label} />
      </span>
      <span class="wa-i">{a.index}</span>
      <span class="wa-main">
        <!-- run terminé : le vrai label (« fix:backup-restore »). Run en cours : pas de label sur
             disque, on montre à la place la consigne qui distingue cet agent (cf. workflows.js). -->
        <span class="wa-label" title={a.hint || a.label}>{a.hint || a.label}</span>
        <!-- segments joints, jamais concaténés à la main : un agent tout juste lancé n'a pas
             encore de modèle, et un « · » en tête serait le premier caractère de la ligne. -->
        <span class="wa-num">{[a.model, a.tokens ? `${fmtTokens(a.tokens)} tok` : null,
                              a.durationMs != null ? dur(a.durationMs) : null].filter(Boolean).join(' · ')}</span>
      </span>
    </summary>
    {#if a.lastTool}
      <div class="wa-tool"><Icon name="tool" size={12} /> {a.lastTool}{#if a.lastToolDetail} <span>{a.lastToolDetail}</span>{/if}</div>
    {/if}
    {@render agentBody(a)}
  </details>
{/snippet}

{#snippet agentBody(a)}
  {#if a.promptPreview}
    <div class="wa-block"><div class="wa-lab"><Icon name="file-in" size={13} /> Instructions</div><div class="md"><Markdown text={a.promptPreview} /></div></div>
  {/if}
  {#if a.resultPreview}
    <div class="wa-block"><div class="wa-lab"><Icon name="file-out" size={13} /> Result</div><div class="md"><Markdown text={a.resultPreview} /></div></div>
  {/if}
  {#if a.agentId}<div class="wa-block"><AgentTrace {session} agentId={a.agentId} /></div>{/if}
{/snippet}

<style>
  .wf {
    border: 1px solid var(--border); border-left: 3px solid var(--background);
    border-radius: 10px; background: var(--panel); padding: 9px 11px;
  }
  .wf-head {
    display: flex; align-items: baseline; gap: 7px; width: 100%; text-align: left;
    background: none; border: none; padding: 0; cursor: pointer; font: inherit; color: var(--text);
  }
  .wf-arrow { color: var(--muted); align-self: center; display: flex; flex: 0 0 auto; }
  /* le nom prend la place restante et s'ellipse : la colonne est étroite et un nom de workflow
     est un slug sans espaces, qui sinon se casse lettre à lettre. */
  .wf-name {
    font-weight: 700; font-size: 13px; font-family: var(--mono);
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wf-status {
    flex: 0 0 auto;
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.03em; text-transform: uppercase;
    border: 1px solid var(--muted); border-radius: 999px; padding: 1px 6px; line-height: 1.5;
    white-space: nowrap;
  }
  .wf-sum { margin-top: 4px; font-size: 12.5px; color: var(--text); }
  /* replié : deux lignes de résumé suffisent à identifier le run sans manger la colonne. */
  .wf-sum.clamp { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  /* jauge d'avancement : agents terminés / agents lancés */
  .wf-bar { margin-top: 7px; height: 3px; border-radius: 2px; background: var(--bg3); overflow: hidden; }
  .wf-bar i { display: block; height: 100%; background: var(--background); transition: width .3s; }
  .wf-stats {
    margin-top: 6px; display: flex; gap: 8px; flex-wrap: wrap;
    font-size: 11px; color: var(--muted); font-family: var(--mono);
  }
  .wf-ago { margin-left: auto; }

  .wf-sec {
    margin: 12px 0 5px; font-size: 10px; font-weight: 700; letter-spacing: .05em;
    text-transform: uppercase; color: var(--muted);
  }
  .wf-note { text-transform: none; letter-spacing: 0; font-weight: 400; font-style: italic; margin-left: 6px; }

  .wf-phases { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .wf-phases li {
    display: flex; align-items: baseline; gap: 7px; padding: 3px 6px;
    border-radius: 6px; font-size: 12.5px;
  }
  .wf-phases li.cur { background: var(--bg3); }
  .wf-phases li.cur .wf-pt { font-weight: 700; }
  .wf-pn {
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    min-width: 14px; text-align: right;
  }
  .wf-pc {
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    background: var(--bg3); border-radius: 5px; padding: 0 5px;
  }
  .wf-pd { font-size: 11px; color: var(--muted); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .wf-group {
    margin: 8px 0 3px; font-size: 11px; font-weight: 600; color: var(--muted); font-family: var(--mono);
  }

  .wa { border-top: 1px solid var(--border); }
  .wa:first-of-type { border-top: none; }
  .wa > summary {
    display: flex; align-items: center; gap: 7px; cursor: pointer; padding: 5px 2px;
    list-style: none; font-size: 12.5px;
  }
  .wa > summary::-webkit-details-marker { display: none; }
  .wa > summary:hover { background: var(--bg3); border-radius: 6px; }
  .wa-st { align-self: center; display: flex; flex: 0 0 auto; }
  /* label et compteurs EMPILÉS : sur ~280 px de dock, « fix:backup-restore · opus-5 · 30.6k tok ·
     1m 2s » sur une ligne casse le label lettre à lettre et pousse les chiffres hors de la carte. */
  .wa-main { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
  .wa-label {
    font-family: var(--mono); font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .wa-num {
    font-size: 10.5px; color: var(--muted); font-family: var(--mono);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .wa-i {
    flex: 0 0 auto; font-family: var(--mono); font-size: 9.5px; color: var(--muted);
    background: var(--bg3); border-radius: 5px; padding: 0 4px; align-self: center;
  }
  .wa-tool {
    padding: 0 2px 5px 40px; font-size: 11px; color: var(--muted); font-family: var(--mono);
    display: flex; align-items: baseline; gap: 5px;
  }
  .wa-tool span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* colonne étroite : un chemin ou un identifiant long dans le prompt/résultat doit se couper
     plutôt que pousser la carte hors du dock. */
  .wa-block { padding: 4px 2px 8px 40px; min-width: 0; overflow-wrap: anywhere; }
  .wa-block :global(pre) { white-space: pre-wrap; word-break: break-word; }
  .wa-lab {
    display: flex; align-items: center; gap: 5px; font-size: 10px; font-weight: 700;
    letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px;
  }

  .wf-logs {
    margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--muted); font-family: var(--mono);
  }
</style>
