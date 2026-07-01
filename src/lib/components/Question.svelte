<script>
  import { replyQuestion } from '$lib/api.js';
  import { loadSessions, ui } from '$lib/state.svelte.js';

  let { id, pq } = $props();
  const questions = $derived(pq.questions || []);

  // sélection courante par question : index unique (mono) ou tableau d'index (multi)
  let pick = $state([]);
  // notes d'annotation, clé `${qi}:${oi}` → texte. Plusieurs options peuvent être annotées
  // (utile sur une question à choix multiple : une note par option cochée).
  let notes = $state({});
  // On ne réinitialise `pick` que lorsque la question change *vraiment* (pq.id stable),
  // pas à chaque refetch live (le parent réassigne `pq` à chaque tick tant que la
  // session est « working ») — sinon la sélection en cours serait effacée et le bouton
  // Envoyer ne s'activerait jamais pour un multi-select ou plusieurs questions.
  let lastId = null;
  $effect(() => {
    if (pq.id === lastId) return;
    lastId = pq.id;
    pick = questions.map((q) => (q.multiSelect ? [] : null));
    notes = {};
  });

  let sent = $state(false);
  let recap = $state({ text: '', cls: '' });
  let sending = $state(false);

  // Annotation : « prendre l'idée de Claude en y ajoutant une note ». Le ✎ d'une option la
  // sélectionne et ouvre sa propre note ; sur une question à choix multiple on peut donc annoter
  // plusieurs options, chacune sa note. À l'envoi, s'il existe au moins une note, on répond en
  // texte libre listant les choix + leurs notes (le TUI AskUserQuestion accepte une réponse libre).
  // Les notes sont lues directement à l'envoi (pas d'étape « add ») → jamais perdues.
  const nkey = (qi, oi) => qi + ':' + oi;
  const hasNote = (qi, oi) => nkey(qi, oi) in notes;
  const anyNote = $derived(Object.values(notes).some((t) => t && t.trim()));
  function selectOption(qi, oi) {
    if (questions[qi].multiSelect) { if (!pick[qi]?.includes(oi)) pick[qi] = [...(pick[qi] || []), oi]; }
    else pick[qi] = oi;
    pick = [...pick];
  }
  function toggleNote(qi, oi) {
    if (sent || sending) return;
    const k = nkey(qi, oi);
    if (k in notes) { delete notes[k]; notes = { ...notes }; }       // ✎ à nouveau → retire la note
    else { selectOption(qi, oi); notes[k] = ''; notes = { ...notes }; }
  }
  // message de suivi : une ligne par option annotée (la sélection cochée dit déjà QUOI ; la note
  // apporte le POURQUOI). N'inclut que les options qui portent réellement une note.
  function composeNotes() {
    const lines = [];
    questions.forEach((q, qi) => {
      const sels = q.multiSelect ? (pick[qi] || []) : (pick[qi] != null ? [pick[qi]] : []);
      for (const oi of [...sels].sort((a, b) => a - b)) {
        const note = (notes[nkey(qi, oi)] || '').trim();
        if (note) lines.push(`- «${q.options[oi] ? q.options[oi].label : ''}» — ${note}`);
      }
    });
    return lines.length ? 'Notes on my selection:\n' + lines.join('\n') : '';
  }

  const isSel = (qi, oi) => (questions[qi].multiSelect ? pick[qi]?.includes(oi) : pick[qi] === oi);

  const selectedLabels = () => questions.map((q, qi) => {
    const sel = pick[qi];
    return q.multiSelect
      ? (sel || []).map((oi) => q.options[oi] && q.options[oi].label).filter(Boolean)
      : (sel != null && q.options[sel] ? [q.options[sel].label] : []);
  });
  const allAnswered = $derived.by(() => selectedLabels().every((l) => l.length));

  const recapDefault = $derived(`Select ${questions.length > 1 ? 'your answers' : 'your answer'}…`);
  const recapText = $derived.by(() => {
    if (recap.text) return recap.text;
    const labels = selectedLabels();
    const parts = labels.map((l, qi) => l.length ? `${questions[qi].header ? questions[qi].header + ': ' : ''}${l.join(', ')}` : '').filter(Boolean);
    return parts.length ? '→ ' + parts.join('  ·  ') : recapDefault;
  });

  // Bascule pilotée UNIQUEMENT par l'état `pick` (jamais par l'état du DOM de la case). En
  // lisant `e.currentTarget.checked`, un clic rapide pouvait être perdu : le refetch live
  // réassigne `pq` à chaque tick et ré-asséquie `checked={isSel(...)}` depuis l'état pendant
  // qu'on clique → désync DOM/état. Ici toggle() lit/écrit `pick` de façon idempotente et
  // synchrone, donc deux clics rapprochés s'enchaînent toujours correctement.
  function toggle(qi, oi) {
    if (sent || sending) return;
    if (questions[qi].multiSelect) {
      const arr = [...(pick[qi] || [])];
      const at = arr.indexOf(oi);
      if (at < 0) arr.push(oi); else arr.splice(at, 1);
      pick[qi] = arr;
    } else {
      pick[qi] = oi;
    }
    pick = [...pick];
  }

  async function send() {
    if (!allAnswered || sending) return;
    // On envoie les INDICES choisis par question : le backend pilote le TUI au clavier
    // (↓/Espace/Entrée). Pour un multi-select, taper les labels ne cochait rien — le TUI se
    // navigue. La sélection front (`pick`) contient déjà les indices (tableau si multi, sinon
    // l'index seul). Les labels ne servent plus qu'au récap affiché.
    const selections = questions.map((q, qi) => ({
      multi: !!q.multiSelect,
      indices: q.multiSelect ? [...(pick[qi] || [])].sort((a, b) => a - b) : (pick[qi] != null ? [pick[qi]] : []),
    }));
    const labels = selectedLabels().map((l) => l.join(', ')).filter(Boolean);
    if (!labels.length) return;
    sending = true;
    recap = { text: '', cls: '' };
    // Toujours cocher/valider les options via la navigation clavier (le texte libre seul ne coche
    // rien sur un multi-select). Les notes, si présentes, partent en message de suivi côté serveur.
    const res = await replyQuestion(id, selections, anyNote ? composeNotes() : '')
      .catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      sent = true;
      recap = { text: '✓ sent: ' + labels.join('  ·  ') + (anyNote ? '  (+ notes)' : ''), cls: 'ok' };
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      recap = { text: '✗ ' + (res.data.error || 'failed'), cls: 'err' };
      sending = false;
    }
  }
</script>

<div class="question" class:sent>
  <div class="q-head"><span class="q-ico">⌨</span><span class="q-title">Claude is asking you a question</span></div>
  {#each questions as q, qi}
    <div class="q-block">
      {#if q.header}<span class="q-chip">{q.header}</span>{/if}
      <div class="q-text">{q.question}</div>
      {#if q.multiSelect}<div class="q-hint">Multiple choices allowed</div>{/if}
      <div class="q-opts">
        {#each q.options || [] as o, oi}
          <!-- Le clic est géré sur le <label> (et non sur l'<input>) : un <input> dans un
               <label> avec un handler de clic se déclenche DEUX fois (clic direct + relais du
               label) → toggle annulé. preventDefault empêche la bascule native ; l'input n'est
               plus que l'indicateur visuel piloté par `checked={isSel(...)}`. -->
          <div class="q-opt-wrap">
            <div class="q-opt-row">
              <label class="q-opt" class:sel={isSel(qi, oi)} onclick={(e) => { e.preventDefault(); toggle(qi, oi); }}>
                <input type={q.multiSelect ? 'checkbox' : 'radio'} name="q-{qi}" value={oi} disabled={sent}
                       checked={isSel(qi, oi)} tabindex="-1" />
                <span class="q-opt-body">
                  <span class="q-opt-label">{o.label}</span>
                  {#if o.description}<span class="q-opt-desc">{o.description}</span>{/if}
                </span>
              </label>
              <button class="q-annotate" class:on={hasNote(qi, oi)}
                      title="Take this option and add a note" disabled={sent} onclick={() => toggleNote(qi, oi)}>✎</button>
            </div>
            {#if hasNote(qi, oi)}
              <div class="q-note">
                <textarea bind:value={notes[qi + ':' + oi]} rows="2"
                          placeholder="Note on «{o.label}» — sent with your choice…"
                          onkeydown={(e) => { if (e.key === 'Escape') toggleNote(qi, oi); }}></textarea>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/each}
  <div class="q-foot">
    <div class="q-recap {recap.cls}">{recapText}</div>
    <button class="reply-send" disabled={!allAnswered || sending || sent} onclick={send}>Send ↩</button>
  </div>
</div>

<style>
  .q-opt-row { display: flex; align-items: stretch; gap: 6px; }
  .q-opt-row :global(.q-opt) { flex: 1; }
  .q-annotate {
    flex-shrink: 0; width: 36px; border: 1px solid var(--border); border-radius: 12px;
    background: var(--bg2); color: var(--muted); cursor: pointer; font-size: 14px;
    transition: border-color .12s, color .12s, background .12s;
  }
  .q-annotate:hover:not(:disabled) { border-color: var(--accent); color: var(--accent-d); }
  .q-annotate.on { border-color: var(--accent); color: #fff; background: var(--accent); }
  .q-annotate:disabled { opacity: .5; cursor: default; }
  .q-note { margin-top: 6px; padding-left: 27px; }
  .q-note textarea { width: 100%; font: inherit; font-size: 13px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); color: var(--text); resize: vertical; box-sizing: border-box; }
</style>
