<script>
  // Mirroir d'un pane tmux : on poll `tmux capture-pane` côté serveur et on repeint l'écran
  // complet dans xterm.js (rendu fidèle des couleurs / box-drawing). Pas de PTY ni de WebSocket —
  // cohérent avec le back zéro-dépendance ; xterm n'est qu'un bundle front.
  //
  // Mode interactif (`interactive`) : xterm.onData (frappes, séquences flèches, octets de contrôle)
  // est renvoyé au pane via /api/pane/input (tmux send-keys). C'est tmux qui sert de PTY ; l'écho
  // arrive au prochain poll (légère latence). Le curseur est positionné depuis `cursor_x/y` de tmux.
  import { onMount, onDestroy } from 'svelte';
  import { capturePane, sendPaneInput } from '$lib/api.js';

  let { pane, interactive = false } = $props();

  let host;                 // conteneur DOM du terminal
  let term = null, timer = null, destroyed = false;
  let lastSize = '';
  let dead = $state(false); // pane fermé entre-temps

  // poll plus rapide en interactif (écho réactif) ; plus lent en lecture seule (économe).
  const POLL_MS = interactive ? 140 : 800;

  // saisie : on accumule les frappes et on les POST en série (ordre préservé, bursts fusionnés).
  let pendingInput = '', flushing = false;
  function queueInput(d) { pendingInput += d; flushInput(); }
  async function flushInput() {
    if (flushing || !pendingInput || destroyed) return;
    flushing = true;
    const data = pendingInput; pendingInput = '';
    try { await sendPaneInput(pane, data); } catch (_) {}
    flushing = false;
    if (pendingInput) flushInput();
  }

  onMount(() => {
    let cancelled = false;
    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      await import('@xterm/xterm/css/xterm.css');
      if (cancelled) return;
      term = new Terminal({
        convertEol: true,            // capture-pane sépare par \n → xterm passe en début de ligne suivante
        disableStdin: !interactive,  // lecture seule sauf en mode interactif
        cursorBlink: interactive,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollback: 0,               // on repeint l'écran visible à chaque poll : pas d'historique
        // curseur visible (suit tmux) en interactif ; masqué (couleur = fond) en lecture seule.
        theme: { background: '#0b0e14', foreground: '#c7d0e0', cursor: interactive ? '#7dd3fc' : '#0b0e14' },
      });
      term.open(host);
      if (interactive) {
        term.onData(queueInput);
        term.focus();
      }
      poll();
    })();
    return () => { cancelled = true; };
  });

  async function poll() {
    if (destroyed) return;
    try {
      const d = await capturePane(pane);
      if (d && d.ok) {
        if (!d.alive) {
          dead = true;
        } else {
          dead = false;
          if (d.width && d.height) {
            const sz = d.width + 'x' + d.height;
            if (sz !== lastSize) { term.resize(d.width, d.height); lastSize = sz; }
          }
          // \x1b[0m réinitialise les attributs (sinon le fond SGR laissé par la frame précédente
          // — ex. la barre de htop, fond cyan — « teinte » l'effacement), puis \x1b[H + \x1b[2J
          // (curseur en haut + efface) avant de réécrire l'écran capturé.
          let frame = '\x1b[0m\x1b[H\x1b[2J' + d.content;
          // place le curseur xterm là où tmux a le sien (lignes/colonnes 1-based).
          if (interactive) frame += `\x1b[${(d.cursorY || 0) + 1};${(d.cursorX || 0) + 1}H`;
          term.write(frame);
        }
      }
    } catch (_) { /* transitoire : on retentera au prochain tick */ }
    timer = setTimeout(poll, POLL_MS);
  }

  onDestroy(() => {
    destroyed = true;
    clearTimeout(timer);
    if (term) { try { term.dispose(); } catch (_) {} }
  });
</script>

<div class="term-wrap" class:interactive>
  {#if dead}<div class="term-dead">⛔ Ce pane tmux a été fermé.</div>{/if}
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  .term-wrap { position: relative; background: #0b0e14; border-radius: 8px; padding: 8px; overflow: auto; }
  .term-wrap.interactive { outline: 1px solid #1e2a3a; }
  .term-host { width: max-content; }
  .term-dead { color: #e08; font-size: 13px; padding: 4px 2px 8px; }
</style>
