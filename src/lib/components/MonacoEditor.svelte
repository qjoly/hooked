<script>
  /*
   * Wrapper Monaco (browser-only, lazy) — jumeau conceptuel de PierreDiff.svelte (import
   * dynamique dans onMount, thème piloté par themeType()).
   *
   * Deux modes selon `original` :
   *   - original === null → éditeur simple (createModel + create).
   *   - original !== null → éditeur de DIFF (createDiffEditor) : `original` à gauche (lecture
   *     seule), `value` à droite (éditable si !readOnly). C'est le « voir + éditer le diff ».
   *
   * `value` est piloté par le parent : quand Claude réécrit le fichier sur disque, le parent
   * pousse le nouveau contenu → l'effet ci-dessous fait model.setValue() → on ÉCRASE le buffer
   * (Claude a la priorité). Le drapeau `applyingExternal` empêche que ce setValue ne re-déclenche
   * onChange (pas de boucle / pas de re-save de ce qu'on vient de recevoir).
   */
  import { onMount } from 'svelte';
  import { themeType } from '$lib/theme.svelte.js';
  // `$lib/monaco.js` fait des imports STATIQUES `?worker` + touche `self` : browser-only. On
  // l'importe DYNAMIQUEMENT dans onMount pour le garder HORS du graphe SSR (sinon rendu serveur
  // cassé). langFromName est résolu au même endroit.
  let langFromName = (n) => 'plaintext';

  let {
    value = '',
    original = null,   // null → éditeur simple ; string → éditeur de diff (côté gauche)
    name = 'file.txt',
    readOnly = false,
    onChange = null,   // (newValue) => void  — édition utilisateur uniquement
  } = $props();

  let host;
  let monaco = null;
  let editor = null;      // IStandaloneCodeEditor | IStandaloneDiffEditor
  let model = null;       // modèle éditable (modifié)
  let origModel = null;   // modèle gauche (diff)
  let ready = $state(false);
  let applyingExternal = false;

  // `original` est fixé pour la durée de vie de l'instance (le parent remonte via {#key} au
  // changement de vue diff/edit) → capture unique, volontaire.
  const isDiff = $derived(original != null);
  const themeName = (tt) => (tt === 'dark' ? 'vs-dark' : 'vs');
  // L'éditeur de code réel (le diff en enveloppe deux) — pour position curseur & options.
  const codeEditor = () => (isDiff ? editor?.getModifiedEditor?.() : editor);

  onMount(() => {
    let alive = true;
    (async () => {
      const mod = await import('$lib/monaco.js');
      langFromName = mod.langFromName;
      monaco = await mod.getMonaco();
      if (!alive || !host) return;
      const lang = langFromName(name);
      const opts = {
        theme: themeName(themeType()), readOnly, automaticLayout: true,
        minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13,
        tabSize: 2, renderWhitespace: 'selection', smoothScrolling: true,
      };
      model = monaco.editor.createModel(value ?? '', lang);
      if (isDiff) {
        origModel = monaco.editor.createModel(original ?? '', lang);
        // Diff RESPONSIVE : side-by-side quand large, mais bascule en vue INLINE (pleine largeur)
        // dès que l'éditeur est plus étroit que le breakpoint — sinon, en colonne split, la moitié
        // « original » (souvent vide) écrase le code à ~130px (cf. bug « pas assez large »).
        editor = monaco.editor.createDiffEditor(host, {
          ...opts, originalEditable: false, ignoreTrimWhitespace: false,
          renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true, renderSideBySideInlineBreakpoint: 900,
        });
        editor.setModel({ original: origModel, modified: model });
      } else {
        editor = monaco.editor.create(host, { ...opts, model });
      }
      model.onDidChangeContent(() => {
        if (applyingExternal) return;
        onChange && onChange(model.getValue());
      });
      ready = true;
    })();
    return () => {
      alive = false;
      try { editor?.dispose?.(); } catch (_) {}
      try { model?.dispose?.(); } catch (_) {}
      try { origModel?.dispose?.(); } catch (_) {}
      editor = model = origModel = null;
    };
  });

  // `value` externe (ex. écriture de Claude) → on écrase le buffer. Claude gagne. On tente de
  // garder la position curseur (utile si l'utilisateur lisait ailleurs), sans garantie si le
  // contenu a beaucoup bougé.
  $effect(() => {
    const v = value ?? '';
    if (!ready || !model) return;
    if (model.getValue() === v) return;
    applyingExternal = true;
    const ed = codeEditor();
    const pos = ed?.getPosition?.();
    model.setValue(v);
    try { if (pos && ed?.setPosition) ed.setPosition(pos); } catch (_) {}
    applyingExternal = false;
  });

  // Baseline (côté gauche du diff) mise à jour par le parent.
  $effect(() => {
    const o = original ?? '';
    if (!ready || !origModel || !isDiff) return;
    if (origModel.getValue() !== o) origModel.setValue(o);
  });

  // Bascule lecture seule.
  $effect(() => {
    const ro = readOnly;
    if (!ready || !editor) return;
    try { editor.updateOptions({ readOnly: ro }); } catch (_) {}
  });

  // Thème clair/sombre.
  $effect(() => {
    const tt = themeType();
    if (!ready || !monaco) return;
    monaco.editor.setTheme(themeName(tt));
  });
</script>

<div class="monaco-host" bind:this={host}></div>

<style>
  /* Ancrage ABSOLU dans le parent .ide-editor (position:relative) : l'hôte ne contribue pas à la
     hauteur du parent → pas de boucle de rétroaction avec automaticLayout (sinon l'éditeur grandit
     à l'infini en mode edit), et il remplit toujours toute la largeur/hauteur dispo (mode diff). */
  .monaco-host { position: absolute; inset: 0; }
</style>
