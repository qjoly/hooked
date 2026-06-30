<script>
  // Mirroir lecture seule d'un pane tmux : on poll `tmux capture-pane` côté serveur et on
  // repeint l'écran complet dans xterm.js (rendu fidèle des couleurs / box-drawing). Pas de PTY
  // ni de WebSocket — cohérent avec le back zéro-dépendance ; xterm n'est qu'un bundle front.
  import { onMount, onDestroy } from 'svelte';
  import { capturePane } from '$lib/api.js';

  let { pane } = $props();

  let host;                 // conteneur DOM du terminal
  let term = null, timer = null, destroyed = false;
  let lastSize = '';
  let dead = $state(false); // pane fermé entre-temps

  const POLL_MS = 800;

  onMount(() => {
    let cancelled = false;
    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      await import('@xterm/xterm/css/xterm.css');
      if (cancelled) return;
      term = new Terminal({
        convertEol: true,        // capture-pane sépare par \n → xterm passe en début de ligne suivante
        disableStdin: true,      // lecture seule (toute interaction reste dans tmux)
        cursorBlink: false,
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollback: 0,           // on repeint l'écran visible à chaque poll : pas d'historique
        theme: { background: '#0b0e14', foreground: '#c7d0e0', cursor: '#0b0e14' },
      });
      term.open(host);
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
          // \x1b[0m réinitialise les attributs (sinon le fond SGR laissé par la frame
          // précédente — ex. la barre de touches de htop, fond cyan — « teinte » l'effacement),
          // puis \x1b[H (curseur en haut) + \x1b[2J (efface) avant de réécrire l'écran capturé.
          term.write('\x1b[0m\x1b[H\x1b[2J' + d.content);
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

<div class="term-wrap">
  {#if dead}<div class="term-dead">⛔ Ce pane tmux a été fermé.</div>{/if}
  <div class="term-host" bind:this={host}></div>
</div>

<style>
  .term-wrap { position: relative; background: #0b0e14; border-radius: 8px; padding: 8px; overflow: auto; }
  .term-host { width: max-content; }
  .term-dead { color: #e08; font-size: 13px; padding: 4px 2px 8px; }
</style>
