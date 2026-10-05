# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Développeurs de Lucca qui utilisent Claude Code au quotidien et font tourner **plusieurs sessions
en parallèle**. Leur métier n'est pas hooked : c'est leur code. hooked est l'écran de contrôle
à côté.

Trois scènes d'usage confirmées, toutes les trois de premier rang :

- **Second écran, en périphérie** — fenêtre ouverte en permanence à côté de l'éditeur. La question
  posée au coup d'œil est « laquelle de mes sessions attend quelque chose de moi ? », en moins
  d'une seconde, sans lire.
- **Mobile, loin du poste** — téléphone depuis une réunion ou le canapé. Savoir qui est bloqué,
  et répondre (une question à choix, une permission, un message court) sans revenir au clavier.
- **Plein écran, session active** — on bascule dessus pour lire vraiment : la conversation, un
  diff, un plan, les sous-agents. Là, la lecture longue prime sur la vue d'ensemble.

Secondairement : démo / screenshare devant d'autres personnes — d'où le mode incognito, qui
masque tout sauf les sessions explicitement marquées.

Corollaire du public : hooked doit s'installer et se comprendre **sans son auteur à côté**. Un
collègue qui clone le repo doit pouvoir démarrer et saisir l'état de ses sessions seul.

## Product Purpose

Suivre et piloter ses sessions Claude Code depuis le navigateur, en local.

Quand on jongle entre plusieurs sessions dans des terminaux, on perd le fil : laquelle attend une
réponse, laquelle travaille encore, combien ça a coûté aujourd'hui. hooked regroupe tout dans une
page : l'état live de chaque session, la conversation reconstruite, les fichiers modifiés, les
todos, les sous-agents, les workflows — et de quoi **répondre à Claude** (message, question à
choix, approbation de permission, plan) sans ouvrir un terminal.

Succès = le développeur n'a plus besoin de cycler entre ses terminaux pour savoir où il en est, et
une session bloquée ne reste pas bloquée pendant qu'il est ailleurs.

## Positioning

Les sessions **tournent dans le processus hooked**, via l'Agent SDK d'Anthropic en streaming
input/output — pas de `claude -p`, pas de scraping de terminal. C'est ce qui rend hooked différent
d'un lecteur de transcripts : il est l'hôte de la session, donc il connaît son état réel sans le
deviner, et il peut l'interrompre, lui répondre, changer son mode ou son modèle.

Deux conséquences qui ne se copient pas sans ce choix d'architecture :

- l'état affiché est **autoritaire** (la promesse `canUseTool` *est* l'attente), pas une
  interprétation d'un spinner ou d'un footer ;
- approuver un outil, répondre à une `AskUserQuestion` ou valider un plan **depuis un navigateur**
  devient possible, y compris depuis un téléphone.

## Operating Context

- Tourne en local sur la machine du développeur (`http://localhost:4123`), souvent en service
  launchd (macOS) ou systemd. Sous Windows, via WSL2.
- Lit `~/.claude` : transcripts, `settings.json`, hooks (`hook.cjs` → `events.jsonl`), statusline.
  Les sessions ouvertes **à la main** dans un terminal restent visibles et à jour — simplement pas
  pilotables.
- Les sessions sont regroupées : toute session appartient à un groupe, une sous-session lancée par
  MCP rejoint automatiquement le groupe de sa mère.
- Redémarrer hooked tue les tours en cours mais pas les sessions : un instantané est rejoué au
  démarrage (`--resume`), celle qui était en plein tour reçoit un « Continue ».
- Le dashboard est une SPA ; l'état live arrive par SSE.

## Capabilities and Constraints

Confirmé et fonctionnel :

- vue d'ensemble des sessions groupées par état (action requise / en attente de toi / Claude
  travaille / récentes), recherche plein texte, filtres par statut, projet et tags ;
- détail d'une session en lentilles : Conversation, Fichiers (diffs), Tâches, Sous-agents,
  Activité, Review, MCP ;
- composer : message, autocomplétion `@fichier`, collage d'image, file d'attente, `Échap` pour
  interrompre ;
- réponse aux questions à choix, aux demandes de permission (Allow once / Allow always / Deny) et
  aux plans ;
- lancement, reprise, fork, arrêt d'une session ; changement de mode, de modèle et d'effort ;
- stats d'usage (coût estimé, tokens, tours) par jour / modèle / projet / outil ;
- digest, mémoire, workflows, lentille MCP, mode incognito ;
- serveur MCP (`mcp/server.cjs`) qui proxy l'API locale, permettant à une session de lancer et
  piloter d'autres sessions.

Contraintes techniques actuelles (faits, pas engagements) :

- front **SvelteKit / Svelte 5**, back **Node stdlib** (`server/*` + `hook.cjs`), seule dépendance
  runtime de pilotage : `@anthropic-ai/claude-agent-sdk`. Node ≥ 24 (`node:sqlite`) ;
- `npm start` ne se recharge pas : toute modif back exige un rebuild + redémarrage du service ;
- les polices sont servies localement par `sirv`, qui liste `static/` au démarrage.

Volontairement non figé : la **densité d'information** n'est pas un engagement — un redesign peut
aérer s'il sert mieux les trois scènes d'usage.

## Brand Commitments

- Nom : **hooked**, en minuscules. Emoji associé : 🪝.
- Le produit parle **français** à l'utilisateur (README, docs internes) mais **tout le code,
  les identifiants, les commentaires et les PR sont en anglais**.
- Pas d'identité graphique imposée par ailleurs : aucun logo, aucune charte Lucca à respecter ici.

## Evidence on Hand

- README complet, en français, avec le détail fonctionnel réel (`README.md`).
- CLAUDE.md : la mémoire d'architecture du projet, qui documente les pièges et les décisions
  structurantes — source de vérité pour tout ce qui touche au pilotage des sessions.
- Système visuel incumbent complet dans `src/app.css` : tokens clair/sombre, accent indigo
  (`#4f46e5`), **Public Sans** + **JetBrains Mono** servies localement, couleurs d'état
  (working / waiting / attention / background / idle / ended / past).
- Tests de caractérisation (Vitest) sur fixtures : `npm test`.

Absences à ne pas inventer : aucun témoignage, aucun client, aucun benchmark, aucun chiffre
d'adoption, aucune offre payante. hooked est un outil interne gratuit.

## Product Principles

1. **L'état avant le contenu.** La première chose qu'un écran de hooked doit transmettre, c'est
   qui attend quoi. Tout le reste est secondaire à cette lecture.
2. **Débloquer sans terminal.** Toute attente que Claude peut créer (question, permission, plan)
   doit être résolvable depuis le navigateur, téléphone compris.
3. **Ne jamais deviner un état qu'on connaît.** hooked héberge les sessions : il affiche ce qu'il
   sait, pas ce qu'il interprète. Les hooks ne sont qu'un repli.
4. **Le local est un acquis, pas une option.** Rien ne sort de la machine : pas de CDN, pas de
   police distante, pas de télémétrie, pas d'appel externe.
5. **Jamais l'API, toujours l'abonnement.** Piloter une session ne doit coûter aucun token
   supplémentaire à l'utilisateur.

## Accessibility & Inclusion

- Thème **clair et sombre** obligatoires, les deux de premier rang (`prefers-color-scheme` +
  bascule explicite).
- Le contraste texte est déjà traité comme un critère : `--muted` a été remonté à ~5:1 sur blanc
  pour tenir AA. Tout nouveau token doit tenir au moins AA sur son fond, dans les deux thèmes.
- La couleur **ne doit jamais être le seul porteur** d'un état de session : les quatre états
  vitaux portent aussi un libellé et une forme.
- Usage mobile confirmé comme scène de premier rang → cibles tactiles et lisibilité à une main
  font partie du contrat, pas d'une adaptation tardive.
