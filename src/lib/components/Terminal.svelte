<script>
  // Terminal shell en streaming : xterm.js côté navigateur, PTY réel côté serveur (node-pty, cf.
  // server/terminal.js). Le flux SSE /api/terminal/stream livre les octets BRUTS du PTY en base64 ;
  // xterm les consomme tels quels → rendu incrémental, sans flicker, curseur exact, TUI fonctionnels.
  // Les frappes repartent par /api/terminal/input et l'écho revient par le flux (un aller simple).
  //
  // Ce composant remplace le mirroir de pane tmux. Deux simplifications par rapport à lui : il n'y a
  // plus de session Claude à recopier (donc plus de mode lecture seule ni d'évènement `meta` pour se
  // caler sur la taille d'un pane distant — ici c'est NOUS qui dimensionnons le PTY), et le thème
  // n'est plus un sélecteur mais une dérivation des variables CSS de hooked : le terminal suit donc
  // la palette active (y compris Datadog) sans un réglage de plus à maintenir.
  import { onMount, onDestroy } from 'svelte';
  import { sendTerminalInput, resizeTerminal } from '$lib/api.js';

  let { id, onclosed = null } = $props();

  let host;
  let term = null, es = null, destroyed = false;
  let fitAddon = null, fitTimer = null, lastDims = '', resizeObs = null;
  let closed = $state(false);

  // Palette xterm dérivée des variables CSS du thème actif. Lue au montage puis à chaque changement
  // de thème/palette (l'attribut change sur <html>, donc un MutationObserver suffit) — un sélecteur
  // de thème dédié au terminal serait un réglage de plus à tenir synchronisé pour rien.
  function readTheme() {
    if (typeof getComputedStyle === 'undefined' || !host) return null;
    const cs = getComputedStyle(document.documentElement);
    const v = (n, dflt) => (cs.getPropertyValue(n) || '').trim() || dflt;
    return {
      background: v('--code-bg', '#0b0e14'),
      foreground: v('--fg', '#c7d0e0'),
      cursor: v('--accent', '#7dd3fc'),
      selectionBackground: v('--accent-soft', 'rgba(125,116,245,.35)'),
      red: v('--danger', '#e06a4a'),
      green: v('--success', '#2a9d63'),
      yellow: v('--warn', '#c08a1a'),
      blue: v('--info', '#3b82c4'),
      magenta: v('--background', '#8250df'),
    };
  }
  function applyTheme() {
    if (!term) return;
    const t = readTheme();
    if (!t) return;
    term.options.theme = t;
    try { term.refresh(0, term.rows - 1); } catch (_) {}
  }

  // Dimensionnement : on calcule cols×rows qui tiennent dans le conteneur et on redimensionne le PTY
  // en conséquence, pour que le shell et ses programmes reflusent à la bonne largeur. La hauteur
  // vient du layout (flex), pas d'un calcul JS : le panneau est redimensionnable au drag.
  function applyFit() {
    if (!term || !fitAddon || destroyed) return;
    let dims;
    try { dims = fitAddon.proposeDimensions(); } catch (_) { return; }
    if (!dims || !dims.cols || !dims.rows) return;
    const key = dims.cols + 'x' + dims.rows;
    if (key === lastDims) return;      // déjà à cette taille : ni resize xterm ni requête
    lastDims = key;
    try { term.resize(dims.cols, dims.rows); } catch (_) {}
    resizeTerminal(id, dims.cols, dims.rows).catch(() => {});
  }
  function scheduleFit() {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(applyFit, 150);
  }

  // Firefox/Gecko : Échap déclenche l'action « stop » du navigateur (window.stop()), qui AVORTE les
  // connexions en vol — dont notre flux SSE → le terminal se fige et l'Échap est mangé. On annule
  // l'action par défaut en capture, SANS stopper la propagation : xterm reçoit l'event et émet `\x1b`.
  function onKeydownCapture(e) {
    if (e.key === 'Escape') e.preventDefault();
  }

  // décode une charge base64 en octets (gère l'UTF-8 multioctet, que `atob` seul casserait).
  function b64bytes(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  // Saisie sérialisée, ordre préservé. On COALESCE les chunks sans `\x1b` en une seule requête (un
  // collage ou une frappe rapide ne génère pas une requête par caractère). Un chunk contenant `\x1b`
  // part SEUL : le fusionner ferait lire un Échap comme le début d'une SÉQUENCE d'échappement
  // (flèche, méta) dans un TUI → « Échap ne marche pas ». Isolé, le délai laisse le programme
  // désambiguïser.
  const inputQueue = [];
  let sending = false;
  function queueInput(d) { inputQueue.push(d); pump(); }
  async function pump() {
    if (sending || destroyed) return;
    sending = true;
    while (inputQueue.length) {
      let d = inputQueue.shift();
      if (!d.includes('\x1b')) {
        while (inputQueue.length && !inputQueue[0].includes('\x1b')) d += inputQueue.shift();
      }
      try { await sendTerminalInput(id, d); } catch (_) {}
    }
    sending = false;
  }

  let themeObs = null;
  onMount(() => {
    let cancelled = false;
    (async () => {
      const { Terminal } = await import('@xterm/xterm');
      await import('@xterm/xterm/css/xterm.css');
      // attend la police empaquetée AVANT de mesurer la grille : mesurer avec une police de repli
      // donne des cellules mal dimensionnées et des glyphes désalignés.
      try {
        if (document.fonts && document.fonts.load) await document.fonts.load('12px "JetBrains Mono Web"');
      } catch (_) {}
      if (cancelled) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: 12,
        fontFamily: '"JetBrains Mono Web", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        scrollback: 5000,
        theme: readTheme() || undefined,
      });
      const { FitAddon } = await import('@xterm/addon-fit');
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(host);
      term.onData(queueInput);
      term.focus();
      window.addEventListener('keydown', onKeydownCapture, true);
      window.addEventListener('resize', scheduleFit);
      // ResizeObserver sur le conteneur : sa taille est pilotée par la mise en page et le drag du
      // panneau, PAS par le contenu du terminal → déclencheur fiable, sans boucle de rétroaction.
      try { resizeObs = new ResizeObserver(scheduleFit); resizeObs.observe(host.parentElement); } catch (_) {}
      // plusieurs passes : mise en page et polices peuvent se stabiliser après le premier rendu.
      applyFit();
      requestAnimationFrame(applyFit);
      setTimeout(applyFit, 150);

      // suit les changements de thème / palette / angles posés sur <html>
      try {
        themeObs = new MutationObserver(applyTheme);
        themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
      } catch (_) {}

      es = new EventSource('/api/terminal/stream?id=' + encodeURIComponent(id));
      es.onmessage = (ev) => { if (term && ev.data) term.write(b64bytes(ev.data)); };
      // Le serveur ferme le flux quand le terminal est tué → on le signale au parent plutôt que de
      // laisser EventSource se reconnecter en boucle sur un id qui n'existe plus.
      es.onerror = () => {
        if (destroyed) return;
        closed = true;
        try { es.close(); } catch (_) {}
        if (onclosed) onclosed(id);
      };
    })();
    return () => { cancelled = true; };
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(fitTimer);
    window.removeEventListener('keydown', onKeydownCapture, true);
    window.removeEventListener('resize', scheduleFit);
    if (resizeObs) { try { resizeObs.disconnect(); } catch (_) {} }
    if (themeObs) { try { themeObs.disconnect(); } catch (_) {} }
    if (es) { try { es.close(); } catch (_) {} }
    if (term) { try { term.dispose(); } catch (_) {} }
  });
</script>

<div class="term-wrap">
  <div class="term-host" bind:this={host}></div>
  {#if closed}<div class="term-closed">terminal closed</div>{/if}
</div>

<style>
  /* La hauteur vient du layout (le panneau bas est redimensionnable au drag) ; xterm remplit. */
  .term-wrap {
    position: relative; flex: 1 1 auto; min-height: 0; min-width: 0;
    padding: 6px 8px; background: var(--code-bg); overflow: hidden;
  }
  .term-host { width: 100%; height: 100%; }
  .term-closed {
    position: absolute; inset: auto 8px 6px auto;
    font-family: var(--mono); font-size: 10px; color: var(--muted);
    background: var(--bg3); border: 1px solid var(--border); border-radius: 4px; padding: 2px 6px;
  }
</style>
