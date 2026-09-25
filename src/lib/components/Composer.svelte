<script>
  import { onMount, onDestroy } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { reply, interrupt, launch, getFiles, getCommands, uploadImage } from '$lib/api.js';
  import { loadSessions, ui, settings } from '$lib/state.svelte.js';
  import { createSpeechToText } from '$lib/speech.svelte.js';

  // `newSession` : pas d'id encore — l'envoi LANCE une session neuve dans `project` (cwd) avec
  // le `model`/`effort` choisis ; `onLaunched(cwd)` est notifié pour ouvrir la session créée.
  // `worktree` : ne vaut que pour une session neuve — lance `claude --worktree` (dossier isolé).
  // `followup` : suggestion de prompt suivant (déjà filtrée par l'appelant — texte à montrer, ou
  // null). La carte vit ICI, dans le socle, et non dans la conversation : elle propose ce qu'on
  // pourrait envoyer, donc elle est solidaire de la saisie et ne défile pas avec le transcript.
  // Seul le masquage remonte (`onFollowupDismiss`), parce qu'il est persisté par session.
  let { id, project = null, lastPrompt = '',
        onSent = null, newSession = false, model = '', effort = '', mode = 'default', worktree = false, onLaunched = null, groupWith = null,
        followup = null, onFollowupDismiss = null } = $props();

  // Reprendre la suggestion pour la retoucher : on la pose dans la saisie sans envoyer, et la carte
  // s'efface — le texte est désormais dans la zone de saisie, l'y laisser en double n'apporte rien.
  function editFollowup() {
    const t = followup;
    if (!t) return;
    onFollowupDismiss?.(t);
    fillText(t);
  }

  let ta;                       // ref textarea
  let text = $state('');
  let status = $state({ text: '', cls: '' });
  let busy = $state(false);

  // ----- voice dictation (Web Speech API) -----
  // Mic button: the live transcript is appended to the text already typed. The
  // controller only exists in the browser (created on mount); on an unsupported
  // engine or with the mic denied its state is 'disabled' → no button at all.
  let speech = $state(null);
  const speechState = $derived(speech ? speech.state : 'disabled');
  onDestroy(() => speech?.destroy());
  function toggleSpeech() { speech?.toggle(text); }

  // Raccourcis affichés en permanence sous la zone de saisie (paires [touche, effet]) :
  // ils dépendent du mode d'envoi (lancement / réponse).
  const hints = $derived(
    newSession
      ? [['Enter', 'launch'], ['⇧Enter', 'new line'], ['@', 'file'], ['/', 'command'], ['⌘V', 'image']]
      : [['Enter', 'send'], ['⇧Enter', 'new line'], ['@', 'file'], ['/', 'command'], ['!', 'shell'], ['!!', 'interactive shell'], ['⌘V', 'image'], ['Esc×2', 'interrupt']],
  );

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
    if (settings.speechEnabled !== false) {
      speech = createSpeechToText({ lang: settings.speechLang, onText: (t) => { text = t; queueMicrotask(autosize); } });
    }
    if (newSession) queueMicrotask(() => ta?.focus());
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

  function onInput() { autosize(); queryAc(); speech?.dismissFailure(); }
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
    // Un brouillon en cours de saisie est VIDÉ par l'Échap×2 (le $effect retire aussi le brouillon
    // stocké) → on repart d'un composer propre après interruption, au lieu de laisser le prompt en
    // place. Composer déjà vide : on recharge le dernier prompt envoyé pour l'éditer/renvoyer.
    if (text.trim()) {
      text = '';
      autosize();
      status = { text: '⎋ interrupted — draft cleared', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 2500);
      queueMicrotask(() => { if (ta) ta.focus(); });
    } else {
      reloadPrompt();
    }
  }

  function reloadPrompt() {
    if (lastPrompt && !text.trim()) {
      text = lastPrompt;
      status = { text: '⎋ interrupted — prompt reloaded, edit then resend', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3500);
    } else {
      status = { text: '⎋ interrupted', cls: '' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 2000);
    }
    queueMicrotask(() => { if (ta) { ta.focus(); autosize(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
  }

  // Envoi programmatique (revue de fichiers) : on remplit le composer avec le prompt généré
  // puis on réutilise `send()` tel quel — même chemin réponse/nouvelle session, même
  // file d'attente + scroll. La revue apparaît donc comme un message normal dans le chat.
  export function sendText(t) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (!v || busy || uploading) return;
    text = v;
    autosize();
    send();
  }

  // Pré-remplissage sans envoi (prompt de follow-up qu'on veut retoucher avant d'envoyer) :
  // on pose le texte dans la zone de saisie, curseur en fin, et on rend la main au clavier.
  // Un brouillon en cours n'est jamais écrasé — la suggestion est ajoutée à la suite.
  export function fillText(t) {
    const v = typeof t === 'string' ? t.trim() : '';
    if (!v) return;
    const draft = text.trim();
    text = draft ? draft + '\n\n' + v : v;
    queueMicrotask(() => { if (ta) { ta.focus(); autosize(); ta.selectionStart = ta.selectionEnd = ta.value.length; } });
  }

  async function send() {
    const t = text.trim();
    if ((!t && !images.length) || busy || uploading) return;
    // on préfixe les chemins des images jointes : Claude Code les lit comme un drag-drop.
    const paths = images.map((im) => im.path).join(' ');
    const full = paths ? (t ? paths + ' ' + t : paths) : t;
    busy = true;
    status = { text: newSession ? 'launching…' : 'sending…', cls: '' };
    const res = newSession
      ? await launch({ cwd: project, prompt: full, model, effort, worktree, permissionMode: mode, groupWith: groupWith || undefined }).catch((e) => ({ ok: false, data: { error: e.message } }))
      : await reply(id, full).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (res.ok) {
      text = ''; images = []; autosize();
      // Mode bash (`!commande`, cf. server/agent.js → runLocalCommand) : rien n'est parti au
      // modèle, donc pas de bulle « en file d'attente » — le compte rendu de la commande arrive
      // directement dans le transcript au prochain refetch. On affiche juste le code de sortie.
      const lc = res.data.localCommand;
      if (lc) {
        status = { text: (lc.code === 0 ? '✓' : '✗') + ' ' + lc.command.slice(0, 40) + ' → exit ' + lc.code, cls: lc.code === 0 ? 'ok' : 'err' };
        setTimeout(() => { status = { text: '', cls: '' }; }, 4000);
        setTimeout(() => { loadSessions(); ui.tick++; }, 300);
        busy = false;
        queueMicrotask(() => ta && ta.focus());
        return;
      }
      // file d'attente + scroll auto : on signale au parent le message tout juste envoyé.
      if (!newSession && onSent) onSent(full);
      if (newSession && onLaunched) onLaunched(project);
      const short = (res.data.sessionId || '').slice(0, 8);
      status = { text: newSession ? ('✓ session launched' + (short ? ' (' + short + ')' : '') + (res.data.worktree ? ' · worktree' : '')) : '✓ sent', cls: 'ok' };
      setTimeout(() => { status = { text: '', cls: '' }; }, 3000);
      setTimeout(() => { loadSessions(); ui.tick++; }, 600);
    } else {
      status = { text: '✗ ' + (res.data.error || 'failed'), cls: 'err' };
    }
    busy = false;
    queueMicrotask(() => ta && ta.focus());
  }
</script>

<!-- `.composer-dock` : socle opaque collé en bas du conteneur scrollable. Il porte le fondu
     (::before) et le fond plein — la conversation se dissout donc AU-DESSUS de la zone de saisie
     au lieu de glisser derrière elle. Le cadre `.composer` n'est plus sticky lui-même. -->
<div class="composer-dock">
{#if followup}
  <div class="followup">
    <div class="fu-head">
      <span class="fu-ico"><Icon name="lightbulb" size={14} /></span> Prompt de follow-up suggéré
      <button class="fu-x" title="Dismiss" aria-label="Dismiss" onclick={() => onFollowupDismiss?.(followup)}><Icon name="close" size={14} /></button>
    </div>
    <div class="fu-text">{followup}</div>
    <div class="fu-actions">
      <button class="fu-take" onclick={() => sendText(followup)}><Icon name="send" size={14} /> Envoyer</button>
      <button class="fu-edit" title="Pré-remplir la zone de saisie sans envoyer"
              onclick={editFollowup}><Icon name="pencil" size={14} /> Modifier avant d'envoyer</button>
    </div>
  </div>
{/if}
<div class="composer">
  <textarea bind:this={ta} bind:value={text} id="reply-text" rows="1" disabled={busy}
            placeholder={newSession ? 'Describe your task to start the session…' : 'Reply to Claude…'}
            oninput={onInput} onkeydown={onKeydown} onpaste={onPaste} onblur={() => setTimeout(closeAc, 150)}></textarea>
  <div class="composer-actions">
    {#if speechState !== 'disabled' && speechState !== 'failed'}
      {@const listening = speechState === 'listening'}
      {@const downloading = speechState === 'downloading'}
      <button class="reply-mic" class:listening class:downloading type="button" disabled={busy}
              title={listening ? 'Stop dictation' : downloading ? 'Downloading speech model…' : speechState === 'need-download' ? 'Download speech model' : 'Dictate (speech to text)'}
              aria-label="Dictate" onclick={toggleSpeech}><Icon name={listening ? 'square-filled' : downloading ? 'working' : 'mic'} size={16} tint={false} /></button>
    {/if}
    <button class="reply-send" disabled={busy || uploading > 0} onclick={send}>{#if newSession}Launch <Icon name="external" size={14} />{:else}Send <Icon name="send" size={14} />{/if}</button>
  </div>
  {#if images.length || uploading}
    <div class="img-tray">
      {#each images as im, i}
        <div class="img-chip" title={im.path}>
          <img src={im.url} alt={im.name} />
          <button class="img-rm" title="Remove" onclick={() => removeImage(i)}>×</button>
        </div>
      {/each}
      {#if uploading}<div class="img-up"><Icon name="paperclip" size={13} /> upload…</div>{/if}
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
</div>
  <!-- Aide-mémoire SOUS le cadre, toujours visible (avant, ces raccourcis vivaient dans le
       placeholder → ils disparaissaient dès la première frappe). Le message de statut prend
       sa place quand il y en a un : une seule ligne, donc pas de saut de hauteur. -->
  <div class="composer-foot">
    {#if speechState === 'failed'}
      <span class="reply-status warn">speech recognition unavailable on this browser</span>
    {:else if status.text}
      <span class="reply-status {status.cls}">{status.text}</span>
    {:else}
      {#each hints as h, i (h[0] + i)}
        <span class="hint"><kbd>{h[0]}</kbd> {h[1]}</span>
      {/each}
    {/if}
  </div>
</div>
