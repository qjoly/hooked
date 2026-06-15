<script>
  import { loadSessions, ui } from '$lib/state.svelte.js';
  import { launch } from '$lib/api.js';
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
    busy = true;
    status = { text: 'lancement…', cls: '' };
    const res = await launch({ resumeId: r.id, prompt: prompt.trim(), model, effort }).catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (res.ok) { result = res.data; setTimeout(() => { loadSessions(); ui.tick++; }, 1200); }
    else status = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
  }
</script>

{#if result}
  <LaunchResult d={result} />
{:else}
  <h2 style="margin:0 0 4px">▶ Reprendre la session</h2>
  <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 16px">
    Relance <code>claude --resume …</code> dans <code>{r.project || r.projectName || '?'}</code>
    (session <b>tmux</b> détachée, abonnement, <b>zéro conso token</b>).</p>
  <div class="lf-resume-title">📄 {r.title || r.id}</div>
  <ModelEffort bind:model bind:effort />
  <label class="lf-label">Message à envoyer <span style="color:var(--muted);font-weight:400">(optionnel)</span></label>
  <textarea class="lf-input" rows="3" placeholder="Laisse vide pour juste rouvrir la session…" bind:value={prompt}></textarea>
  <div class="lf-actions">
    <button class="reply-send" disabled={busy} onclick={go}>Reprendre ↗</button>
    <div class="reply-status {status.cls}">{status.text}</div>
  </div>
{/if}
