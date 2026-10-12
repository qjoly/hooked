<script>
  import { loadSessions, ui } from '$lib/state.svelte.js';
  import { fork } from '$lib/api.js';
  import Icon from '$lib/components/Icon.svelte';
  import ModelEffort from './ModelEffort.svelte';
  import LaunchResult from './LaunchResult.svelte';

  let { r } = $props();
  // pré-sélection : modèle/effort réels de la session d'origine (sinon valeurs par défaut).
  let model = $state(r.model || 'opus');
  let effort = $state(r.effort || 'high');
  let mode = $state('default'); // mode de permission au lancement (claude --permission-mode)
  let prompt = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);
  let result = $state(null);

  async function go() {
    if (busy) return;
    busy = true;
    status = { text: 'fork…', cls: '' };
    const res = await fork({ id: r.id, forkUuid: r.forkUuid, prompt: prompt.trim(), model, effort, permissionMode: mode })
      .catch((e) => ({ ok: false, data: { error: e.message } }));
    busy = false;
    if (res.ok) { result = res.data; setTimeout(() => { loadSessions(); ui.tick++; }, 1200); }
    else status = { text: '✗ ' + (res.data.error || 'failed'), cls: 'err' };
  }
</script>

{#if result}
  <LaunchResult d={result} />
{:else}
  <h2 style="margin:0 0 4px"><Icon name="git-branch" size={18} /> Fork session</h2>
  <p style="color:var(--muted);font-size: var(--t-ui);line-height:1.5;margin:0 0 16px">
    Creates an <b>independent branch</b>: copies the conversation <b>up to and including this message</b>,
    then re-runs <code>claude --resume …</code> on it in <code>{r.project || r.projectName || '?'}</code>
    (a new session driven by hooked). The original session is not modified.</p>
  <div class="lf-resume-title"><Icon name="file" size={14} /> {r.title || r.id}</div>
  <div class="fork-from {r.role}">
    <span class="fork-from-who">{#if r.role === 'user'}<Icon name="user" size={13} /> your message{:else}<Icon name="bot" size={13} /> Claude's message{/if} — cut point</span>
    {#if r.snippet}<span class="fork-from-snip">{r.snippet}</span>{/if}
  </div>
  <ModelEffort showMode bind:model bind:effort bind:mode />
  <label class="lf-label">Message to send <span style="color:var(--muted);font-weight:400">(optional)</span></label>
  <textarea class="lf-input" rows="3" placeholder="New direction from this point…  (leave empty to just open the branch)" bind:value={prompt}></textarea>
  <div class="lf-actions">
    <button class="reply-send" disabled={busy} onclick={go}>Fork <Icon name="external" size={14} /></button>
    <div class="reply-status {status.cls}">{status.text}</div>
  </div>
{/if}
