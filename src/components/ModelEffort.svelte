<script>
  let { model = $bindable(''), effort = $bindable('') } = $props();
</script>

<div class="lf-row">
  <div>
    <label class="lf-label">Modèle</label>
    <select class="lf-input" bind:value={model}>
      <option value="">⚙️ défaut</option>
      <option value="opus">Opus</option>
      <option value="sonnet">Sonnet</option>
      <option value="haiku">Haiku</option>
      <option value="fable">Fable</option>
    </select>
  </div>
  <div>
    <label class="lf-label">Effort</label>
    <select class="lf-input" bind:value={effort}>
      <option value="">⚙️ défaut</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="xhigh">xhigh</option>
      <option value="max">max</option>
    </select>
  </div>
</div>
