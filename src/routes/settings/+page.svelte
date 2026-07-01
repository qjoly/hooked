<script>
  import { untrack } from 'svelte';
  import { ui, settings, updateSettings, setTheme } from '$lib/state.svelte.js';

  // Métadonnées d'affichage des sous-onglets (miroir de SessionDetail / server/settings.js).
  const SUBTAB_META = {
    chat:      { icon: '💬', label: 'Conversation' },
    changes:   { icon: '📝', label: 'Fichiers' },
    todos:     { icon: '✅', label: 'Tâches' },
    subagents: { icon: '🤖', label: 'Sous-agents' },
    terminal:  { icon: '🖥', label: 'Terminal' },
  };

  const THEMES = [
    { key: 'system', icon: '🖥️', label: 'Système' },
    { key: 'light',  icon: '☀️', label: 'Clair' },
    { key: 'dark',   icon: '🌙', label: 'Sombre' },
  ];

  // Ordre local des sous-onglets, resynchronisé depuis le store (sauf pendant une réorganisation).
  let order = $state([...settings.subtabOrder]);
  $effect(() => { order = [...settings.subtabOrder]; });

  async function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    order = next;              // optimiste
    await updateSettings({ subtabOrder: next });
  }

  // Commande shell initiale : champ local resynchronisé depuis le store TANT QUE l'utilisateur
  // n'a pas commencé à éditer (sinon la resync async au chargement écraserait sa frappe).
  let cmd = $state('');
  let cmdDirty = false;
  $effect(() => { const v = settings.initialShellCommand; if (!cmdDirty) untrack(() => (cmd = v)); });
  let cmdStatus = $state('');
  async function saveCmd() {
    const res = await updateSettings({ initialShellCommand: cmd });
    cmdDirty = false;
    cmdStatus = res.ok ? '✓ enregistré' : '✗ ' + (res.data?.error || 'échec');
    setTimeout(() => { cmdStatus = ''; }, 2500);
  }
</script>

<section id="view-settings" class="view active">
  <div class="settings">
    <h1>Réglages</h1>
    <p class="lead">Persistés côté serveur (partagés entre navigateurs). On en ajoutera au fil des besoins.</p>

    <div class="card">
      <h2>Thème</h2>
      <p class="hint">Apparence de l'interface. (Préférence par-navigateur.)</p>
      <div class="chips">
        {#each THEMES as t (t.key)}
          <button class="chip" class:active={ui.theme === t.key} onclick={() => setTheme(t.key)}>
            {t.icon} {t.label}
          </button>
        {/each}
      </div>
    </div>

    <div class="card">
      <h2>Ordre des sous-onglets d'une session</h2>
      <p class="hint">Détermine l'ordre d'affichage — et quel onglet disponible s'ouvre en premier à l'arrivée sur une session.</p>
      <ul class="reorder">
        {#each order as key, i (key)}
          <li>
            <span class="ro-pos">{i + 1}</span>
            <span class="ro-name">{SUBTAB_META[key]?.icon} {SUBTAB_META[key]?.label ?? key}</span>
            <span class="ro-actions">
              <button class="mini" disabled={i === 0} onclick={() => move(i, -1)} title="Monter" aria-label="Monter">▲</button>
              <button class="mini" disabled={i === order.length - 1} onclick={() => move(i, 1)} title="Descendre" aria-label="Descendre">▼</button>
            </span>
          </li>
        {/each}
      </ul>
    </div>

    <div class="card">
      <h2>Commande shell initiale (nouveau terminal)</h2>
      <p class="hint">Exécutée automatiquement à l'ouverture d'un nouveau pane terminal (bouton ＋). Vide = shell nu.</p>
      <div class="cmd-row">
        <input class="cmd-input" bind:value={cmd} placeholder="ex. source .venv/bin/activate"
               oninput={() => (cmdDirty = true)}
               onkeydown={(e) => { if (e.key === 'Enter') saveCmd(); }} />
        <button class="save" onclick={saveCmd}>Enregistrer</button>
        {#if cmdStatus}<span class="status">{cmdStatus}</span>{/if}
      </div>
    </div>
  </div>
</section>

<style>
  #view-settings { overflow-y: auto; padding: 26px; }
  .settings { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .lead { color: var(--muted); margin: 0 0 22px; font-size: 13px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px 20px; margin-bottom: 16px; box-shadow: var(--shadow-sm); }
  h2 { font-size: 15px; margin: 0 0 4px; }
  .hint { color: var(--muted); font-size: 12.5px; margin: 0 0 14px; }
  .chips { display: flex; gap: 8px; flex-wrap: wrap; }
  .chip { background: var(--bg3); border: 1px solid var(--border); color: var(--text); border-radius: 20px; padding: 6px 14px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .chip:hover { border-color: var(--border2); }
  .chip.active { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-d); }
  .reorder { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
  .reorder li { display: flex; align-items: center; gap: 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; }
  .ro-pos { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; width: 16px; }
  .ro-name { flex: 1; font-weight: 600; font-size: 13.5px; }
  .ro-actions { display: flex; gap: 4px; }
  .mini { background: var(--surface); border: 1px solid var(--border); color: var(--text); border-radius: 6px; width: 28px; height: 26px; cursor: pointer; font-size: 11px; }
  .mini:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-d); }
  .mini:disabled { opacity: .35; cursor: default; }
  .cmd-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .cmd-input { flex: 1; min-width: 240px; background: var(--surface); border: 1px solid var(--border2); border-radius: 8px; padding: 9px 12px; color: var(--text); font-size: 13px; font-family: inherit; }
  .cmd-input:focus { outline: none; border-color: var(--accent); }
  .save { background: var(--accent); border: none; color: #fff; border-radius: 8px; padding: 9px 16px; cursor: pointer; font-weight: 600; font-size: 13px; }
  .save:hover { background: var(--accent-d); }
  .status { color: var(--muted); font-size: 12.5px; }
</style>
