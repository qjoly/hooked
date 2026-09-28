# CLAUDE.md — hooked

Dashboard local des sessions Claude Code. **Front SvelteKit / Svelte 5** ; **back Node stdlib** (`server/*` + `hook.cjs`) avec **une seule dépendance runtime côté pilotage** : l'**Agent SDK d'Anthropic** (`@anthropic-ai/claude-agent-sdk`). Le serveur **MCP** (`mcp/server.cjs`) est un client mince qui proxy l'API HTTP locale.

## Contributing (English)

- **Never push to `main`.** All code lands via a pull request — this keeps a real changelog.
- **Write all code in English** (identifiers, comments, commit messages).
- **PR bodies are a plain list of the features added — nothing else.** One line per user-visible
  change. No implementation details (helper names, files touched, state shapes, test counts):
  reviews happen feature by feature, and the diff already tells the how.

## Workflow dev — IMPORTANT (source de confusion récurrente)

- **Redémarrer hooked = `mise run deploy`, jamais un kill à la main.** Les sessions pilotées
  vivent DANS le processus hooked : toute forme de redémarrage tue aussi la session Claude qui
  exécute la commande — c'est inévitable, et c'est prévu. `mise run deploy` est le seul chemin
  propre : rebuild, puis relance du service (`launchctl kickstart -k` / systemd `restart`), et au
  boot `resumeDrivenSessions()` reprend les sessions du dernier instantané — celle qui était en
  plein tour reçoit un « Continue » automatique et reprend son travail là où le redémarrage l'a
  coupée. Tuer le process autrement (`pkill node`, kill du port 4123, `launchctl unload`…) tue la
  session sans garantir ni rebuild ni relance ni reprise : Claude se tue lui-même pour rien.

- **`npm run live`** (Vite, `:4123`, `--strictPort`) = **le workflow live à privilégier** : HMR front **et** rechargement serveur. Les endpoints `/api/*` (`+server.js`) sont exécutés in-process par le dev server SvelteKit, et Vite ré-exécute les modules `server/*` / `$lib/server/*` modifiés à la requête suivante → une modif back est prise en compte sans rebuild ni redémarrage. Même port que la prod (4123) ; `strictPort` échoue franchement si `node build` squatte encore le port au lieu de dériver sur 4124.
- **`npm run dev`** (Vite, `:5173`) = identique à `live` mais sur le port Vite par défaut.
- **`npm start`** (`node build`, prod, souvent `:4123` via `PORT`) **ne se recharge PAS**. Après toute modif : **`mise run deploy`** (build + redémarrage du service, cf. première puce). **Jamais `npm run build` seul, même « juste pour tester que ça compile »** : il réécrit `build/` sous les pieds du service qui tourne et kill hooked — pour vérifier sans déployer, `npm test`. Le redémarrage est nécessaire car :
  - le bundle serveur est chargé en mémoire au démarrage ;
  - le HTML servi pointe des hashes d'assets **figés au build** ;
  - `static/` est servi par **sirv**, qui liste le dossier **au démarrage** → un fichier ajouté après (ex. une police) renvoie 404 tant qu'on n'a pas redémarré.
- C'est une **SPA** : naviguer entre sessions = routing client → l'onglet garde l'ancien JS. Pour charger du nouveau code il faut un **rechargement complet du navigateur** (Cmd+Shift+R), pas un clic in-app.
- Avant de conclure « ça ne marche pas », vérifier qu'on teste bien le **dernier build** (process `node build` redémarré + hard-reload), surtout sur navigateur Gecko/Firefox.

## Pilotage des sessions (`server/agent.js`)

Les sessions Claude Code tournent **dans le processus hooked**, via `query()` de l'Agent SDK en mode **streaming input/output**. `server/agent.js` tient un registre `session_id → entrée vivante` et expose tout le pilotage (lancement, réponse, interruption, mode, modèle/effort, kill/restart, réponses aux questions/plans/permissions).

- **Le registre est épinglé sur `globalThis`** (`Symbol.for('hooked.agent.registry')`). Sans ça, la ré-exécution de module de Vite après une modif back en `npm run live` repartirait d'un registre vide et **perdrait les sessions en cours** — elles vivent dans ce processus, pas dans un tmux détaché.
- **Un tour en cours ne survit pas à un redémarrage de hooked, la session si.** Le process meurt avec hooked (c'est le compromis assumé du modèle « hooked possède le process »), mais un **instantané du jeu piloté** est tenu à jour dans `driven-sessions.json` et **rejoué au démarrage** : `resumeDrivenSessions()` relance chaque entrée en `--resume`, séquentiellement. Une session qui **attendait** repart sans prompt (donc sans consommer de tour) ; une session tuée **en plein tour** (`busy` au dernier instantané) reçoit un **« Continue » automatique** — le redémarrage lui a volé son tour, on le relance (`HOOKED_NO_CONTINUE=1` coupe ce prompt sans couper la reprise). Garde-fous : **6 sessions max** par boot, et rien n'est réveillé si l'instantané a **plus de 12 h** — hooked éteint depuis une semaine ne doit pas spawner six CLI au login. `HOOKED_NO_RESUME=1` coupe le mécanisme. L'instantané est écrit **par sondage (10 s)** et non à chaque mutation de `live` : le registre est muté depuis six endroits, en oublier un donnerait un fichier faux. Le bouton **Resume** reste là pour tout le reste.
- **« Terminée » n'est pas « archivée ».** Un redémarrage tue les sous-process → `SessionEnd` → `ended`. `isSessionArchived()` assimilait ça à un archivage, donc la session quittait la liste active et il fallait la repêcher dans l'onglet Archived. Une session terminée ne compte comme archivée qu'une fois **froide** (24 h sans activité, cf. `isFinishedAndCold` dans `format.js`) ; un archivage **explicite** déplace toujours immédiatement.
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
- **Aucune statusline ne tourne pour une session pilotée** — c'est un rendu du TUI. Le tap
  `statusline-tap.sh` ne peut donc rien déposer pour elles, et tout ce qui n'existe que là
  (remplissage du contexte, rate limits 5 h / 7 j fraîchement rendus) restait figé sur le dernier
  terminal ouvert à la main. `server/agent-status.js` interroge la `Query` à la place
  (`getContextUsage()` + `usage_EXPERIMENTAL_…()`, cette dernière cherchée **par préfixe** : le nom
  changera à la stabilisation) et écrit dans `STATUS_DIR` **au format de la statusline** — un seul
  format, deux producteurs, `status.js` / `stats.js` / l'UI inchangés. Rafraîchi à la fin de chaque
  tour, throttlé (15 s) en cours de tour, best-effort. Corollaire côté lecture : entre un snapshot
  et le poll `/api/oauth/usage`, c'est **le plus frais qui gagne** — un fichier vieux de trois jours
  ne doit pas geler les jauges.

- Le **premier prompt part immédiatement** : le SDK bufferise l'entrée jusqu'à ce que le CLI soit prêt. Rien à attendre, rien à détecter.

- **Le cache de prompt est côté serveur, pas dans le process.** Il est indexé sur les octets exacts du
  préfixe (outils → system → messages) et vit **1 h après le début de la dernière requête** (TTL
  automatique du CLI sur abonnement dans les limites du plan ; 5 min en overage / clé API), chaque
  lecture le rafraîchissant gratuitement. Un CLI vivant mais idle ne garde donc rien au chaud, et un
  `--resume` retrouve le cache si le préfixe rebâti est identique. Mesuré sur 45 jours de transcripts :
  93 % de hits jusqu'à 55 min de pause, 2 % au-delà d'1 h ; et **un tiers des misses étaient évitables**
  — dont hooked qui repassait le `model` du snapshot à chaque reprise, écrasant le choix fait en
  cours de session (opus ↔ fable à chaque deploy, 300k+ tokens recachés à chaque fois). D'où :
  - **à la reprise, jamais de `model`** (le CLI restaure celui du transcript ; `--model` l'écrase) et
    **le même `effort`, explicitement** (le CLI ne le restaure pas — claude-code#66005) :
    `resumeLaunchArgs()`, pur, testé ; le snapshot porte l'effort *effectif* ;
  - le modèle de cache vit dans `src/lib/promptCache.js` (pur, partagé serveur/UI) ; le registre
    date chaque requête (`isRequestStart`) et garde `lastUsage` du `result` (= le `context_tokens`
    du CLI, vérifié égal en live) ; à la reprise l'horloge est amorcée depuis le transcript ;
  - **Auto-compact** (réglage hooked `autoCompact`, désactivé par défaut, seuil `minContextK` = 100k) :
    `/compact` ~5 min avant l'expiration (55 min en TTL 1 h) sur toute session pilotée qui attend une
    réponse. Compacter tant que le cache est chaud relit la conversation au tarif lecture et laisse un
    résumé : revenir 2 h ou un jour plus tard recache le résumé, pas le fil. Vérifié en live : `/compact`
    poussé dans l'entrée du SDK = un tour à part, clos par un `result` (`turns: 0`), sans message
    assistant, qui lit bien le préfixe en cache. Jamais sur un cache froid, jamais pendant une question
    (`canUseTool` bloque le tour), jamais sous le seuil (un recache froid y est bon marché, compacter
    perdrait le fil pour rien). Pas de répétition : le `compact_boundary` remet l'horloge et la taille à
    inconnues, la session ne redevient éligible qu'après un vrai tour. **Avec perte** — d'où l'opt-in.
    Dans la conversation, la compaction devient **une** ligne système, et le résumé (`isCompactSummary`)
    comme l'écho d'un `/compact` nu ne sont plus des bulles « You » ;
  - **changement de modèle à chaud = cache jeté** (caches par modèle) : le hook SDK `PreModelSwitch`
    refuse un `setModel` que hooked a demandé tant que `prompt_cache_warm`, et `/api/model` répond
    `{ held, cacheImpact }` avec les chiffres du CLI ; l'UI confirme et renvoie avec `force`. Vérifié
    en live : le hook tranche bien AVANT la résolution de `setModel()`.

## Groupes de sessions (`server/sessionMeta.js`, `GroupTabs.svelte`)

Toute session appartient à **un** groupe ; une session seule est un groupe implicite à un membre
(rien de stocké, rendu strictement identique à avant). Les panneaux (sidebar, flotte du Deck)
listent des **groupes**, via `groupUnits()` de `state.svelte.js`.

- **Un groupe est identifié par sa session mère.** Stockage dans `session-meta.json` : chaque fille
  porte `groupOf: <mère>` (+ `groupAt`, qui ordonne les filles), la mère porte l'éventuel
  `groupName`. **Un seul niveau** : les chaînes sont aplaties et les cycles écartés à la lecture.
- **Lien MCP automatique.** Le CLI n'expose aucun id de session à ses serveurs MCP. hooked injecte
  donc `HOOKED_LAUNCH_KEY` (la `launchKey` de l'entrée du registre) dans l'env du proxy
  `mcp/server.cjs` ; `start_session` la renvoie en `parentKey` et `launchSession` range la
  nouvelle session dans le groupe de l'appelante. Ne marche que pour une appelante **pilotée par
  hooked** — une session ouverte à la main n'a pas de clé.
- **Archiver la mère archive tout le groupe** ; une fille s'archive seule et reste dans son groupe.

## Ce que la migration hors tmux a supprimé

Retiré parce que **spécifique à tmux**, sans équivalent : l'onglet **Terminal** (mirroir xterm d'un pane), le MCP `show_in_pane`, `Copy attach` / `tmux attach`, la **sidebar tmux** (`tmux/`), et le pilotage d'une session **lancée hors hooked** (il venait de `send-keys`). Les démons **remote-control** sont conservés : ce sont maintenant des **process détachés** supervisés par un fichier de PID (`rc-daemons.json`), reconnus dans le dashboard via `HOOKED_RC=1` → drapeau `rc` recopié par `hook.cjs`.

Ce qui n'a **plus besoin d'exister** (et ne doit pas revenir) : parsing du spinner / du footer de mode / du ghost text, comparaison de captures d'écran pour deviner « en train d'écrire vs terminé », délais anti-coalescence d'ink entre deux frappes, acceptation du dialogue de confiance, effacement du prompt réinjecté après un Échap, confirmation du dialogue « la conversation va être relue » après `/model`, et tout le pré-chauffage concurrent des captures (`warmPaneCaptures`) qui existait uniquement parce que `capture-pane` était synchrone et bloquait l'event loop.

## Lentille MCP (`server/mcp.js`, `Mcp.svelte`)

`/mcp` était un écran **TUI du CLI**. Les sessions vivant maintenant dans le processus hooked via
l'Agent SDK, il n'y a plus de terminal interactif où l'ouvrir : un serveur qui retombe en *Needs
authentication* devenait impossible à réparer depuis hooked. La **lentille MCP** du workspace
(touche `4`, à côté de Converse / Review) le remplace, bâtie sur les sous-commandes **non
interactives** `claude mcp list|get|login|logout`.

- **C'est une lentille de session, pas une page de nav.** Les scopes MCP sont **par-répertoire** :
  la lentille prend le `project` de la session ouverte, donc le sélecteur de projet (et le
  `Browse…`) de l'ancienne page `/mcp` n'a plus de raison d'être. `SessionDetail` échange la prop
  `id` sans remonter → `Mcp.svelte` refetch sur un `$effect` qui suit `project`.

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
- La dérivation d'état du flux SDK est **pure et testée sans lancer de session** : `applyMessage(st, msg)` (`test/agentState.test.mjs`) et `refineWithAgent(state, alive, sdkState)` (`test/refineState.test.mjs`).
- Pour tester un vrai bout-en-bout de pilotage : appeler `launchSession` / `deliverReply` / `killSession` de `server/agent.js` avec `HOOKED_DATA_DIR` sur un tmpdir et un projet jetable. Ça consomme un tour réel — à garder hors de `npm test`.
