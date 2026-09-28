<script>
  import { copyText } from '$lib/clipboard.js';
  import Icon from '$lib/components/Icon.svelte';

  let { d } = $props();
  let copied = $state(false);
  // Deep-link vers la session dans hooked. Avant la migration hors tmux, ce bloc proposait la
  // commande `tmux attach -t …` : il n'y a plus de terminal à rattacher (la session est pilotée en
  // processus par l'Agent SDK), et le SDK nous donne enfin le session_id dès le lancement — donc on
  // propose le lien vers la session, ce que l'ancien flux ne pouvait pas faire.
  async function copy() {
    copied = (await copyText(location.origin + d.link)) ? true : 'manual';
  }
</script>

<h2 style="margin:0 0 10px"><Icon name="check" size={18} /> Session {d.forkedFrom ? 'forked' : 'launched'}</h2>
<p style="color:var(--muted);font-size:12.5px;line-height:1.6;margin:0 0 14px">
  <code>claude</code> is running in folder <code>{d.cwd}</code>.<br>
  Session <b>{(d.sessionId || '').slice(0, 8)}…</b></p>
{#if d.link}
  <div class="attach-row">
    <a href={d.link}>Open in hooked</a>
    <button class="reply-send" onclick={copy}>{#if copied === true}<Icon name="check" size={14} tint={false} /> copied{:else if copied === 'manual'}copy manually{:else}Copy link{/if}</button>
  </div>
{/if}
<p style="color:var(--muted);font-size:12px;margin:14px 0 0">
  You can reply to it directly from the UI.</p>
