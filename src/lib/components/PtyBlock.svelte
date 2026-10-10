<script>
  // Terminal INTERACTIF rendu dans le fil de conversation. Source : un fence `pty` portant l'id du
  // PTY (cf. server/agent.js → formatInteractiveCommand), produit par `!!commande` dans le composer.
  //
  // Différence avec <TerminalBlock> (fence `console`) : celui-là est un compte rendu figé d'une
  // commande déjà terminée, celui-ci est un terminal VIVANT auquel on peut parler. C'est ce qui
  // débloque tout ce qui exige un tty — un mot de passe, une confirmation, `claude mcp login`, un
  // pager, un TUI.
  //
  // Un transcript survit à son PTY : après un redémarrage de hooked l'id ne désigne plus rien. On
  // vérifie donc l'existence AVANT de monter xterm, sinon un vieux message afficherait un rectangle
  // noir vide et inexplicable.
  import { onMount } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import Terminal from './Terminal.svelte';
  import { listTerminals, killTerminal } from '$lib/api.js';

  let { code = '', meta = {} } = $props();

  const termId = $derived((meta && meta.id) || '');
  const cwd = $derived((meta && meta.cwd) || '');
  // Première ligne = `$ <commande>`, même forme que le bloc `console`.
  const command = $derived.by(() => {
    const first = String(code).split('\n')[0] || '';
    const m = first.match(/^\$\s?(.*)$/);
    return m ? m[1] : first;
  });
  const shortCwd = $derived.by(() => {
    if (!cwd) return '';
    if (!cwd.startsWith('/Users/')) return cwd;
    const rest = cwd.slice(7);
    const slash = rest.indexOf('/');
    return slash < 0 ? '~' : '~' + rest.slice(slash);
  });

  // null = on ne sait pas encore, true/false = verdict.
  let exists = $state(null);
  let closing = $state(false);

  async function check() {
    if (!termId) { exists = false; return; }
    const res = await listTerminals().catch(() => null);
    // jget renvoie le corps brut : { ok, terminals }
    exists = !!(res && res.ok && (res.terminals || []).some((t) => t.id === termId));
  }
  onMount(check);

  async function close() {
    if (closing) return;
    closing = true;
    await killTerminal(termId).catch(() => {});
    closing = false;
    exists = false;
  }
</script>

<div class="pb" class:dead={exists === false}>
  <div class="pb-head">
    <span class="pb-ico"><Icon name="shell" size={12} /></span>
    <code class="pb-cmd">{command}</code>
    {#if shortCwd}<span class="pb-cwd" title={cwd}>{shortCwd}</span>{/if}
    {#if exists === true}
      <span class="pb-tag live">interactive</span>
      <button class="pb-x" disabled={closing} onclick={close} title="Close this terminal">
        <Icon name="close" size={12} />
      </button>
    {:else if exists === false}
      <span class="pb-tag">closed</span>
    {/if}
  </div>
  {#if exists === true}
    <div class="pb-term"><Terminal id={termId} onclosed={() => (exists = false)} /></div>
  {:else if exists === false}
    <div class="pb-gone">this terminal is gone — hooked restarted since, or it was closed</div>
  {/if}
</div>

<style>
  /* Tout en variables CSS, comme TerminalBlock : suit clair/sombre et toutes les palettes. */
  /* width 100% : la bulle parente est élargie pour nous (cf. ChatBubble), on la remplit. */
  .pb { width: 100%; margin: 6px 0; border: 1px solid var(--border); border-radius: 8px; background: var(--bg3); overflow: hidden; }
  /* vivant = contour d'accent : dans un fil long, on repère d'un coup d'œil le terminal actif */
  .pb:not(.dead) { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }

  .pb-head {
    display: flex; align-items: center; gap: 7px; min-width: 0;
    padding: 4px 6px 4px 9px; background: var(--chip); border-bottom: 1px solid var(--border);
  }
  .pb-ico { color: var(--muted); display: inline-flex; flex: 0 0 auto; }
  .pb-cmd {
    font-family: var(--mono); font-size: var(--t-meta); font-weight: 600; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto;
  }
  /* `$` dessiné, pas écrit : il ne part pas à la copie */
  .pb-cmd::before { content: '$ '; color: var(--accent); font-weight: 700; }
  .pb-cwd {
    flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); color: var(--muted);
    max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pb-tag {
    flex: 0 0 auto; font-family: var(--mono); font-size: var(--t-micro); font-weight: 700;
    color: var(--muted); background: var(--bg2); border-radius: 4px; padding: 1px 5px;
  }
  .pb-tag.live { color: var(--success); background: var(--success-soft); }
  .pb-x {
    flex: 0 0 auto; background: transparent; border: 1px solid var(--border); color: var(--muted);
    border-radius: 5px; padding: 2px 5px; cursor: pointer; display: inline-flex; align-items: center;
  }
  .pb-x:hover:not(:disabled) { color: var(--danger); background: var(--hover); }

  /* hauteur fixe : un terminal dans un fil ne doit pas pousser la conversation à l'infini */
  .pb-term { height: 340px; display: flex; flex-direction: column; }
  .pb-gone {
    padding: 7px 10px; font-family: var(--mono); font-size: var(--t-micro);
    color: var(--muted); font-style: italic;
  }
</style>
