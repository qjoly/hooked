<script>
  import { loadSessions, ui, settings, unarchive } from '$lib/state.svelte.js';
  import { launch } from '$lib/api.js';
  import ModelEffort from './ModelEffort.svelte';
  import LaunchResult from './LaunchResult.svelte';

  let { r } = $props();
  // pré-sélection : défauts hooked (Réglages) s'ils sont définis, sinon le modèle/effort réels de
  // la session d'origine, sinon les valeurs par défaut du sélecteur.
  let model = $state(settings.defaultModel || r.model || 'opus');
  let effort = $state(settings.defaultEffort || r.effort || 'high');
  let mode = $state(settings.defaultMode || 'default'); // mode de permission au lancement (claude --permission-mode)
  let prompt = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);
  let result = $state(null);

  async function go() {
    busy = true;
    status = { text: 'launching…', cls: '' };
    const res = await launch({ resumeId: r.id, prompt: prompt.trim(), model, effort, permissionMode: mode }).catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (res.ok) { result = res.data; unarchive(r.id); setTimeout(() => { loadSessions(); ui.tick++; }, 1200); }
    else status = { text: '✗ ' + (res.data.error || 'failed'), cls: 'err' };
  }
</script>

{#if result}
  <LaunchResult d={result} />
{:else}
  <h2 style="margin:0 0 4px">▶ Resume session</h2>
  <p style="color:var(--muted);font-size:12.5px;line-height:1.5;margin:0 0 16px">
    Re-runs <code>claude --resume …</code> in <code>{r.project || r.projectName || '?'}</code>
    (detached <b>tmux</b> session, subscription, <b>zero token cost</b>).</p>
  <div class="lf-resume-title">📄 {r.title || r.id}</div>
  <ModelEffort showMode bind:model bind:effort bind:mode />
  <label class="lf-label">Message to send <span style="color:var(--muted);font-weight:400">(optional)</span></label>
  <textarea class="lf-input" rows="3" placeholder="Leave empty to just re-open the session…" bind:value={prompt}></textarea>
  <div class="lf-actions">
    <button class="reply-send" disabled={busy} onclick={go}>Resume ↗</button>
    <div class="reply-status {status.cls}">{status.text}</div>
  </div>
{/if}
