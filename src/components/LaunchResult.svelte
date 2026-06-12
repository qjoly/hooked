<script>
  let { d } = $props();
  let copied = $state(false);
  async function copy() {
    try { await navigator.clipboard.writeText(d.attach); copied = true; } catch (_) { copied = 'manual'; }
  }
</script>

<h2 style="margin:0 0 10px">✓ Session {d.resume ? 'reprise' : 'lancée'}</h2>
<p style="color:var(--muted);font-size:12.5px;line-height:1.6;margin:0 0 14px">
  <code>claude{d.resume ? ' --resume ' + d.resume.slice(0, 8) + '…' : ''}</code> tourne dans la session tmux
  <b>{d.tmux}</b><br>dossier <code>{d.cwd}</code>. Attache-toi :</p>
<div class="attach-row">
  <code>{d.attach}</code>
  <button class="reply-send" onclick={copy}>{copied === true ? '✓ copié' : copied === 'manual' ? 'copie manuelle' : 'Copier'}</button>
</div>
<p style="color:var(--muted);font-size:12px;margin:14px 0 0">
  Elle apparaîtra dans la liste dès le premier évènement de hook — tu pourras alors répondre directement depuis l'UI.</p>
