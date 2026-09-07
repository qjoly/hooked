<script>
  /*
   * A single file change (Write / Edit / MultiEdit / NotebookEdit) rendered as a
   * side-by-side (split) Pierre diff. Op → (old, new) mapping:
   *   write    : full rewrite   → old = pre-write content (or '' for a new file), new = content
   *   notebook : replaced cell → old '', new = new_source
   *   edit     : old = old_string, new = new_string
   */
  import PierreDiff from './PierreDiff.svelte';
  import Icon from '$lib/components/Icon.svelte';
  let { o, name = 'file.txt', commentable = false, comments = [], onCommit = null, onDelete = null } = $props();
  const oldStr = $derived(o.kind === 'notebook' ? '' : (o.old || ''));
  const newStr = $derived(o.kind === 'write' ? (o.content || '') : (o.new || ''));
</script>

<div class="diff">
  {#if o.kind === 'write'}<div class="diff-tag write"><Icon name="plus" size={12} /> {o.old ? 'full rewrite' : 'new content'}</div>{/if}
  {#if o.kind === 'notebook'}<div class="diff-tag write">notebook</div>{/if}
  {#if o.all}<div class="diff-tag">replace all occurrences</div>{/if}
  <PierreDiff {oldStr} {newStr} {name} diffStyle="split" {commentable} {comments} {onCommit} {onDelete} />
</div>
