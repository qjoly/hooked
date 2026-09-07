<script>
  import Icon from '$lib/components/Icon.svelte';

  let { todos } = $props();
  const ICON = { completed: 'checkbox-done', in_progress: 'in-progress', pending: 'checkbox' };
  const done = $derived(todos.filter((t) => t.status === 'completed').length);
  const pct = $derived(todos.length ? Math.round((done / todos.length) * 100) : 0);
</script>

{#if !todos.length}
  <div class="pane-empty">No tasks — Claude didn't use TodoWrite in this session.</div>
{:else}
  <div class="todos">
    <div class="todos-head">
      <span class="todos-frac">{done}/{todos.length} done</span>
      <div class="todos-track"><div class="todos-fill" style="width:{pct}%"></div></div>
    </div>
    <ul class="todo-list">
      {#each todos as t, i (i)}
        <li class="todo todo-{t.status}">
          <span class="todo-ico"><Icon name={ICON[t.status] || 'checkbox'} size={14} /></span>
          <span class="todo-body">
            <span class="todo-text">{t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}</span>
            {#if t.description}<span class="todo-desc">{t.description}</span>{/if}
          </span>
        </li>
      {/each}
    </ul>
  </div>
{/if}
