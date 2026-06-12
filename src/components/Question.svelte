<script>
  import { reply } from '../lib/api.js';
  import { loadSessions, ui } from '../lib/state.svelte.js';

  let { id, pq } = $props();
  const questions = $derived(pq.questions || []);

  // sélection courante par question : index unique (mono) ou tableau d'index (multi)
  let pick = $state([]);
  $effect(() => { pick = questions.map((q) => (q.multiSelect ? [] : null)); });

  let sent = $state(false);
  let recap = $state({ text: '', cls: '' });
  let sending = $state(false);

  const isSel = (qi, oi) => (questions[qi].multiSelect ? pick[qi]?.includes(oi) : pick[qi] === oi);

  const selectedLabels = () => questions.map((q, qi) => {
    const sel = pick[qi];
    return q.multiSelect
      ? (sel || []).map((oi) => q.options[oi] && q.options[oi].label).filter(Boolean)
      : (sel != null && q.options[sel] ? [q.options[sel].label] : []);
  });
  const allAnswered = $derived.by(() => selectedLabels().every((l) => l.length));

  const recapDefault = $derived(`Sélectionne ${questions.length > 1 ? 'tes réponses' : 'ta réponse'}…`);
  const recapText = $derived.by(() => {
    if (recap.text) return recap.text;
    const labels = selectedLabels();
    const parts = labels.map((l, qi) => l.length ? `${questions[qi].header ? questions[qi].header + ' : ' : ''}${l.join(', ')}` : '').filter(Boolean);
    return parts.length ? '→ ' + parts.join('  ·  ') : recapDefault;
  });

  function onChange(qi, oi, checked) {
    if (questions[qi].multiSelect) {
      const arr = [...(pick[qi] || [])];
      const at = arr.indexOf(oi);
      if (checked && at < 0) arr.push(oi); else if (!checked && at >= 0) arr.splice(at, 1);
      pick[qi] = arr;
    } else {
      pick[qi] = oi;
    }
    pick = [...pick];
  }

  async function send() {
    if (!allAnswered || sending) return;
    // multi-sélection d'une question jointe par « , », réponses distinctes par « · » (sans \n).
    const text = selectedLabels().map((l) => l.join(', ')).filter(Boolean).join(' · ');
    if (!text) return;
    sending = true;
    recap = { text: '', cls: '' };
    const res = await reply(id, text).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      sent = true;
      recap = { text: '✓ envoyé : ' + text, cls: 'ok' };
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      recap = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
      sending = false;
    }
  }
</script>

<div class="question" class:sent>
  <div class="q-head"><span class="q-ico">⌨</span><span class="q-title">Claude te pose une question</span></div>
  {#each questions as q, qi}
    <div class="q-block">
      {#if q.header}<span class="q-chip">{q.header}</span>{/if}
      <div class="q-text">{q.question}</div>
      {#if q.multiSelect}<div class="q-hint">Plusieurs choix possibles</div>{/if}
      <div class="q-opts">
        {#each q.options || [] as o, oi}
          <label class="q-opt" class:sel={isSel(qi, oi)}>
            <input type={q.multiSelect ? 'checkbox' : 'radio'} name="q-{qi}" value={oi} disabled={sent}
                   checked={isSel(qi, oi)} onchange={(e) => onChange(qi, oi, e.currentTarget.checked)} />
            <span class="q-opt-body">
              <span class="q-opt-label">{o.label}</span>
              {#if o.description}<span class="q-opt-desc">{o.description}</span>{/if}
            </span>
          </label>
        {/each}
      </div>
    </div>
  {/each}
  <div class="q-foot">
    <div class="q-recap {recap.cls}">{recapText}</div>
    <button class="reply-send" disabled={!allAnswered || sending || sent} onclick={send}>Envoyer ↩</button>
  </div>
</div>
