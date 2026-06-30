<script>
  import { loadSessions, ui } from '$lib/state.svelte.js';
  import { fork } from '$lib/api.js';
  import ModelEffort from './ModelEffort.svelte';
  import LaunchResult from './LaunchResult.svelte';

  let { r } = $props();
  // pré-sélection : modèle/effort réels de la session d'origine (sinon valeurs par défaut).
  let model = $state(r.model || 'opus');
  let effort = $state(r.effort || 'high');
  let prompt = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);
  let result = $state(null);

  async function go() {
    if (busy) return;
    busy = true;
    status = { text: 'fork…', cls: '' };
    const res = await fork({ id: r.id, forkUuid: r.forkUuid, prompt: prompt.trim(), model, effort })
      .catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (res.ok) { result = res.data; setTimeout(() => { loadSessions(); ui.tick++; }, 1200); }
    else status = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
  }
</script>

{#if result}
  <LaunchResult d={result} />
{:else}
  <h2 style="margin:0 0 4px">⑂ Forker la session</h2>
  <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 16px">
    Crée une <b>branche indépendante</b> : copie la conversation <b>jusqu'à ce message inclus</b>,
    puis relance <code>claude --resume …</code> dessus dans <code>{r.project || r.projectName || '?'}</code>
    (session <b>tmux</b> détachée, <b>zéro conso token</b>). La session d'origine n'est pas modifiée.</p>
  <div class="lf-resume-title">📄 {r.title || r.id}</div>
  <div class="fork-from {r.role}">
    <span class="fork-from-who">{r.role === 'user' ? '🧑 ton message' : '🤖 message de Claude'} — point de coupe</span>
    {#if r.snippet}<span class="fork-from-snip">{r.snippet}</span>{/if}
  </div>
  <ModelEffort bind:model bind:effort />
  <label class="lf-label">Message à envoyer <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
  <textarea class="lf-input" rows="3" placeholder="Nouvelle direction depuis ce point…  (laisse vide pour juste ouvrir la branche)" bind:value={prompt}></textarea>
  <div class="lf-actions">
    <button class="reply-send" disabled={busy} onclick={go}>Forker ↗</button>
    <div class="reply-status {status.cls}">{status.text}</div>
  </div>
{/if}
