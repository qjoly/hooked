/*
 * Registre des éditeurs de code supportés (« Open in … »). Module partagé, sans dépendance :
 * importé côté client (liens `ch-open` / `sd-editor` de la lentille Ship, page Réglages) ET
 * côté serveur (server/editor.js, qui ouvre le dossier projet via la CLI de l'éditeur).
 *
 * Ajouter un éditeur = ajouter une entrée ici, rien d'autre :
 *   key       identifiant stable persisté dans settings.json (`editor`)
 *   label     nom affiché
 *   icon      clé d'Icon.svelte (défaut : 'vscode', le glyphe générique `</>`)
 *   fileUrl   URL cliquable qui ouvre UN fichier (le navigateur délègue à l'OS) ; `line` optionnel
 *   cli       exécutable en PATH qui ouvre UN DOSSIER (appelé par le serveur via execFile)
 *   cliArgs   arguments passés à `cli` pour le dossier
 */

const EDITORS = [
  {
    key: 'vscode',
    label: 'VS Code',
    icon: 'vscode',
    // `--` protège un chemin commençant par un tiret.
    cli: 'code',
    cliArgs: (dir) => ['--', dir],
    fileUrl: (file, line) => `vscode://file${file}${line ? ':' + line : ''}`,
  },
  {
    key: 'zed',
    label: 'Zed',
    icon: 'vscode',
    cli: 'zed',
    cliArgs: (dir) => [dir],
    // zed://file<abs path>[:line[:col]]
    fileUrl: (file, line) => `zed://file${file}${line ? ':' + line : ''}`,
  },
  {
    key: 'cursor',
    label: 'Cursor',
    icon: 'vscode',
    cli: 'cursor',
    cliArgs: (dir) => ['--', dir],
    fileUrl: (file, line) => `cursor://file${file}${line ? ':' + line : ''}`,
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    icon: 'vscode',
    cli: 'windsurf',
    cliArgs: (dir) => ['--', dir],
    fileUrl: (file, line) => `windsurf://file${file}${line ? ':' + line : ''}`,
  },
  {
    key: 'sublime',
    label: 'Sublime Text',
    icon: 'vscode',
    cli: 'subl',
    cliArgs: (dir) => ['--', dir],
    // subl://open?url=file://…&line=… (le chemin doit être encodé, contrairement aux schémas vscode-like).
    fileUrl: (file, line) =>
      `subl://open?url=file://${encodeURIComponent(file)}${line ? '&line=' + line : ''}`,
  },
  {
    key: 'jetbrains',
    label: 'JetBrains (IDEA)',
    icon: 'vscode',
    cli: 'idea',
    cliArgs: (dir) => [dir],
    fileUrl: (file, line) =>
      `idea://open?file=${encodeURIComponent(file)}${line ? '&line=' + line : ''}`,
  },
];

const DEFAULT_EDITOR = 'vscode';
const EDITOR_KEYS = EDITORS.map((e) => e.key);

// Éditeur correspondant à une clé de réglage ; retombe sur le défaut si la clé est inconnue
// (settings.json édité à la main, ou entrée retirée du registre).
function editorFor(key) {
  return EDITORS.find((e) => e.key === key) || EDITORS.find((e) => e.key === DEFAULT_EDITOR);
}

export { EDITORS, EDITOR_KEYS, DEFAULT_EDITOR, editorFor };
