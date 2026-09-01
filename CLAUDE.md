# CLAUDE.md — hooked

Dashboard local des sessions Claude Code. **Front SvelteKit / Svelte 5** ; **back Node stdlib** (`server/*` + `hook.cjs`) avec **une seule dépendance runtime côté pilotage** : l'**Agent SDK d'Anthropic** (`@anthropic-ai/claude-agent-sdk`). Le serveur **MCP** (`mcp/server.cjs`) est un client mince qui proxy l'API HTTP locale.

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

## Pilotage des sessions (`server/agent.js`)

Les sessions Claude Code tournent **dans le processus hooked**, via `query()` de l'Agent SDK en mode **streaming input/output**. `server/agent.js` tient un registre `session_id → entrée vivante` et expose tout le pilotage (lancement, réponse, interruption, mode, modèle/effort, kill/restart, réponses aux questions/plans/permissions).

- **Le registre est épinglé sur `globalThis`** (`Symbol.for('hooked.agent.registry')`). Sans ça, la ré-exécution de module de Vite après une modif back en `npm run live` repartirait d'un registre vide et **perdrait les sessions en cours** — elles vivent dans ce processus, pas dans un tmux détaché.
- **Une session ne survit pas à un redémarrage de hooked.** Le transcript, lui, reste sur disque (`~/.claude/projects/…`) → le bouton **Resume** relance `claude --resume`. C'est le compromis assumé du modèle « hooked possède le process ».
- **Les hooks globaux continuent de tourner.** `settingSources` est laissé au défaut (toutes les sources), donc `~/.claude/settings.json` — donc `hook.cjs`, donc `events.jsonl` — s'exécute pour les sessions du SDK comme pour une session ouverte à la main. **Ne pas passer `settingSources: []`** : ça couperait d'un coup les questions/plans en attente, les todos, les jobs de fond et la statusline. Vérifié de bout en bout : une session lancée par le SDK écrit bien `SessionStart` / `UserPromptSubmit` / `Stop` dans `events.jsonl`.
- **Deux couches se recouvrent volontairement pour l'état.** Le **registre** est autoritaire pour une session pilotée (la promesse `canUseTool` *est* l'attente, aucun décalage possible) ; les **évènements de hooks** restent le repli, et la seule source pour une session ouverte hors hooked — elle reste visible et à jour, simplement pas pilotable.
- **`canUseTool` bloque Claude** tant qu'on n'a pas résolu la promesse. Trois cas, un seul en attente à la fois :
  - `AskUserQuestion` → on renvoie `{behavior:'allow', updatedInput:{…, answers}}` (`answers` = map `texte de question → libellé`, virgules en multi-select) ;
  - `ExitPlanMode` → `allow` (+ `setPermissionMode` vers `acceptEdits`/`auto`) pour approuver, `deny` avec le feedback comme message pour refuser ;
  - **tout autre outil** = demande de permission. Elle est présentée à l'UI **sous la forme d'une AskUserQuestion à 3 options** (`Allow once` / `Allow always` / `Deny`) → le composant `Question` existant la rend sans une ligne de front en plus, et approuver un outil depuis le web devient possible (avant il fallait l'onglet Terminal, donc tmux). **L'ordre des options est un contrat** avec l'aiguillage de `answerPendingSelection` (indice 0/1/2).
- **Toujours libérer une attente avant de tuer/interrompre.** Une promesse `canUseTool` laissée pendante bloque le sous-processus à la sortie — `readLoop` (finally), `interruptSession` et `killSession` la résolvent tous.
- **L'environnement du profil utilisateur doit être réinjecté à la main.** L'ancien pilotage lançait `claude` via `$SHELL -l -i -c …`, donc `~/.zprofile` / `~/.zshrc` étaient sourcés. Le SDK spawne le CLI avec l'env de hooked — sous launchd, un PATH figé à l'installation du service. Mesuré : **26 entrées de PATH perdues** (`~/.krew/bin`, `~/.nix-profile/bin`, `~/go/bin`, `~/.local/bin`, `/sbin`, `/usr/sbin`…) et des variables réelles avec (`GITHUB_TOKEN`, `NIX_SSL_CERT_FILE`, `K9S_CONFIG_DIR`…) → `kubectl` sans son plugin d'auth OIDC, `gh` sans token. `loginEnv()` résout donc l'env du shell de login **une fois** (~1,8 s, async, caché sur `globalThis`, pré-chauffé à l'import) et le passe en `env` au SDK. Ordre de fusion `{...process.env, ...profil}` — le profil gagne, comme avant. Les variables du shell *résolveur* (`PWD`, `SHLVL`, `TMUX*`, `__MISE_*`) sont filtrées : les injecter serait faux.
  > Corollaire à garder en tête : si un profil exportait `ANTHROPIC_API_KEY`, toutes les sessions basculeraient sur la facturation API au lieu de l'abonnement. C'était déjà vrai du temps de tmux, mais ça reste un piège.
- **`bypassPermissions` court-circuite `canUseTool` pour les outils ordinaires**, pas pour `AskUserQuestion` / `ExitPlanMode` (vérifié en live sur `auto` ET `bypassPermissions` : les deux livrent bien la question au callback). Donc en mode bypass on perd la carte de permission — c'est l'effet voulu du mode — sans perdre les questions ni les plans. Le SDK émet un avertissement à chaque lancement dans ce mode : c'est du bruit, pas un bug.
- Le **premier prompt part immédiatement** : le SDK bufferise l'entrée jusqu'à ce que le CLI soit prêt. Rien à attendre, rien à détecter.

## Ce que la migration hors tmux a supprimé

Retiré parce que **spécifique à tmux**, sans équivalent : l'onglet **Terminal** (mirroir xterm d'un pane), le MCP `show_in_pane`, `Copy attach` / `tmux attach`, la **sidebar tmux** (`tmux/`), et le pilotage d'une session **lancée hors hooked** (il venait de `send-keys`). Les démons **remote-control** sont conservés : ce sont maintenant des **process détachés** supervisés par un fichier de PID (`rc-daemons.json`), reconnus dans le dashboard via `HOOKED_RC=1` → drapeau `rc` recopié par `hook.cjs`.

Ce qui n'a **plus besoin d'exister** (et ne doit pas revenir) : parsing du spinner / du footer de mode / du ghost text, comparaison de captures d'écran pour deviner « en train d'écrire vs terminé », délais anti-coalescence d'ink entre deux frappes, acceptation du dialogue de confiance, effacement du prompt réinjecté après un Échap, confirmation du dialogue « la conversation va être relue » après `/model`, et tout le pré-chauffage concurrent des captures (`warmPaneCaptures`) qui existait uniquement parce que `capture-pane` était synchrone et bloquait l'event loop.

## Page MCP (`server/mcp.js`, `/mcp`)

`/mcp` était un écran **TUI du CLI**. Les sessions vivant maintenant dans le processus hooked via
l'Agent SDK, il n'y a plus de terminal interactif où l'ouvrir : un serveur qui retombe en *Needs
authentication* devenait impossible à réparer depuis hooked. La page `/mcp` le remplace, bâtie sur
les sous-commandes **non interactives** `claude mcp list|get|login|logout`.

- **On parse la sortie texte de `claude mcp list`**, on ne lit pas les fichiers de config : c'est la
  seule source qui *health-check* tous les serveurs **et** voit les connecteurs claude.ai (ils vivent
  sur le compte, pas sur disque). Pas de mode JSON → le format **est** le contrat, épinglé par
  `test/mcp.test.mjs` sur des captures verbatim (`test/fixtures/mcp/`). Le **scope**, lui, est déduit
  du disque (`~/.claude.json` + `.mcp.json`) : gratuit, là où `claude mcp get` coûterait un spawn
  health-checké par serveur.
- **`claude mcp login` tourne sous un vrai PTY** (node-pty), pas `spawn` : il écrit l'URL via des
  hyperliens OSC-8 et, pour un serveur OAuth ordinaire, **attend sur stdin** qu'on lui recolle l'URL
  de redirection. Le PTY maintient ce process vivant entre les deux appels HTTP → les logins vivent
  dans un registre épinglé sur `globalThis` (même raison que les sessions et les terminaux).
- **`--no-browser` est toujours passé** : le navigateur doit s'ouvrir sur la machine qui *regarde* le
  dashboard, pas sur celle qui l'exécute. On affiche l'URL en lien ; si les deux machines sont la
  même, le callback OAuth retombe sur localhost et le CLI finit tout seul.
- **Un connecteur claude.ai sort du flux immédiatement** après avoir imprimé l'URL : l'approbation se
  fait ensuite sur le site. « Le process s'est terminé » n'y vaut donc **pas** « tu es authentifié »
  — d'où le drapeau `outOfBand` dans le snapshot, et le message distinct côté page.
- `stripCliAnsi` n'est pas le `stripAnsi` d'`agent.js` (qui ne retire que le CSI) : sans retirer les
  OSC-8, l'URL apparaît **deux fois** sur la ligne. Noms distincts obligatoires — `server/index.js`
  ré-exporte en `export *`, et un nom ambigu **disparaît silencieusement** du barrel.

## Svelte 5

- Piège réactivité : `if (term && x) …` court-circuite sur `term` null (créé en async) → la prop `x` n'est **jamais lue donc non suivie** comme dépendance, et un changement de `x` ne re-déclenche pas l'effet. **Lire les deps suivies AVANT les gardes.**

## Tests

- `npm test` (Vitest) = tests de caractérisation sur fixtures (`test/fixtures/…`, surchargés via `HOOKED_DATA_DIR` / `HOOKED_PROJECTS_DIR`). Le filet anti-régression du back.
- La dérivation d'état du flux SDK est **pure et testée sans lancer de session** : `applyMessage(st, msg)` (`test/agentState.test.mjs`) et `refineWithAgent(state, alive, sdkState)` (`test/refineState.test.mjs`).
- Pour tester un vrai bout-en-bout de pilotage : appeler `launchSession` / `deliverReply` / `killSession` de `server/agent.js` avec `HOOKED_DATA_DIR` sur un tmpdir et un projet jetable. Ça consomme un tour réel — à garder hors de `npm test`.
