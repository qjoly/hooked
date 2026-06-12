<script>
  import { reply, interrupt, launch, getFiles } from '../lib/api.js';
  import { loadSessions, ui } from '../lib/state.svelte.js';

  // `alive` : pane tmux vivant → on répond direct. Sinon, l'envoi relance `claude --resume`
  // dans une nouvelle session tmux (en conservant modèle/effort d'origine si connus).
  let { id, alive = true, project = null, resumeModel = null, resumeEffort = null, lastPrompt = '', onSent = null } = $props();

  let ta;                       // ref textarea
  let text = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);

  // ----- auto-complétion @fichier -----
  let acItems = $state([]);
  let acSel = $state(-1);
  let acStart = -1;
  let acReq = 0;
  const acOpen = $derived(acItems.length > 0);
  const baseName = (f) => f.slice(f.lastIndexOf('/') + 1);

  function autosize() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
  function closeAc() { acItems = []; acSel = -1; acStart = -1; }

  async function queryAc() {
    const pos = ta.selectionStart;
    const m = ta.value.slice(0, pos).match(/(^|\s)@([^\s@]*)$/);
    if (!m) { closeAc(); return; }
    acStart = pos - m[2].length - 1; // index du « @ »
    const myReq = ++acReq;
    try {
      const d = await getFiles(id, m[2]);
      if (myReq !== acReq || ta.selectionStart !== pos) return; // réponse périmée
      acItems = (d.files || []).slice(0, 30);
      acSel = acItems.length ? 0 : -1;
    } catch (_) { closeAc(); }
  }
  function moveAc(d) { if (acItems.length) acSel = (acSel + d + acItems.length) % acItems.length; }
  function acceptAc() {
    let i = acSel < 0 ? 0 : acSel;
    const f = acItems[i];
    if (f == null || acStart < 0) return;
    const before = ta.value.slice(0, acStart);
    const after = ta.value.slice(ta.selectionStart);
    const ins = '@' + f + ' ';
    text = before + ins + after;
    const at = (before + ins).length;
    closeAc();
    queueMicrotask(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = at; autosize(); } });
  }

  function onInput() { autosize(); queryAc(); }
  function onKeydown(e) {
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); interruptEdit(); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Echap (comme dans le CLI claude-code) : interrompt Claude et recharge le dernier prompt
  // dans le composer pour le corriger. Exposé au parent (écoute aussi Echap hors textarea).
  export function interruptEdit() {
    if (alive) interrupt(id).then(() => { loadSessions(); ui.tick++; }).catch(() => {});
    if (lastPrompt && !text.trim()) {
      text = lastPrompt;
      status = { text: alive ? '⎋ interrompu — prompt rechargé, édite puis renvoie' : '⎋ prompt rechargé', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3500);
    } else if (alive) {
      status = { text: '⎋ interrompu', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 2000);
    }
    queueMicrotask(() => { if (ta) { ta.focus(); autosize(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
  }

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    status = { text: alive ? 'envoi…' : 'relance de la session…', cls: '' };
    const res = alive
      ? await reply(id, t).catch((e) => ({ ok: false, data: { error: e.message } }))
      : await launch({ resumeId: id, prompt: t, cwd: project, model: resumeModel || '', effort: resumeEffort || '' }).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      text = ''; autosize();
      // file d'attente + scroll auto : on signale au parent le message tout juste envoyé.
      if (alive && onSent) onSent(t);
      status = { text: alive ? ('✓ remis dans ' + res.data.pane) : ('✓ session relancée (' + (res.data.tmux || 'tmux') + ')'), cls: 'ok' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      status = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
    }
    busy = false;
    queueMicrotask(() => ta && ta.focus());
  }
</script>

<div class="composer" class:relaunch={!alive}>
  <textarea bind:this={ta} bind:value={text} id="reply-text" rows="1" disabled={busy}
            placeholder={alive
              ? 'Répondre à Claude…  (Entrée pour envoyer · Maj+Entrée = nouvelle ligne · @ fichier · Échap interrompt)'
              : 'Session tmux fermée — envoyer relancera claude --resume…  (@ fichier)'}
            oninput={onInput} onkeydown={onKeydown} onblur={() => setTimeout(closeAc, 150)}></textarea>
  <button class="reply-send" disabled={busy} onclick={send}>{alive ? 'Envoyer ↩' : 'Relancer ↗'}</button>
  <div class="at-pop" class:hidden={!acOpen}>
    {#each acItems as f, i}
      <div class="at-item" class:sel={i === acSel} onmousedown={(e) => { e.preventDefault(); acSel = i; acceptAc(); }}>
        <span class="at-name">{baseName(f)}</span><span class="at-path">{f}</span>
      </div>
    {/each}
  </div>
  <div class="reply-status {status.cls}">{status.text}</div>
</div>
