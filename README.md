# 🪝 hooked

Un dashboard **local** pour suivre tes sessions Claude Code en temps réel — et garder un œil sur ton usage (tokens, coût estimé, projets).

- 🔒 **100 % local** — rien ne sort de ta machine.
- 🪶 **Zéro dépendance** — uniquement la lib standard de Node.
- ⚡ **Temps réel** — l'état des sessions se met à jour tout seul (SSE).

---

## Pourquoi ?

Quand tu jongles entre plusieurs sessions Claude Code, tu perds vite le fil : laquelle attend une réponse ? laquelle bosse encore ? combien ça t'a coûté aujourd'hui ?

**hooked** regroupe tout ça dans une seule page : tu vois en un coup d'œil les sessions qui ont besoin de toi, et tu peux même **répondre à Claude directement depuis le navigateur**.

---

## Prérequis

- **Node.js** ≥ 16 (aucun paquet à installer)
- **Claude Code** installé et utilisé sur ta machine
- **tmux** *(optionnel)* — requis seulement pour répondre / lancer des sessions depuis l'UI

---

## Installation

```bash
git clone git@github.com:briangtn/hooked.git
cd hooked

npm run setup     # branche hooked sur les hooks Claude Code (avec backup automatique)
npm start         # démarre le dashboard
```

Ouvre ensuite **http://localhost:4123**.

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
- **Détail d'une session** : timeline des hooks, tokens, coût, modèle.
- **Onglet 📝 Fichiers** : liste les fichiers modifiés par Claude (`Write` / `Edit` / `MultiEdit` / `NotebookEdit`) avec un **diff dépliable** (rouge/vert).
- **Liens de PR GitHub** : les URLs de pull requests mentionnées dans la session sont détectées et affichées en chips cliquables.

### 💬 Répondre à Claude depuis l'UI *(sessions tmux)*

Pour les sessions lancées dans **tmux**, un composer apparaît en bas de la conversation :

- Envoie un message directement dans la session interactive (`tmux send-keys`).
- C'est **ta session / ton abonnement** qui continue → **aucune conso token supplémentaire**, pas de `claude -p`.
- `Entrée` envoie, `Maj+Entrée` insère un saut de ligne.
- Tape `@` pour **auto-compléter** un fichier du projet (↑/↓ pour naviguer, Entrée/Tab pour insérer).
- **Questions interactives** (`AskUserQuestion`) : l'intitulé et les réponses proposées s'affichent dans une carte, et tu peux sélectionner une ou plusieurs réponses.

### ▶️ Lancer / reprendre / stopper

- **＋ Nouvelle session** : choisis un projet, le **modèle** (Opus / Sonnet / Haiku / Fable), l'**effort** (low → max) et un 1ᵉʳ message optionnel.
- **▶ Reprendre dans tmux** : relance une session passée (`--resume`) dans son dossier d'origine.
- **⏹ Stopper** : ferme le pane tmux où tourne Claude.

> Les sessions sont lancées en **tmux détaché** avec `claude` interactif sous ton abonnement (**zéro conso token**, pas de `claude -p`). Tu t'attaches avec la commande affichée (`tmux attach -t hooked-…`).

### 📊 Vue Stats & usage

Coût estimé, tokens, sessions, tours, prompts — avec des graphes par **jour / modèle / projet / outil** et des plages **1j / 7j / 30j / tout**.

---

## Comment ça marche

1. **`hook.js`** est branché sur **tous** les hooks Claude Code. À chaque évènement (prompt, appel d'outil, fin de tour, notification…), il écrit une ligne dans `~/.claude/hooked/events.jsonl` → c'est la source de l'**état live**.
2. **`server.js`** lit aussi tes **transcripts** (`~/.claude/projects/*/*.jsonl`) pour l'historique, les tokens, le coût et les titres. Il sert l'UI + une petite API JSON, et pousse les mises à jour en **SSE** (temps réel).

---

## Configuration

| Réglage | Comment |
|---------|---------|
| **Changer de port** | `HOOKED_PORT=5000 npm start` |
| **Ajuster les tarifs** | édite l'objet `PRICING` dans `server.js` (USD / million de tokens) |
| **Lancer au démarrage** | `nohup node ~/chemin/hooked/server.js >/tmp/hooked.log 2>&1 &` |

---

## Désinstaller

Retire les lignes `node .../hook.js` de `~/.claude/settings.json` (un backup `settings.json.hooked.bak` a été créé par `setup`). Les autres hooks existants sont préservés.

---

## Confidentialité

Rien ne sort de ta machine. `events.jsonl` ne stocke que des **métadonnées** (évènement, session, cwd, nom d'outil, pane tmux) — **pas le contenu** de tes messages.
