<script>
  // Terminal d'un pane tmux en STREAMING (tier 2). On s'abonne au flux SSE /api/pane/stream :
  //   • meta     → dimensions du pane (xterm se redimensionne)
  //   • snapshot → écran initial (amorce), base64
  //   • data     → octets bruts incrémentaux (vraies séquences VT du programme), base64
  //   • dead     → pane fermé
  // xterm consomme les octets tels quels → rendu temps réel, sans repeindre tout l'écran (pas de
  // flicker), curseur exact. tmux sert de PTY ; aucune dépendance native.
  //
  // Mode interactif : xterm.onData (frappes, flèches, Ctrl-C, Échap…) est renvoyé au pane via
  // /api/pane/input (tmux send-keys). L'écho revient par le flux SSE (latence d'un aller simple).
  import { onMount, onDestroy } from 'svelte';
  import { sendPaneInput } from '$lib/api.js';

  let { pane, interactive = false, theme = null, fontFamily = null } = $props();

  // thème appliqué à chaud (xterm v5 : term.options.theme) — pas de remontage au changement.
  // IMPORTANT : on lit `theme` AVANT le garde sur `term`. Sinon `if (term && theme)` court-circuite
  // sur `term` null (xterm est créé en async au mount) → `theme` n'est jamais lu donc jamais suivi
  // comme dépendance, et un changement de thème ne re-déclenche pas l'effet (seul le fond du wrapper
  // changeait). On force aussi un refresh : repeindre les cellules déjà rendues avec la palette.
  $effect(() => {
    const t = theme;
    if (!term || !t) return;
    term.options.theme = t;
    try { term.refresh(0, term.rows - 1); } catch (_) {}
  });
  // police appliquée à chaud (même précaution de tracking que le thème).
  $effect(() => {
    const f = fontFamily;
    if (!term || !f) return;
    term.options.fontFamily = f;
    try { term.refresh(0, term.rows - 1); } catch (_) {}
  });

  let host;
  let term = null, es = null, destroyed = false;
  let dead = $state(false);

  // Firefox/Gecko : la touche Échap déclenche l'action « stop » du navigateur (window.stop()), qui
  // AVORTE les connexions réseau en vol — dont notre flux SSE → le terminal se fige et l'Échap est
  // « mangé » par le navigateur. On annule l'action par défaut sur Échap (en capture, pour passer
  // avant), SANS stopper la propagation : xterm reçoit toujours l'event et émet bien `\x1b`.
  function onKeydownCapture(e) {
    if (interactive && e.key === 'Escape') e.preventDefault();
  }

  // décode une charge base64 (event SSE) en octets pour xterm (gère l'UTF-8 multioctet).
  function b64bytes(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // saisie : on envoie CHAQUE chunk onData séparément (sérialisé, ordre préservé). On NE fusionne
  // PAS : dans un TUI (vim/nvim/claude), un `\x1b` (Échap) qui arriverait dans le même send-keys
  // que les octets suivants serait lu comme une SÉQUENCE d'échappement (flèche/méta) plutôt qu'un
  // Échap simple → « Échap ne marche pas ». Garder les chunks séparés préserve le délai qui permet
  // au programme de désambiguïser (son ttimeout). Une frappe = un onData = un send-keys.
  const inputQueue = [];
  let sending = false;
  function queueInput(d) { inputQueue.push(d); pump(); }
  async function pump() {
    if (sending || destroyed) return;
    sending = true;
    while (inputQueue.length) {
      const d = inputQueue.shift();
      try { await sendPaneInput(pane, d); } catch (_) {}
    }
    sending = false;
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      await import('@xterm/xterm/css/xterm.css');
      if (cancelled) return;
      term = new Terminal({
        disableStdin: !interactive,
        cursorBlink: interactive,
        fontSize: 12,
        fontFamily: fontFamily || 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollback: 1000,
        theme: theme || { background: '#0b0e14', foreground: '#c7d0e0', cursor: '#7dd3fc' },
      });
      term.open(host);
      if (interactive) {
        term.onData(queueInput);
        term.focus();
        window.addEventListener('keydown', onKeydownCapture, true);
      }

      es = new EventSource('/api/pane/stream?pane=' + encodeURIComponent(pane));
      es.addEventListener('meta', (ev) => {
        try { const m = JSON.parse(ev.data); if (m.width && m.height) term.resize(m.width, m.height); } catch (_) {}
      });
      es.addEventListener('snapshot', (ev) => { dead = false; term.reset(); term.write(b64bytes(ev.data)); });
      es.addEventListener('data', (ev) => term.write(b64bytes(ev.data)));
      es.addEventListener('dead', () => { dead = true; });
    })();
    return () => { cancelled = true; };
  });

  onDestroy(() => {
    destroyed = true;
    window.removeEventListener('keydown', onKeydownCapture, true);
    if (es) { try { es.close(); } catch (_) {} }
    if (term) { try { term.dispose(); } catch (_) {} }
  });
</script>

<div class="term-wrap" class:interactive style:background={theme ? theme.background : '#0b0e14'}>
  {#if dead}<div class="term-dead">⛔ Ce pane tmux a été fermé.</div>{/if}
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  /* width:max-content → la boîte épouse la taille réelle du terminal (cols×rows), pas toute la
     largeur du panneau ; max-width:100% + overflow:auto pour les panes plus larges que la vue. */
  .term-wrap { position: relative; width: max-content; max-width: 100%; border-radius: 8px; padding: 8px; overflow: auto; }
  .term-wrap.interactive { outline: 1px solid #1e2a3a; }
  .term-host { width: max-content; }
  .term-dead { color: #e08; font-size: 13px; padding: 4px 2px 8px; }
</style>
