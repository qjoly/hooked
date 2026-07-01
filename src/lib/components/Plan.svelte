<script>
  import Markdown from './Markdown.svelte';

  // Plan proposé par Claude via ExitPlanMode, en attente d'approbation. Capté par les hooks
  // (le tool_use n'entre dans le transcript qu'une fois approuvé/rejeté), rendu en markdown.
  let { pp } = $props();
</script>

<div class="plan-card">
  <div class="plan-head">
    <span class="plan-ico">📋</span>
    <span class="plan-title">Plan proposé — en attente d'approbation</span>
  </div>
  <div class="plan-body md"><Markdown text={pp.plan} /></div>
</div>

<style>
  .plan-card {
    margin-top: 20px; padding: 16px 18px 14px; background: var(--surface);
    border: 1px solid rgba(176,90,52,.35); border-radius: 18px;
    box-shadow: var(--shadow); border-left: 4px solid var(--accent);
  }
  .plan-head { display: flex; align-items: center; gap: 9px; margin-bottom: 12px; }
  .plan-ico { font-size: 16px; }
  .plan-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--accent-d); }
  .plan-body { font-size: 13.5px; line-height: 1.6; color: var(--text); word-wrap: break-word; overflow-wrap: anywhere; }
  /* le contenu markdown est injecté via {@html} → styliser avec :global (mêmes valeurs que .bubble .md) */
  .plan-body :global(a) { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; word-break: break-all; }
  .plan-body :global(a:hover) { color: var(--accent-d); }
  .plan-body :global(code) { font-family: var(--mono); font-size: 12px; }
  .plan-body :global(:not(pre) > code) { background: var(--code-inline); padding: 1px 5px; border-radius: 5px; }
  .plan-body :global(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; max-width: 100%; }
  .plan-body :global(th), .plan-body :global(td) { border: 1px solid rgba(120,95,60,.28); padding: 4px 9px; text-align: left; vertical-align: top; }
  .plan-body :global(th) { background: rgba(120,95,60,.12); font-weight: 700; }
  .plan-body :global(blockquote) { margin: 6px 0; padding: 2px 0 2px 12px; border-left: 3px solid rgba(120,95,60,.38); color: var(--muted); }
</style>
