<script>
  // Compte rendu d'une commande lancée depuis le composer (`!commande`), rendu comme une
  // transcription de terminal. La source est un bloc fencé `console` porté par le transcript, avec
  // son code de sortie et son dossier dans l'info-string (cf. server/agent.js → formatLocalCommand).
  //
  // Volontairement DIFFÉRENT de <CodeBlock> sur un point : les blocs de code sont codés en dur en
  // sombre dans les deux thèmes (c'est une citation de source, comme dans un éditeur), alors qu'ici
  // tout vient des variables CSS — donc le bloc suit clair/sombre, et les palettes Legacy et Datadog
  // sans une ligne de plus.
  import Icon from '$lib/components/Icon.svelte';

  let { code = '', meta = {} } = $props();

  // Première ligne = `$ <commande>`, le reste = la sortie. On ne se fie pas à un séparateur exotique :
  // le format est produit juste à côté, et cette forme reste lisible même sans ce composant.
  const parsed = $derived.by(() => {
    const lines = String(code).split('\n');
    const first = lines[0] || '';
    const m = first.match(/^\$\s?(.*)$/);
    return {
      command: m ? m[1] : first,
      output: lines.slice(m ? 1 : 0).join('\n').replace(/\n+$/, ''),
    };
  });
  const exitCode = $derived(meta && meta.exit !== undefined ? Number(meta.exit) : null);
  const failed = $derived(exitCode !== null && exitCode !== 0);
  const truncated = $derived(!!(meta && meta.truncated));
  const cwd = $derived((meta && meta.cwd) || '');
  // `~` pour le dossier personnel : un chemin absolu complet mange toute la ligne d'en-tête.
  const shortCwd = $derived.by(() => {
    if (!cwd) return '';
    const home = '/Users/';
    if (!cwd.startsWith(home)) return cwd;
    const rest = cwd.slice(home.length);
    const slash = rest.indexOf('/');
    return slash < 0 ? '~' : '~' + rest.slice(slash);
  });

  let copied = $state(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(parsed.output || parsed.command);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch (_) {}
  }
</script>

<div class="tb" class:failed>
  <div class="tb-head">
    <span class="tb-ico"><Icon name="shell" size={12} /></span>
    <code class="tb-cmd">{parsed.command}</code>
    {#if shortCwd}<span class="tb-cwd" title={cwd}>{shortCwd}</span>{/if}
    {#if exitCode !== null}
      <span class="tb-exit" title={failed ? 'Non-zero exit code' : 'Exited cleanly'}>
        {#if failed}<Icon name="close" size={11} />{:else}<Icon name="check" size={11} />{/if}{exitCode}
      </span>
    {/if}
    <button class="tb-copy" onclick={copy} title="Copy the output">
      {#if copied}<Icon name="check" size={12} />{:else}<Icon name="copy" size={12} />{/if}
    </button>
  </div>
  {#if parsed.output}
    <pre class="tb-out">{parsed.output}</pre>
  {:else}
    <div class="tb-empty">no output</div>
  {/if}
  {#if truncated}
    <div class="tb-trunc"><Icon name="warning" size={11} /> output truncated</div>
  {/if}
</div>

<style>
  /* Tout en variables CSS : le bloc suit le thème clair/sombre et la palette active. */
  .tb {
    margin: 6px 0; border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg3); overflow: hidden;
  }
  /* Échec : un liseré gauche suffit à le signaler sans repeindre tout le bloc en rouge. */
  .tb.failed { border-left: 2px solid var(--danger); }

  .tb-head {
    display: flex; align-items: center; gap: 7px; min-width: 0;
    padding: 4px 6px 4px 9px;
    background: var(--chip); border-bottom: 1px solid var(--border);
  }
  .tb-ico { color: var(--muted); display: inline-flex; flex: 0 0 auto; }
  .tb-cmd {
    font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--text);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto;
  }
  /* `$` en tête de commande, dessiné plutôt qu'écrit : il ne part pas à la copie. */
  .tb-cmd::before { content: '$ '; color: var(--accent); font-weight: 700; }
  .tb-cwd {
    flex: 0 0 auto; font-family: var(--mono); font-size: 10px; color: var(--muted);
    max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .tb-exit {
    flex: 0 0 auto; display: inline-flex; align-items: center; gap: 3px;
    font-family: var(--mono); font-size: 10px; font-weight: 700;
    color: var(--success); padding: 1px 5px; border-radius: 4px;
    background: var(--success-soft);
  }
  .tb.failed .tb-exit { color: var(--danger); background: var(--danger-soft); }
  .tb-copy {
    flex: 0 0 auto; background: transparent; border: 1px solid var(--border);
    color: var(--muted); border-radius: 5px; padding: 2px 5px; cursor: pointer;
    display: inline-flex; align-items: center;
  }
  .tb-copy:hover { color: var(--text); background: var(--hover); }

  .tb-out {
    margin: 0; padding: 8px 10px; max-height: 320px; overflow: auto;
    font-family: var(--mono); font-size: 11.5px; line-height: 1.5;
    color: var(--text); background: var(--bg3);
    white-space: pre-wrap; word-break: break-word;
  }
  .tb-empty {
    padding: 6px 10px; font-family: var(--mono); font-size: 11px;
    color: var(--muted); font-style: italic;
  }
  .tb-trunc {
    display: flex; align-items: center; gap: 5px;
    padding: 4px 10px; border-top: 1px solid var(--border);
    font-family: var(--mono); font-size: 10px; color: var(--warn); background: var(--warn-soft);
  }
</style>
