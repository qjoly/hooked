<script>
  import { onMount } from 'svelte';
  import { reply, interrupt, launch, getFiles, getCommands, uploadImage } from '$lib/api.js';
  import { loadSessions, ui } from '$lib/state.svelte.js';

  // `alive` : pane tmux vivant → on répond direct. Sinon, l'envoi relance `claude --resume`
  // dans une nouvelle session tmux (en conservant modèle/effort d'origine si connus).
  // `newSession` : pas d'id encore — l'envoi LANCE une session neuve dans `project` (cwd) avec
  // le `model`/`effort` choisis ; `onLaunched(cwd)` est notifié pour ouvrir la session créée.
  // `worktree` : ne vaut que pour une session neuve — lance `claude --worktree` (dossier isolé).
  let { id, alive = true, project = null, resumeModel = null, resumeEffort = null, lastPrompt = '',
        onSent = null, newSession = false, model = '', effort = '', mode = 'default', worktree = false, onLaunched = null } = $props();

  let ta;                       // ref textarea
  let text = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);

  // ----- brouillon persistant -----
  // Le composer est recréé à chaque changement de session (route `{#key id}`), donc `text`
  // serait perdu en quittant/revenant. On le sauvegarde dans localStorage, indexé par session
  // (ou par projet pour une session neuve) : le texte survit à la navigation et au rechargement.
  const draftKey = () => 'hooked:draft:' + (newSession ? 'new:' + (project || '') : (id || ''));
  let restored = false;         // évite d'écraser le brouillon stocké avant de l'avoir relu
  onMount(() => {
    try {
      const saved = localStorage.getItem(draftKey());
      if (saved) { text = saved; queueMicrotask(autosize); }
    } catch (_) {}
    restored = true;
  });
  $effect(() => {
    const t = text;             // dépendance réactive
    if (!restored) return;
    try {
      if (t) localStorage.setItem(draftKey(), t);
      else localStorage.removeItem(draftKey());
    } catch (_) {}
  });

  // ----- images collées -----
  // chaque image est uploadée au serveur (chemin disque) et jointe au message à l'envoi :
  // Claude Code lit l'image via son chemin absolu, comme un drag-drop dans le TUI.
  let images = $state([]);      // { path, url (dataURL pour la miniature), name }
  let uploading = $state(0);    // nb d'uploads en cours

  // colle d'image : intercepte les éléments image du presse-papier, les uploade en parallèle.
  async function onPaste(e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) if (it.kind === 'file' && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) files.push(f); }
    if (!files.length) return;
    e.preventDefault();                 // on gère l'image nous-mêmes (pas d'insertion de texte)
    for (const f of files) addImage(f);
  }

  function addImage(file) {
    const reader = new FileReader();
    uploading++;
    reader.onload = async () => {
      const dataUrl = reader.result;
      const res = await uploadImage(dataUrl).catch((err) => ({ ok: false, data: { error: err.message } }));
      uploading--;
      if (res.ok) {
        images = [...images, { path: res.data.path, url: dataUrl, name: res.data.name }];
        queueMicrotask(() => ta && ta.focus());
      } else {
        status = { text: '✗ image: ' + (res.data.error || 'failed'), cls: 'err' };
        setTimeout(() => { status = { text: '', cls: '' }; }, 3500);
      }
    };
    reader.onerror = () => { uploading--; status = { text: '✗ cannot read image', cls: 'err' }; };
    reader.readAsDataURL(file);
  }
  function removeImage(i) { images = images.filter((_, j) => j !== i); }

  // ----- auto-complétion @fichier + /commande -----
  // Items normalisés : { insert, label, sub, badge } — un seul rendu pour les deux modes.
  //  @ fichier  → déclenché après un « @ » précédé d'un espace/début.
  //  / commande → déclenché uniquement quand « / » est en tout début du message (position commande).
  let acItems = $state([]);
  let acSel = $state(-1);
  let acStart = -1;
  let acReq = 0;
  const acOpen = $derived(acItems.length > 0);

  function autosize() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }
  function closeAc() { acItems = []; acSel = -1; acStart = -1; }
  const baseName = (f) => f.slice(f.lastIndexOf('/') + 1);

  async function queryAc() {
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    // « / » en tout début de message → auto-complétion des commandes
    const cmd = before.match(/^\/([a-z0-9:_-]*)$/i);
    if (cmd) return queryCommands(cmd[1], pos);
    // « @ » → auto-complétion des fichiers du projet
    const at = before.match(/(^|\s)@([^\s@]*)$/);
    if (at) return queryFiles(at[2], pos, pos - at[2].length - 1);
    closeAc();
  }
  async function queryFiles(q, pos, start) {
    acStart = start; // index du « @ »
    const myReq = ++acReq;
    try {
      const d = await getFiles(id, q, newSession ? project : null);
      if (myReq !== acReq || ta.selectionStart !== pos) return; // réponse périmée
      acItems = (d.files || []).slice(0, 30).map((f) => ({ insert: '@' + f + ' ', label: baseName(f), sub: f, badge: '' }));
      acSel = acItems.length ? 0 : -1;
    } catch (_) { closeAc(); }
  }
  async function queryCommands(q, pos) {
    acStart = 0; // index du « / » (début de message)
    const myReq = ++acReq;
    try {
      const d = await getCommands(id, q, newSession ? project : null);
      if (myReq !== acReq || ta.selectionStart !== pos) return; // réponse périmée
      acItems = (d.commands || []).map((c) => ({
        insert: '/' + c.name + ' ', label: '/' + c.name, sub: c.description || '',
        badge: c.group === 'custom' ? (c.source || 'custom') : 'built-in',
      }));
      acSel = acItems.length ? 0 : -1;
    } catch (_) { closeAc(); }
  }
  function moveAc(d) { if (acItems.length) acSel = (acSel + d + acItems.length) % acItems.length; }
  function acceptAc() {
    let i = acSel < 0 ? 0 : acSel;
    const it = acItems[i];
    if (it == null || acStart < 0) return;
    const before = ta.value.slice(0, acStart);
    const after = ta.value.slice(ta.selectionStart);
    text = before + it.insert + after;
    const pos = (before + it.insert).length;
    closeAc();
    queueMicrotask(() => { if (ta) { ta.focus(); ta.selectionStart = ta.selectionEnd = pos; autosize(); } });
  }

  function onInput() { autosize(); queryAc(); }
  function onKeydown(e) {
    // macOS : les touches Début/Fin sont des commandes de scroll système → elles scrollent la
    // conversation (.pane-body) au lieu de déplacer le curseur, même textarea focalisée. On rétablit
    // le comportement d'un champ texte normal (début/fin de ligne, ou du texte entier avec Cmd/Ctrl,
    // extension avec Maj) et on annule le scroll.
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const v = ta.value, dir = ta.selectionDirection;
      const active = dir === 'backward' ? ta.selectionStart : ta.selectionEnd;
      const anchor = dir === 'backward' ? ta.selectionEnd : ta.selectionStart;
      let target;
      if (e.metaKey || e.ctrlKey) target = e.key === 'Home' ? 0 : v.length;
      else if (e.key === 'Home') target = v.lastIndexOf('\n', active - 1) + 1;
      else { const nl = v.indexOf('\n', active); target = nl === -1 ? v.length : nl; }
      if (e.shiftKey) {
        ta.selectionStart = Math.min(anchor, target);
        ta.selectionEnd = Math.max(anchor, target);
        ta.selectionDirection = target < anchor ? 'backward' : 'forward';
      } else {
        ta.selectionStart = ta.selectionEnd = target;
      }
      return;
    }
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveAc(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveAc(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAc(); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeAc(); return; }
    }
    if (e.key === 'Escape') { e.preventDefault(); interruptEdit(); return; }
    // toute autre frappe désarme l'interruption en attente (évite un 2e Échap involontaire)
    if (armed) { disarm(); status = { text: '', cls: '' }; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Confirmation anti-Échap accidentel : interrompre Claude est coûteux, donc le 1er Échap
  // « arme » l'interruption et affiche un message ; il faut un 2e Échap dans les 3 s pour
  // réellement interrompre. Tout autre frappe (ou le délai) désarme sans rien annuler.
  let armed = false;
  let armTimer = null;
  function disarm() { armed = false; clearTimeout(armTimer); }

  // Echap (comme dans le CLI claude-code) : interrompt Claude et recharge le dernier prompt
  // dans le composer pour le corriger. Exposé au parent (écoute aussi Echap hors textarea).
  export function interruptEdit() {
    if (newSession) { closeAc(); return; }
    // Session morte : aucune requête en cours, recharger le prompt n'a rien de destructif.
    if (!alive) { reloadPrompt(false); return; }
    // 1er Échap : on arme et on demande confirmation pour éviter les annulations accidentelles.
    if (!armed) {
      armed = true;
      status = { text: '⎋ Press Esc again to interrupt', cls: 'warn' };
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { armed = false; status = { text: '', cls: '' }; }, 3000);
      queueMicrotask(() => { if (ta) ta.focus(); });
      return;
    }
    // 2e Échap dans la fenêtre : interruption réelle.
    disarm();
    interrupt(id).then(() => { loadSessions(); ui.tick++; }).catch(() => {});
    reloadPrompt(true);
  }

  function reloadPrompt(interrupted) {
    if (lastPrompt && !text.trim()) {
      text = lastPrompt;
      status = { text: interrupted ? '⎋ interrupted — prompt reloaded, edit then resend' : '⎋ prompt reloaded', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3500);
    } else if (interrupted) {
      status = { text: '⎋ interrupted', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 2000);
    }
    queueMicrotask(() => { if (ta) { ta.focus(); autosize(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
  }

  async function send() {
    const t = text.trim();
    if ((!t && !images.length) || busy || uploading) return;
    // on préfixe les chemins des images jointes : Claude Code les lit comme un drag-drop.
    const paths = images.map((im) => im.path).join(' ');
    const full = paths ? (t ? paths + ' ' + t : paths) : t;
    busy = true;
    status = { text: newSession ? 'launching…' : (alive ? 'sending…' : 'restarting the session…'), cls: '' };
    const res = newSession
      ? await launch({ cwd: project, prompt: full, model, effort, worktree, permissionMode: mode }).catch((e) => ({ ok: false, data: { error: e.message } }))
      : alive
        ? await reply(id, full).catch((e) => ({ ok: false, data: { error: e.message } }))
        : await launch({ resumeId: id, prompt: full, cwd: project, model: resumeModel || '', effort: resumeEffort || '' }).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      text = ''; images = []; autosize();
      // file d'attente + scroll auto : on signale au parent le message tout juste envoyé.
      if (alive && !newSession && onSent) onSent(full);
      if (newSession && onLaunched) onLaunched(project);
      status = { text: newSession ? ('✓ session launched (' + (res.data.tmux || 'tmux') + (res.data.worktree ? ' · worktree' : '') + ')') : (alive ? ('✓ sent to ' + res.data.pane) : ('✓ session restarted (' + (res.data.tmux || 'tmux') + ')')), cls: 'ok' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      status = { text: '✗ ' + (res.data.error || 'failed'), cls: 'err' };
    }
    busy = false;
    queueMicrotask(() => ta && ta.focus());
  }
</script>

<div class="composer" class:relaunch={!alive && !newSession}>
  <textarea bind:this={ta} bind:value={text} id="reply-text" rows="1" disabled={busy}
            placeholder={newSession
              ? 'Describe your task to start the session…  (Enter to launch · @ file · / command · paste an image)'
              : alive
                ? 'Reply to Claude…  (Enter to send · Shift+Enter = new line · @ file · / command · paste an image · Esc×2 interrupts)'
                : 'tmux session closed — sending will re-run claude --resume…  (@ file · / command · paste an image)'}
            oninput={onInput} onkeydown={onKeydown} onpaste={onPaste} onblur={() => setTimeout(closeAc, 150)}></textarea>
  <button class="reply-send" disabled={busy || uploading > 0} onclick={send}>{newSession ? 'Launch ↗' : alive ? 'Send ↩' : 'Restart ↗'}</button>
  {#if images.length || uploading}
    <div class="img-tray">
      {#each images as im, i}
        <div class="img-chip" title={im.path}>
          <img src={im.url} alt={im.name} />
          <button class="img-rm" title="Remove" onclick={() => removeImage(i)}>×</button>
        </div>
      {/each}
      {#if uploading}<div class="img-up">📎 upload…</div>{/if}
    </div>
  {/if}
  <div class="at-pop" class:hidden={!acOpen}>
    {#each acItems as it, i}
      <div class="at-item" class:sel={i === acSel} onmousedown={(e) => { e.preventDefault(); acSel = i; acceptAc(); }}>
        <span class="at-name">{it.label}</span>
        {#if it.badge}<span class="at-badge">{it.badge}</span>{/if}
        <span class="at-path">{it.sub}</span>
      </div>
    {/each}
  </div>
  <div class="reply-status {status.cls}">{status.text}</div>
</div>
