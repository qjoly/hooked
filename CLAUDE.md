# CLAUDE.md — hooked

Dashboard local des sessions Claude Code. **Back zéro dépendance** (stdlib Node : `server/*` + `hook.cjs`) ; **front SvelteKit / Svelte 5** ; pilotage des sessions via **tmux** (`send-keys` / `capture-pane` / `pipe-pane`). Le serveur **MCP** (`mcp/server.cjs`) est un client mince qui proxy l'API HTTP locale.

## Contributing (English)

- **Never push to `main`.** All code lands via a pull request — this keeps a real changelog.
- **Write all code in English** (identifiers, comments, commit messages).

## Workflow dev — IMPORTANT (source de confusion récurrente)

- **`npm run live`** (Vite, `:4123`, `--strictPort`) = **le workflow live à privilégier** : HMR front **et** rechargement serveur. Les endpoints `/api/*` (`+server.js`) sont exécutés in-process par le dev server SvelteKit, et Vite ré-exécute les modules `server/*` / `$lib/server/*` modifiés à la requête suivante → une modif back est prise en compte sans rebuild ni redémarrage. Même port que la prod (4123) ; `strictPort` échoue franchement si `node build` squatte encore le port au lieu de dériver sur 4124.
- **`npm run dev`** (Vite, `:5173`) = identique à `live` mais sur le port Vite par défaut.
- **`npm start`** (`node build`, prod, souvent `:4123` via `PORT`) **ne se recharge PAS**. Après toute modif : **`npm run build` PUIS redémarrer `node build`**, car :
  - le bundle serveur est chargé en mémoire au démarrage ;
  - le HTML servi pointe des hashes d'assets **figés au build** ;
  - `static/` est servi par **sirv**, qui liste le dossier **au démarrage** → un fichier ajouté après (ex. une police) renvoie 404 tant qu'on n'a pas redémarré.
- C'est une **SPA** : naviguer entre sessions = routing client → l'onglet garde l'ancien JS. Pour charger du nouveau code il faut un **rechargement complet du navigateur** (Cmd+Shift+R), pas un clic in-app.
- Avant de conclure « ça ne marche pas », vérifier qu'on teste bien le **dernier build** (process `node build` redémarré + hard-reload), surtout sur navigateur Gecko/Firefox.

## Onglet Terminal (mirroir tmux → xterm) — gotchas

Le terminal web mirrore un pane tmux : amorçage par `capture-pane`, puis **stream incrémental** via `pipe-pane` → fichier → SSE (`/api/pane/stream`) → `xterm.write`. Saisie clavier via `send-keys`. Pièges durement acquis (cf. `server/pane.js`, `server/paneStream.js`, `Terminal.svelte`) :

- **Un nouveau pane = une nouvelle FENÊTRE tmux, pas un split** (défaut de `showInPane`). Un split partage la fenêtre → chaque pane n'a qu'une **fraction de la hauteur**, et le mode Adapter (`resize-window`) gonfle la **fenêtre** mais pas le pane individuel → gros vide sous le programme + pane Claude rétréci. `new-window` se cible sur la **session** (`-t <pane>` échoue : « can't specify pane here ») ; `split-window` se cible sur le pane.
- **Mode Adapter** = `tmux resize-window` (passe la fenêtre en `window-size=manual`, marche sur session détachée, persiste, pane-cible résolu vers sa fenêtre). À la fermeture de la vue web : restaurer `window-size latest` (rattachement Ghostty normal). Mesurer la hauteur dispo en **JS** (haut de la boîte → bas du viewport), pas un `calc(100dvh - …)` en dur (l'en-tête est haut/variable).
- **Snapshot `capture-pane`** : lignes séparées par des `\n` simples (lignes *logiques*). Peindre **chaque ligne en position absolue** (`ESC[<row>;1H`), JAMAIS recoller avec `\n`/`\r\n` (escalier ; et une ligne pleine largeur cumule auto-wrap + saut de ligne). `capture-pane` n'émet **ni position curseur ni modes** → pour un TUI rejoint en cours (nvim, claude), rejouer depuis les format vars tmux : `cursor_x/y`, `alternate_on`, `cursor_flag`, `keypad_cursor_flag`, `keypad_flag`, `wrap_flag` (écran alterné, touches curseur applicatives…), sinon flèches/redraws cassés.
- **Lecture du flux SÉRIALISÉE** : `fs.watch` + poll de secours lisent depuis un offset partagé `st.pos` → deux lectures concurrentes **dupliquent ET sautent** des octets ; un `ESC[J` (effacement) sauté = **lignes fantômes** quand un TUI rétrécit. Verrou `reading` + `pendingRead`.
- **Saisie : un `onData` xterm = un `send-keys` séparé, jamais fusionné.** Un ESC (`0x1b`) collé aux octets suivants est lu comme une **séquence d'échappement** (flèche/méta), pas un Échap → « Échap ne marche pas ». Utiliser `send-keys -H` (hex) pour forwarder octets bruts / de contrôle proprement.
- **Firefox/Gecko** : la touche **Échap déclenche `window.stop()`** → avorte le flux SSE. `preventDefault` sur Échap (en capture, **sans** `stopPropagation` pour que xterm émette quand même l'ESC).
- **JSON ≠ octets de contrôle bruts** : un ESC brut dans un body JSON = JSON invalide (400). `JSON.stringify` l'échappe en `\u001b` (le client s'en charge).
- **Cache pane→nom de 3 s** (`paneTmuxNames`) : un pane tout neuf paraît « mort » (`tmuxAlive` faux) jusqu'à 3 s → appeler `invalidatePaneCache()` après création ; un test qui capture juste après doit attendre > 3 s.
- **Polices empaquetées** (`static/fonts/` : JetBrains Mono + Symbols Nerd Font) : `await document.fonts.load(...)` **avant** que xterm mesure la grille, sinon cellules mal dimensionnées.
- Le pane **Claude Code n'est pas fermable** (pas de ✕) ; seuls les panes « show » le sont.

## Workflows (outil `Workflow`) — deux sources, jamais les deux à la fois

La carte « Workflows » du dock (cf. `server/workflows.js`) reconstruit ce que montre le `/workflows`
de la CLI. Le piège structurant :

- **`<proj>/<session>/workflows/<runId>.json` n'est écrit qu'À LA FIN** du run (ou au kill), d'un
  seul bloc — jamais pendant. Il porte `workflowProgress[]`, le modèle exact du TUI (labels,
  `phaseTitle`, états, tokens, tool calls, aperçus). Quand il existe, il fait autorité.
- **Pendant le run**, seuls existent `<session>/subagents/workflows/<runId>/journal.jsonl`
  (`{type:"started"|"result", key, agentId}`) et un `agent-<id>.jsonl` par agent démarré.
  **Ni les `label`, ni l'attribution agent→phase n'existent sur disque** tant que le run tourne
  (la CLI les tient en mémoire) : ne pas les deviner. On affiche les phases déclarées dans le `meta`
  du script, et on distingue les agents par la première ligne de prompt qui leur est propre (le
  préambule commun est retiré).
- Le compteur de tokens du TUI est le **contexte de pointe** d'une requête
  (`input + cache_read + cache_creation`), pas l'usage cumulé — sommer les usages le surestime d'un
  facteur ~30.
- Les chemins d'un run se **déduisent du transcript de la session**, jamais des chemins absolus
  enregistrés dans le `toolUseResult` (source de données ≠ source de confiance, et une arborescence
  relogée reste lisible).
- Le lancement (`toolUseResult.status === "async_launched"`) et la complétion
  (`<task-notification>`, même triple porteur redondant que `server/background.js`) vivent dans le
  transcript principal.

## Svelte 5

- Piège réactivité : `if (term && x) …` court-circuite sur `term` null (créé en async) → la prop `x` n'est **jamais lue donc non suivie** comme dépendance, et un changement de `x` ne re-déclenche pas l'effet. **Lire les deps suivies AVANT les gardes.**

## Tests

- `npm test` (Vitest) = tests de caractérisation sur fixtures (`test/fixtures/…`, surchargés via `HOOKED_DATA_DIR` / `HOOKED_PROJECTS_DIR`). Le filet anti-régression du back.
- Pour tester le pilotage tmux sans toucher aux vraies sessions : créer une session tmux jetable, écrire un `events.jsonl` fixture pointant un `tmux_pane` réel, et appeler les fonctions `server/*` avec `HOOKED_DATA_DIR` sur un tmpdir.
