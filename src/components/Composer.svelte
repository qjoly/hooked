<script>
  import { reply, getFiles } from '../lib/api.js';
  import { loadSessions, ui } from '../lib/state.svelte.js';

  let { id } = $props();

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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  async function send() {
    const t = text.trim();
    if (!t || busy) return;
    busy = true;
    status = { text: 'envoi…', cls: '' };
    const res = await reply(id, t).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      text = ''; autosize();
      status = { text: '✓ remis dans ' + res.data.pane, cls: 'ok' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 2500);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      status = { text: '✗ ' + (res.data.error || 'échec'), cls: 'err' };
    }
    busy = false;
    queueMicrotask(() => ta && ta.focus());
  }
</script>

<div class="composer">
  <textarea bind:this={ta} bind:value={text} id="reply-text" rows="1" disabled={busy}
            placeholder="Répondre à Claude…  (Entrée pour envoyer · Maj+Entrée = nouvelle ligne · @ pour un fichier)"
            oninput={onInput} onkeydown={onKeydown} onblur={() => setTimeout(closeAc, 150)}></textarea>
  <button class="reply-send" disabled={busy} onclick={send}>Envoyer ↩</button>
  <div class="at-pop" class:hidden={!acOpen}>
    {#each acItems as f, i}
      <div class="at-item" class:sel={i === acSel} onmousedown={(e) => { e.preventDefault(); acSel = i; acceptAc(); }}>
        <span class="at-name">{baseName(f)}</span><span class="at-path">{f}</span>
      </div>
    {/each}
  </div>
  <div class="reply-status {status.cls}">{status.text}</div>
</div>
