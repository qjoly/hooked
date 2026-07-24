# 🪝 hooked

Un dashboard **local** pour suivre tes sessions Claude Code en temps réel — et garder un œil sur ton usage (tokens, coût estimé, projets).

- 🔒 **100 % local** — rien ne sort de ta machine.
- 🪶 **Logique back zéro dépendance** — les modules `server/*` et `hook.cjs` n'utilisent que la lib standard de Node (les dépendances ne servent qu'à *builder*/*servir* le front).
- ⚡ **Temps réel** — l'état des sessions se met à jour tout seul (SSE).
- 🧩 **SvelteKit** — front Svelte 5 + endpoints API dans un seul process (Vite en dev, adapter-node en prod). Back découpé en modules testés (Vitest).

---

## Pourquoi ?

Quand tu jongles entre plusieurs sessions Claude Code, tu perds vite le fil : laquelle attend une réponse ? laquelle bosse encore ? combien ça t'a coûté aujourd'hui ?

**hooked** regroupe tout ça dans une seule page : tu vois en un coup d'œil les sessions qui ont besoin de toi, et tu peux même **répondre à Claude directement depuis le navigateur**.

---

## Prérequis

- **Node.js** ≥ 24 (la recherche utilise `node:sqlite`, stabilisé en Node 24)
- **Claude Code** installé et utilisé sur ta machine
- **tmux** *(optionnel)* — requis seulement pour répondre / lancer des sessions depuis l'UI

---

## Installation

```bash
git clone git@github.com:briangtn/hooked.git
cd hooked

npm install       # dépendances (SvelteKit + outillage) — devDeps uniquement
npm run setup     # branche hooked sur les hooks Claude Code (avec backup automatique)
npm run dev       # dashboard en dev (front HMR + API + SSE) sur :5173
```

Ouvre ensuite **http://localhost:5173**.

> En production : `npm run build && npm start` (serveur Node autonome via adapter-node,
> sur **http://localhost:3000** par défaut).

> ⚠️ Après `setup`, **redémarre tes sessions Claude Code** pour activer les hooks.
> Les sessions déjà ouvertes restent visibles (via les transcripts), mais leur état
> live n'apparaît qu'à partir du prochain évènement.

---

## Fonctionnalités

### 🗂️ Vue Sessions

Toutes tes sessions (en cours + passées), regroupées par état pour gérer le multi-tâche :

| État | Signification |
|------|---------------|
| 🔴 **Action requise** | Claude demande une permission |
| 🟡 **En attente de toi** | Claude a fini, à toi de jouer |
| 🔵 **Claude travaille** | session active (avec l'outil en cours, ex. `Bash`) |
| 🕘 **Récentes** | en pause / terminées / passées |

Plus :

- **Recherche** + **filtres** par statut (chips avec compteurs) et par projet.
- **Tâche en cours dans la sidebar** : si Claude utilise `TodoWrite`, l'item *in progress* et l'avancement (`done/total`) s'affichent directement sur la carte de session.
- **Réponse en 1 clic depuis la sidebar** : quand Claude pose une question à choix unique (`AskUserQuestion`), les options apparaissent en boutons sur la carte — un clic envoie la réponse sans ouvrir le détail.
- **Détail d'une session**, en sous-onglets :
  - **💬 Conversation** : le chat reconstruit, avec le composer pour répondre (sessions tmux).
  - **📝 Fichiers** : les fichiers modifiés par Claude (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`) avec un **diff dépliable** (rouge/vert).
  - **✅ Tâches** : la TodoList de la session (`TodoWrite`) avec barre d'avancement.
  - **🤖 Sous-agents** : les appels `Agent` / `Task` lancés pendant la session.
  - **🪝 Activité** : la timeline brute des hooks.
- **Liens de PR GitHub** : les URLs de pull requests mentionnées dans la session sont détectées et affichées en chips cliquables.

### 💬 Répondre à Claude depuis l'UI *(sessions tmux)*

Pour les sessions lancées dans **tmux**, un composer apparaît en bas de la conversation :

- Envoie un message directement dans la session interactive (`tmux send-keys`).
- C'est **ta session / ton abonnement** qui continue → **aucune conso token supplémentaire**, pas de `claude -p`.
- `Entrée` envoie, `Maj+Entrée` insère un saut de ligne.
- `Échap` **interrompt Claude** et recharge le dernier prompt pour l'éditer (comme dans le CLI).
- Tape `@` pour **auto-compléter** un fichier du projet (↑/↓ pour naviguer, Entrée/Tab pour insérer).
- **Colle une image** (Cmd/Ctrl+V) : elle est enregistrée localement et son chemin est joint au message — Claude Code la lit comme un drag-drop dans le TUI. Une miniature s'affiche dans le composer (× pour la retirer).
- **File d'attente** : comme dans le CLI, les messages envoyés pendant que Claude travaille sont mis en attente et marqués `⏳ en file d'attente` jusqu'à ce qu'ils apparaissent dans le transcript.
- **Pane tmux fermé** : si la session n'est plus vivante, envoyer un message **relance `claude --resume`** automatiquement dans son dossier d'origine.
- **Questions interactives** (`AskUserQuestion`) : l'intitulé et les réponses proposées s'affichent dans une carte, et tu peux sélectionner une ou plusieurs réponses.

### 🔀 Changer le mode de Claude *(sessions tmux)*

Pour une session **live**, l'en-tête du chat affiche le **mode de permission courant** et un sélecteur pour le changer :

- **● Normal** : Claude demande la permission avant chaque action sensible.
- **⚡ Auto** : Claude approuve automatiquement les actions sans confirmation (full auto).
- **⏸ Plan** : mode plan, Claude réfléchit et propose sans rien modifier.

Le **mode actuel** est lu **en direct dans le footer du TUI** (`tmux capture-pane`) — source fiable et temps-réel, contrairement aux hooks (différés) ou à la statusline (qui ne porte pas le mode). Les autres modes (**⏵⏵ Auto-edits**, **⛔ Bypass**…) sont reconnus et affichés même s'ils ne sont pas proposés au sélecteur.

Le changement se fait en **boucle fermée** : hooked envoie un `Maj+Tab` (`tmux send-keys BTab`), relit le footer, et recommence jusqu'à atteindre le mode visé — robuste quel que soit l'ordre du cycle, et auto-vérifié.

### ▶️ Lancer / reprendre / stopper

- **＋ Nouvelle session** : choisis un projet, le **modèle** (Opus / Sonnet / Haiku / Fable), l'**effort** (low → max) et un 1ᵉʳ message optionnel.
- **▶ Reprendre dans tmux** : relance une session passée (`--resume`) dans son dossier d'origine.
- **⏹ Stopper** : ferme le pane tmux où tourne Claude.

> Les sessions sont lancées en **tmux détaché** avec `claude` interactif sous ton abonnement (**zéro conso token**, pas de `claude -p`). Tu t'attaches avec la commande affichée (`tmux attach -t hooked-…`).

### 🖥 Terminal partagé par un agent *(sessions tmux)*

L'onglet **🖥 Terminal** de la vue session **streame en temps réel** (xterm.js) le **pane Claude Code lui-même** (`🤖 Claude Code`) — tu vois le TUI de Claude bosser en direct dans le navigateur. Le bouton **＋** ouvre un nouveau pane shell dans le tmux de la session, et chaque pane secondaire a une croix **✕** pour le fermer (le pane Claude, lui, n'est pas fermable). Via le serveur MCP (outil **`show_in_pane`**), un agent peut en plus ouvrir un **nouveau pane** (split) ou une **nouvelle fenêtre** dans le tmux de la session et y lancer une commande (serveur de dev, `htop`, démo, `tail` de logs…) — pour te **montrer** quelque chose ; chaque pane apparaît comme une entrée de l'onglet.

Le flux est **un vrai stream d'octets**, pas un rafraîchissement d'image : `tmux pipe-pane` écrit la sortie brute du pane (avec ses séquences VT) dans un fichier, que le serveur tail et pousse en **SSE** (`/api/pane/stream`) ; xterm applique les octets tels quels → rendu incrémental, sans flicker, curseur exact, `vim`/`htop` fluides. Un `capture-pane` ne sert qu'à **amorcer** l'écran initial. C'est **tmux qui sert de PTY** : aucune dépendance native (pas de `node-pty`).

Bascule **⤢ Adapter / ▭ Fixe** (adapter **par défaut**, mémorisé) : en mode *Adapter*, le terminal mesure la place dispo dans la fenêtre web et redimensionne la **fenêtre tmux** du pane (`tmux resize-window`) pour la remplir — le TUI (claude, nvim…) reflue à cette taille. À la fermeture de la vue web, l'auto-dimensionnement tmux (`window-size latest`) est restauré pour qu'un rattachement dans un vrai terminal (Ghostty) reflue normalement.

Bascule **👁 Lecture seule / ⌨ Interactif** (interactif **par défaut**, choix mémorisé) :
- **Lecture seule** — observation.
- **Interactif** — tes frappes (texte, flèches, `Ctrl-C`, `Échap`…) repartent vers le pane via `tmux send-keys` ; l'écho revient par le flux (latence d'un aller simple). Le pane partage son entrée avec un éventuel client tmux attaché.

Un **sélecteur de thème** (🎨 Hooked, Dracula, Nord, Solarized, Gruvbox, Light…) et un **sélecteur de police** (🔤 Nerd Font / System Mono) ajustent le rendu du terminal (mémorisés en `localStorage`). « Nerd Font » utilise **JetBrains Mono + les glyphes Symbols Nerd Font empaquetés** (`static/fonts/`, servis localement) : les icônes Nerd Font s'affichent **sans rien installer**. Si une Nerd Font (ex. `JetBrainsMono Nerd Font`) est installée sur la machine, elle est préférée. Les sessions lancées par hooked sont créées en **120×64** par défaut (TUI claude plus aéré) — ajustable via `HOOKED_TMUX_COLS` / `HOOKED_TMUX_ROWS` ; tmux rétrécit de toute façon à la taille du client réel s'il s'y attache.

Les **TUI plein écran** (`nvim`, `htop`, `less`, le TUI claude…) rejoints en cours de route sont gérés : à l'amorçage on rejoue les **modes du terminal** lus dans tmux (écran alterné, touches curseur applicatives, auto-wrap, visibilité du curseur) pour resynchroniser xterm — sans quoi les flèches et les redraws partaient en vrille en mode interactif.

### 🧭 Sidebar tmux — naviguer entre sessions

Une **sidebar dans tmux** (à la [opensessions](https://github.com/Ataraxy-Labs/opensessions)) qui liste les sessions **actives** de l'inbox et **switch la session tmux courante** au fil de la navigation (`j`/`k`) ; `/` filtre, `d` stoppe, `n` crée une session via un popup. TUI Node **zéro dépendance** (ANSI brut) qui suit le client en re-`join-pane`-ant son propre pane — sans jamais toucher aux panes Claude gérés par hooked.

👉 **Installation et détails : [`tmux/README.md`](tmux/README.md).**

### 📊 Vue Stats & usage

Coût estimé, tokens, sessions, tours, prompts — avec des graphes par **jour / modèle / projet / outil** et des plages **1j / 7j / 30j / tout**.

---

## Développement

```bash
npm run dev        # front (HMR) + API + SSE dans un seul process Vite, sur :5173
npm test           # tests de caractérisation (Vitest) — filet anti-régression du back
npm run build      # build de prod (adapter-node) → build/
npm start          # lance le serveur de prod (node build) sur :3000
```

### Architecture

```
src/routes/            SvelteKit : pages (routing URL) + endpoints API
  ├─ +layout.svelte    header / onglets / état live (SSE) / modale
  ├─ (sessions)/       / (overview), /session/[id], /new — avec sidebar
  ├─ stats/            /stats
  └─ api/*/+server.js  endpoints JSON + /api/stream (SSE)
src/lib/
  ├─ components/       composants Svelte 5
  ├─ server/           pont vers le back (core.js) + singleton SSE (live.js)
  └─ {api,format,state.svelte}.js  accès API, helpers, état partagé
server/                logique back, zéro dépendance (ESM), en modules testables
  ├─ pricing.js        tarifs + calcul de coût
  ├─ transcript.js     parsing des transcripts (+ cache mtime, scan, sous-agents)
  ├─ conversation.js   reconstruction du chat
  ├─ changes.js        diffs de fichiers
  ├─ subagents.js      appels Agent/Task
  ├─ files.js          listing + matching flou (@-complétion)
  ├─ events.js         évènements live (hook) + config de lancement
  ├─ live.js           état live d'une session
  ├─ tmux.js           lancer / reprendre / stopper / répondre
  └─ stats.js          sessions, stats, détail
hook.cjs               capteur d'évènements (branché sur les hooks)
scripts/hooked-whoami.sh  identité hooked de la session courante (pane → session_id)
tmux/                  plugin sidebar tmux (cf. tmux/README.md) : TUI + toggle + popup
test/                  fixtures synthétiques + tests différentiels (ancien vs nouveau)
```

Les tests comparent, sur des fixtures synthétiques, la sortie de l'ancien `server.js`
(figé dans `test/reference/`) à celle des nouveaux modules : toute divergence = régression.

## Comment ça marche

1. **`hook.cjs`** est branché sur **tous** les hooks Claude Code. À chaque évènement (prompt, appel d'outil, fin de tour, notification…), il écrit une ligne dans `~/.claude/hooked/events.jsonl` → c'est la source de l'**état live**.
2. **Les endpoints SvelteKit** (`src/routes/api/*`) lisent aussi tes **transcripts** (`~/.claude/projects/*/*.jsonl`) pour l'historique, les tokens, le coût et les titres. Ils servent l'UI + l'API JSON, et poussent les mises à jour en **SSE** (`/api/stream`, temps réel).

---

## Configuration

| Réglage | Comment |
|---------|---------|
| **Changer de port** | `PORT=5000 npm start` (prod) ou `npm run dev -- --port 5000` (dev) |
| **Ajuster les tarifs** | édite l'objet `PRICING` dans `server/pricing.js` (USD / million de tokens) |
| **Lancer au démarrage** | `npm run build` puis `nohup node ~/chemin/hooked/build >/tmp/hooked.log 2>&1 &` |
| **Budget de session (fallback)** | `HOOKED_SESSION_BUDGET=60 npm start` — utilisé pour estimer le % de la fenêtre 5 h **uniquement** si le tap statusline n'est pas en place |

### ⏳ Rate limits réels (5 h / 7 j) — tap statusline

Claude Code passe à ta **statusline** un JSON contenant les **vrais** rate limits du compte
(`rate_limits.five_hour` / `seven_day`). hooked les affiche en barre de progression dans le
header du chat si tu « tappes » ta statusline : colle le contenu de **`statusline-tap.sh`** en
haut de ton script de statusline (juste après `input=$(cat)`). Il dépose un snapshot par session
dans `~/.claude/hooked/status/`. Sans ce tap, hooked retombe sur une **estimation par coût**
(voir `HOOKED_SESSION_BUDGET`).

---

## Désinstaller

Retire les lignes `node .../hook.js` de `~/.claude/settings.json` (un backup `settings.json.hooked.bak` a été créé par `setup`). Les autres hooks existants sont préservés.

---

## Confidentialité

Rien ne sort de ta machine. `events.jsonl` ne stocke que des **métadonnées** (évènement, session, cwd, nom d'outil, pane tmux) — **pas le contenu** de tes messages.
