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

- **[mise](https://mise.jdx.dev)** — gestionnaire d'outils + task runner : il installe **la bonne version de Node tout seul** (Node ≥ 24, requis pour `node:sqlite`) et pilote toutes les tâches du projet
- **Claude Code** installé et utilisé sur ta machine
- Rien d'autre : le pilotage des sessions passe par l'**Agent SDK d'Anthropic** (`@anthropic-ai/claude-agent-sdk`), installé avec les dépendances du projet

### 1. Installer mise

```bash
# macOS (Homebrew)
brew install mise

# ou n'importe quel OS (script officiel)
curl https://mise.run | sh
```

Puis active mise dans ton shell (une seule fois) :

```bash
# zsh
echo 'eval "$(mise activate zsh)"' >> ~/.zshrc && exec zsh

# bash
echo 'eval "$(mise activate bash)"' >> ~/.bashrc && exec bash
```

> [!TIP]
> Autres méthodes d'installation (apt, dnf, Windows…) : [docs mise](https://mise.jdx.dev/getting-started.html).

### 🪟 Et sous Windows ?

hooked lit `~/.claude` et pilote des process `claude` : la voie testée est **WSL2**.

```powershell
wsl --install -d Ubuntu
```

Puis **tout se passe dans WSL** — installe **Claude Code** et **mise** dans Ubuntu et suis les
étapes ci-dessus telles quelles. Deux points d'attention :

- **Claude Code doit tourner dans WSL** (pas côté Windows) : les hooks écrivent dans le
  `~/.claude` Linux, c'est là que hooked lit tout.
- Le dashboard lancé dans WSL est accessible depuis ton navigateur Windows sur
  **http://localhost:4123** (WSL2 forwarde localhost automatiquement).

> [!NOTE]
> Le service `mise run service-install` (launchd) est macOS-only — sous WSL, lance
> `mise run start` à la main ou via systemd (activé par défaut dans les WSL récents).

---

## Installation

```bash
git clone git@github.com:LuccaSA/hooked.git
cd hooked

mise trust        # autorise le mise.toml du projet (env + tâches)
mise run setup    # installe Node 24 + les deps, build le front, branche les hooks Claude Code
mise run start    # démarre le dashboard
```

Ouvre ensuite **http://localhost:4123**.

`mise run setup` fait tout en une passe : `npm install` (devDeps uniquement), build de prod,
puis branchement de hooked sur les hooks Claude Code (`~/.claude/settings.json`, **avec backup
automatique** `settings.json.hooked.bak`).

> ⚠️ Après `setup`, **redémarre tes sessions Claude Code** pour activer les hooks.
> Les sessions déjà ouvertes restent visibles (via les transcripts), mais leur état
> live n'apparaît qu'à partir du prochain évènement.

> [!TIP]
> **macOS** : `mise run service-install` installe hooked comme **service launchd** —
> démarrage au login, auto-restart, logs dans `~/Library/Logs/hooked/`.
> (`service-status`, `service-logs`, `service-restart`, `service-uninstall` existent aussi.)

<details>
<summary><strong>Sans mise (npm directement)</strong></summary>

Il te faut **Node.js ≥ 24** déjà installé.

```bash
npm install       # dépendances (SvelteKit + outillage) — devDeps uniquement
npm run setup     # branche hooked sur les hooks Claude Code (avec backup automatique)
npm run build     # build de prod (adapter-node) → build/
node build        # démarre le dashboard sur http://localhost:3000 (PORT pour changer)
```

</details>

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
  - **💬 Conversation** : le chat reconstruit, avec le composer pour répondre (sessions pilotées par hooked).
  - **📝 Fichiers** : les fichiers modifiés par Claude (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`) avec un **diff dépliable** (rouge/vert).
  - **✅ Tâches** : la TodoList de la session (`TodoWrite`) avec barre d'avancement.
  - **🤖 Sous-agents** : les appels `Agent` / `Task` lancés pendant la session.
  - **🪝 Activité** : la timeline brute des hooks.
- **Liens de PR GitHub** : les URLs de pull requests mentionnées dans la session sont détectées et affichées en chips cliquables.

### 💬 Répondre à Claude depuis l'UI *(sessions pilotées par hooked)*

Pour les sessions que hooked pilote, un composer apparaît en bas de la conversation :

- Envoie un message directement dans la session, via la **file d'entrée en streaming** de l'Agent SDK.
- C'est **ta session / ton abonnement** qui continue → **aucune conso token supplémentaire**, pas de `claude -p`.
- `Entrée` envoie, `Maj+Entrée` insère un saut de ligne.
- `Échap` **interrompt Claude** et recharge le dernier prompt pour l'éditer (comme dans le CLI).
- Tape `@` pour **auto-compléter** un fichier du projet (↑/↓ pour naviguer, Entrée/Tab pour insérer).
- **Colle une image** (Cmd/Ctrl+V) : elle est enregistrée localement et son chemin est joint au message — Claude Code la lit comme un drag-drop dans le TUI. Une miniature s'affiche dans le composer (× pour la retirer).
- **File d'attente** : comme dans le CLI, les messages envoyés pendant que Claude travaille sont mis en attente et marqués `⏳ en file d'attente` jusqu'à ce qu'ils apparaissent dans le transcript.
- **Session arrêtée** : si elle n'est plus vivante, envoyer un message **relance `claude --resume`** automatiquement dans son dossier d'origine.
- **Questions interactives** (`AskUserQuestion`) : l'intitulé et les réponses proposées s'affichent dans une carte, et tu peux sélectionner une ou plusieurs réponses.
- **Demandes de permission d'outil** : quand Claude veut lancer un outil qui requiert ton accord, la demande arrive dans la **même carte** avec *Allow once* / *Allow always* / *Deny* — approuvable depuis le navigateur, sans terminal.

### 🔀 Changer le mode de Claude *(sessions pilotées par hooked)*

Pour une session **live**, l'en-tête du chat affiche le **mode de permission courant** et un sélecteur pour le changer :

- **● Normal** : Claude demande la permission avant chaque action sensible.
- **⚡ Auto** : Claude approuve automatiquement les actions sans confirmation (full auto).
- **⏸ Plan** : mode plan, Claude réfléchit et propose sans rien modifier.

Le **mode actuel** est publié par la session elle-même (Agent SDK) — source fiable et temps-réel, contrairement aux hooks (différés) ou à la statusline (qui ne porte pas le mode). Les autres modes (**⏵⏵ Auto-edits**, **⛔ Bypass**…) sont reconnus et affichés même s'ils ne sont pas proposés au sélecteur.

Le changement est **une requête de contrôle** (`setPermissionMode`) : un appel, une confirmation.

### ▶️ Lancer / reprendre / stopper

- **＋ Nouvelle session** : choisis un projet, le **modèle** (Opus / Sonnet / Haiku / Fable), l'**effort** (low → max) et un 1ᵉʳ message optionnel.
- **▶ Reprendre** : relance une session passée (`--resume`) dans son dossier d'origine.
- **⏹ Stopper** : termine le process Claude Code de la session.

> Les sessions tournent **dans le processus hooked**, via l'Agent SDK, sous ton abonnement (**zéro conso token**, pas de `claude -p`). Corollaire : **redémarrer hooked termine les sessions en cours** — leur transcript reste sur disque, `▶ Reprendre` repart où on en était.

### 📊 Vue Stats & usage

Coût estimé, tokens, sessions, tours, prompts — avec des graphes par **jour / modèle / projet / outil** et des plages **1j / 7j / 30j / tout**.

---

## Développement

```bash
mise run dev       # front (HMR) + API + SSE dans un seul process Vite, sur :5173
mise run test      # tests de caractérisation (Vitest) — filet anti-régression du back
mise run build     # build de prod (adapter-node) → build/
mise run start     # lance le serveur de prod (node build) sur :4123
mise run deploy    # rebuild + redémarre le service launchd (si installé)
mise tasks         # liste toutes les tâches disponibles
```

(Équivalents npm : `npm run dev`, `npm test`, `npm run build`, `npm start`.)

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
server/                logique back (ESM), stdlib + l'Agent SDK, en modules testables
  ├─ pricing.js        tarifs + calcul de coût
  ├─ transcript.js     parsing des transcripts (+ cache mtime, scan, sous-agents)
  ├─ conversation.js   reconstruction du chat
  ├─ changes.js        diffs de fichiers
  ├─ subagents.js      appels Agent/Task
  ├─ files.js          listing + matching flou (@-complétion)
  ├─ events.js         évènements live (hook)
  ├─ live.js           état live d'une session
  ├─ agent.js          pilotage Agent SDK : registre, lancer / répondre / interrompre / mode
  └─ stats.js          sessions, stats, détail
hook.cjs               capteur d'évènements (branché sur les hooks)
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
| **Changer de port** | `PORT=5000 mise run start` (prod) ou `npm run dev -- --port 5000` (dev) |
| **Exposer sur le LAN** | `HOST=0.0.0.0 mise run start` — par défaut hooked n'écoute qu'en local (127.0.0.1) |
| **Ajuster les tarifs** | édite l'objet `PRICING` dans `server/pricing.js` (USD / million de tokens) |
| **Lancer au démarrage** | `mise run service-install` (macOS, service launchd : login + auto-restart) |
| **Budget de session (fallback)** | `HOOKED_SESSION_BUDGET=60 mise run start` — utilisé pour estimer le % de la fenêtre 5 h **uniquement** si le tap statusline n'est pas en place |

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

Rien ne sort de ta machine. `events.jsonl` ne stocke que des **métadonnées** (évènement, session, cwd, nom d'outil) — **pas le contenu** de tes messages.
