# PLAN_migration_mistral.md — audit & todo : parité Mistral Vibe dans hooked

Date : 2026-11-20 · branche : `feat/vibe-provider` (PR #131, **ne pas merger tant que la todo n'est pas terminée**)

Objectif : finir le port de hooked sur **Mistral Vibe** (provider `"vibe"`) pour atteindre la parité
fonctionnelle avec Claude Code, sans régression Claude. Les phases M0–M4 de `docs/port-vibe.md`
sont livrées (scan, pilotage ACP, approbations/questions, resume/fork/commandes/MCP, masquages).
Ce document est l'**audit des manques restants** (trois scans : server, front web, desktop-rune)
suivi d'une **todo découpée en sessions de travail autonomes** (S1…S6), chacune livrable et
testable seule, plus une liste de décisions « pas d'équivalent » (S7).

Conventions : `provider` sur chaque session (`"claude"` | `"vibe"`) ; `scanAllSessions()` =
Claude + Vibe ; une session vibe a `s.dir = ~/.vibe/logs/session/unified/<id>/` et
`s.file = <dir>/journal` (dossier, jamais parsé comme un transcript Claude).

---

## 1. État des lieux — ce qui marche déjà pour Vibe ✅

- Scan/liste/stats/coût : `server/vibe.js` (journal CRDT, forks `forkedFrom`, sous-agents exclus),
  `scanAllSessions()`, tier de prix `mistral`, `/api/sessions` + champ `providers`.
- Pilotage live ACP : launch/reply/interrupt/kill/setMode/setModel+thinking (`server/vibeAgent.js`,
  dispatch `server/agent.js`), stream SSE live (`/api/session/stream`) — **le tampon se vide en
  fin de tour** (`usage_update`), markdown conservé (\n), tools avec `detail/inputText/result`
  (input + stdout/stderr/exit code des bash).
- Approbations (`session/request_permission`) et questions (`elicitation/create`) → cartes hooked.
- Resume (`session/load`), fork live (`session/fork` + lease), commandes `/` (ACP
  `availableCommands` + `.vibe/prompts` + skills), MCP lens (`/api/mcp?provider=vibe`).
- UI web : sélecteur provider (nouvelle session + sidebar badge cc/vibe si les deux configurés),
  composer provider-aware, plan/auto-approve/worktree/ephemeral masqués en vibe, resume cmd
  `vibe --resume <id>`.
- desktop-rune : sélecteur provider, modèles/thinking/modes vibe, badge cc/vibe, resume vibe,
  auto-approve masqué.
- Events live normalisés (`scripts/hook-vibe.cjs` → `~/.vibe/hooked/events.jsonl`, lus par
  `events.js`) : SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SessionEnd/Notification.
- Tests : 1138 verts (`npm test`), build + `mise run deploy` OK.

---

## 2. Audit — les manques (condensé des 3 scans)

### 2.1 Routes « id de session » encore Claude-only
Beaucoup de routes font `scanSessions().find(id)` (scan `~/.claude/projects` uniquement) alors
qu'elles n'ont besoin que de `s.project` (présent dans `meta.json` vibe) :

| Route / module | Fichier | Symptôme pour une session vibe |
|---|---|---|
| `/api/session/vcs-diff`, `vcs-base-diff`, `vcs-branches`, `vcs-branch`, `vcs-blame` | `src/routes/api/session/vcs-*/+server.js` (ex. `vcs-diff/+server.js:8`) | `cwd=null` → Review lens vide |
| `/api/session/file-changes` | `src/routes/api/session/file-changes/+server.js` | 404 / `changes:[]` |
| `/api/session/trace` | `session/trace/+server.js:10` | 404 → Trace lens vide |
| `/api/session/symbol`, `source` | `session/symbol/+server.js:9`, `session/source/+server.js:10` | go-to-def / peek cassés |
| `/api/session/message` | `session/message/+server.js:12` | « show more » 404 (et pas de `forkUuid` côté vibe) |
| `/api/files?id=` (@-autocomplete) | `files/+server.js:11` | liste vide dans une session vibe |
| `/api/open-editor`, `/api/open-ghostty` | `server/editor.js:15,32` | erreur pour un id vibe |
| `/api/delete`, `/api/trash`, `/api/restore` | `server/trash.js:29` | 404 « session not found » ; corbeille ne liste que Claude |

### 2.2 Détail de session (`/api/session?id=`) : champs calculés depuis le transcript Claude
`server/stats.js` appelle ces builders avec `s.file` = **dossier journal** vibe → `[]` silencieux :

| Champ | Builder (stats.js) | Équivalent Vibe (vérifié dans les journals) |
|---|---|---|
| `todos` / `todo` (sidebar chip, dock Tasks) | `latestTodos`/`todoSummary` (`stats.js:226,385`) | tool `vibe.todo` (`input.action:"write"`, `todos:[{id,content,status,priority}]`) — même sémantique que TodoWrite |
| `subagents` + coût | `buildSubagents(s.file)` (`stats.js:379`) | `effect detail.kind:"subagent"` (`agents.spawn`, input.task, childSessionId) + `meta.json child_sessions` |
| `subSessions` | `buildSubSessions(s.file)` (`stats.js:372`) | `meta.json child_sessions` / `parent_session_id` |
| `screenshots` | `buildScreenshots(s.file,id)` (`stats.js:381`) | chemins d'images dans `detail.input` / `state.output` des tools (read_file, bash) ; blocs `content[]` image quand présents |
| `changes` | `buildFileChanges(s.file,id)` (`stats.js:373`) | rien côté journal → utiliser le diff VCS du projet (comme Review) |
| `bgJobs` | forcé `[]` pour vibe (`stats.js:194,427`) | pas d'équivalent → masqué (OK) |
| `prLinks` / `issueLinks` | jamais remplis pour vibe (`finalizeVibe`) | extraire des URLs dans les messages user/assistant du journal |
| `context` (jauge CTX) | statusline Claude | `usage_update` ACP porte `used`/`size` → % de fenêtre de contexte |

Routes en 404 derrière : `/api/screenshot?session=&path=`, `/api/user-file?session=&path=`
(allowlist construite depuis le transcript Claude uniquement), `/api/agent` (sous-agent vibe),
`/api/background/stream` (OK vide), `/api/query-result` (grafana, voir S7).

### 2.3 Recherche plein texte
`server/searchIndex.js` indexe seulement `scanSessions()` (FTS5 sur `buildConversation` Claude),
DB dans `~/.claude/hooked/search.db` → les sessions vibe n'apparaissent jamais dans
`/api/search` (palette web + rune).

### 2.4 Pages « écosystème » Claude-only
| Page | Route / module | Manque vibe |
|---|---|---|
| Skills | `/api/skills` (`server/skills.js`) | lister `~/.vibe/skills`, `<cwd>/.vibe/skills`, packages plugins (`~/.vibe/logs/session/plugins/packages/…`) — déjà scannés pour les commandes `/` (`vibeCommands.js:86-92`) |
| Cron | `/api/cron` (`server/cron.js:135` lance `launchSession` **sans provider**) | champ `provider` sur la tâche + formulaire ; lens read-only sur `<session>/scheduled-loops.json` + `meta.json.loops` |
| Digest | `/api/digest` (`server/digests.js:16,126,244`) | `scanSessions()` uniquement + prose via `claude -p` → inclure vibe (`scanAllSessions`), appel LLM provider-aware (`vibe -p`) |
| Auto-tags / PR-review-tags / PR-watch | `server/autoTags.js`, `prReviewTags.js`, `prWatch.js` | idem : `scanAllSessions()` + génération provider-aware |
| GitHub « review in session » | `/api/github/review` (`server/prReview.js:55`) | `launchSession` sans provider → paramètre/réglage |
| Settings / Quick Action | `POST /api/launch` sans provider → défaut `'claude'` (`agent.js:778-780`) | réglage `defaultProvider` |
| LlmToolsModal | `/api/llm-tools` → `agentToolCatalog` (`agent.js:1047`) déréférence `st.q` → **500 pour une session vibe** | guard `provider==="vibe"` → catalogue dérivé des `availableCommands` ACP ou null |

### 2.5 Finitions UI web
- `Question.svelte:161` : « Claude is asking you a question » en dur → label provider-aware.
- Messages vibe sans `forkUuid` → bouton fork par bulle inatteignable ; « show more » aussi.
- Badge cc/vibe seulement dans la sidebar, pas sur les cartes du Deck.
- Jauge CTX vide pour vibe (voir 2.2 `context`).
- `Mcp.svelte` OK ; labels « Claude » restants à passer en provider-aware.

### 2.6 desktop-rune
- MCP lens n'envoie jamais `provider=vibe` → affiche la config **Claude** du cwd pour une session vibe.
- Pas de bouton Fork pour une session vibe (seulement `fork_uuid` par message, absent côté vibe).
- Tool parts `send`/`show`/`diff` absents côté vibe → pas de diff inline pour write/edit, pas d'images de tools dans la galerie.
- `view/session.rs` `who()` : « Claude » en dur sur les bulles vibe.
- Review/Trace/dock/todos/subagents/screenshots/trash/editor : bloqués côté **server** (2.1/2.2), donc corrigeables côté rune une fois S1/S2 livrées.

### 2.7 Pas d'équivalent Vibe (voir S7 pour les décisions) 
Mémoire (`~/.claude/projects/*/memory`), compte/quotas/usage topbar (`~/.claude.json` OAuth),
remote-control (`claude remote-control`), warmup (cache 5h Anthropic), plan mode, auto-approve
granulaire, worktree/ephemeral au lancement, workflows, background jobs (Monitor/Wakeup), hooks
PreCompact/SubagentStop, grafana lens (gateway `~/.claude.json`).

---

## 3. TODO — sessions de travail (chaque session = un bloc autonome, testable, committable)

> Ordre conseillé : **S1 d'abord** (fondation, débloque Review/Trace/editor/trash pour vibe),
> puis **S2 et S3 en parallèle**, puis **S4 et S5 en parallèle**, puis **S6** (rune, après S1+S2).
> Chaque session se termine par : `npm test` vert + `npm run build` + tests ciblés + commit sur
> `feat/vibe-provider`. Ne pas merger la PR entre-temps.

### S1 — Routes id → `scanAllSessions()` (fondation) ✅ LIVRÉE (9e9bcbd)
- **Scope** : `src/routes/api/session/{vcs-diff,vcs-base-diff,vcs-branches,vcs-branch,vcs-blame,file-changes,trace,symbol,source,message}/+server.js`, `src/routes/api/files/+server.js`, `server/editor.js`, `server/trash.js` (+ `listTrashed` pour les dossiers vibe, via `meta.json.archived_at` ou déplacement du dossier), `server/sessions.js` (exposer un helper `findSessionAny(id)`).
- **À faire** : remplacer `scanSessions().find(...)` par `scanAllSessions().find(...)` quand seule `s.project`/`s.dir` est utilisée ; pour `trash` vibe, poser `archived_at` dans `meta.json` (sans casser la chaîne sha256 des chunks — `meta.json` est hors chaîne, à vérifier) ou déplacer le dossier vers une corbeille vibe.
- **Done quand** : sur une session vibe, la Review lens affiche le diff VCS du projet, go-to-def/peek répondent, `@file` autocomplète, « open in editor/Ghostty » marchent, trash→restore fonctionne, « show more » répond (avec `forkUuid` = id d'entry, voir S5).
- **Tests** : tests de routes existants + nouveaux tests avec fixture vibe (`test/fixtures/vibe-session`) pour chaque route touchée.

### S2 — Détail vibe : todos, subagents, sub-sessions, screenshots, PR links, context ✅ LIVRÉE (ddf7d2b)
- **Scope** : `server/todos.js` (branche vibe : dernier `vibe.todo action:"write"` du journal gagne), `server/stats.js:226,372,379,381,385` (dispatch par provider), `server/subagents.js` (effects `kind:"subagent"` + `child_sessions`, coût replié depuis le journal enfant), `server/subSessions.js` (`child_sessions` de `meta.json`), `server/screenshots.js` (paths d'images dans `detail.input`/`state.output` des tools + allowlist realpath pour `/api/screenshot`), `server/vibe.js` (`prLinks`/`issueLinks` extraits du texte des messages ; `context` depuis les `usage` du journal), `server/userFiles.js` (allowlist vibe pour `/api/user-file`), `server/vibe.js` `buildVibeConversation` (ajouter `forkUuid` = entry id sur les messages user).
- **UI** : dock cards Tasks/Agents/Sub-sessions/Screenshots + sidebar chip todo s'allument pour vibe (web `Dock.svelte`, rune `view/dock.rs` — rune passif, lit `/api/session`).
- **Done quand** : session vibe avec todos → chip + carte ; sous-agent vibe → carte + drill-in `/api/agent` (branche vibe : `buildVibeConversation(<dir enfant>)`) ; screenshot → galerie + `/api/screenshot` 200 ; jauge CTX remplie.
- **Tests** : fixtures journal avec `vibe.todo`, subagent, image path ; tests `stats.js` détail vibe.

### S3 — Trace lens vibe + recherche FTS vibe ✅ LIVRÉE
- **Scope** : `src/routes/api/session/trace/+server.js` + nouveau `buildVibeTrace(dir)` dans `server/vibe.js` (timeline des effects : tool name/input/status/output + reasoning + messages, ordre chrono) ; `server/searchIndex.js` (`refresh()` sur `scanAllSessions()`, `buildVibeConversation(s.dir)` quand `provider==="vibe"`, colonne `provider` ou DB séparée sous `~/.vibe/hooked/search.db`).
- **Done quand** : Trace lens d'une session vibe montre les appels d'outils ; `/api/search` retrouve du texte de sessions vibe (web + rune palette).
- **Tests** : trace sur fixture ; search indexe une fixture vibe et retrouve un mot.

### S4 — Pages écosystème provider-aware ✅ LIVRÉE (395aad7)
- **Scope** : `server/skills.js` (`?provider=vibe` → `~/.vibe/skills`, `<cwd>/.vibe/skills`, plugin packages), `server/cron.js` (champ `provider` sur `cron-tasks.json`, passé à `launchSession` ; lens read-only `scheduled-loops.json`), `server/digests.js` + `autoTags.js` + `prReviewTags.js` + `prWatch.js` + `server/prReview.js` (`scanAllSessions()` + appel LLM provider-aware : `claude -p` vs `vibe -p --output json`), `server/settings.js` (`defaultProvider`), `server/agent.js:1047` (guard `llm-tools` vibe), routes + fronts des pages Skills/Cron/Digest/Settings/GitHub.
- **Done quand** : page Skills liste les skills vibe ; une tâche cron peut lancer en vibe ; le digest inclut les sessions vibe ; le Quick Action respecte `defaultProvider` ; `/api/llm-tools?id=<vibe>` ne 500 plus.
- **Tests** : skills vibe sur fixture dir ; cron task avec provider ; llm-tools guard.

### S5 — Finitions UI web vibe ✅ LIVRÉE (0724b03)
- **Scope** : `Question.svelte` (label provider), `SessionDetail.svelte` (jauge CTX depuis `s.context`, badge cc/vibe aussi sur les cartes Deck `Deck.svelte`/`SessionCard.svelte`), `ChatBubble.svelte` (fork par bulle via `forkUuid` vibe, « show more »), labels « Claude » restants (grep), masquages explicites quand un seul provider est configuré (Memory/Account/Remote-control pages, voir S7).
- **Done quand** : parcours UI d'une session vibe sans aucun « Claude » ni élément cassé ; fork d'une bulle vibe fonctionne (server OK, `fork.js:70`).
- **Tests** : snapshot/composant si dispo, sinon test de `format`/label helpers.

### S6 — desktop-rune : parité ✅ LIVRÉE (voir commit S6)
- **Scope** : `desktop-rune/src/api.rs` (MCP lens envoie `provider=vibe` pour une session vibe, masque OAuth login/logout en vibe), `src/view/session.rs` (bouton Fork session vibe — `POST /api/fork` whole-session, label `who()` provider-aware, diff inline pour `file_system.write_file/edit` via `detail.input`), `src/view/lenses.rs` (vérifier Review/Trace après S1/S3), `src/view/dock.rs` (todos/subagents/screenshots après S2), `src/app.rs` (trash/delete, open-editor après S1), `cargo check` 0 warning.
- **Done quand** : `cd desktop-rune && mise exec -- cargo check` vert ; parcours manuel d'une session vibe dans Rune : chat, review, trace, MCP vibe, fork, todos, trash.
- **Tests** : `cargo test` si existants ; sinon check + revue manuelle.

### S7 — Décisions « pas d'équivalent » (doc + masquages explicites)
- Documenter dans `docs/port-vibe.md` (section M5) et masquer côté UI quand `providers.vibe && !providers.claude` (ou par session vibe) : mémoire, compte/quotas/usage topbar, remote-control, warmup, grafana lens, plan, auto-approve granulaire, worktree/ephemeral au lancement, workflows, background jobs, plugins manager (ou nouveau lecteur Agent Plugins 1.0 dans S4 si scope utile), hooks PreCompact/SubagentStop.
- **Done quand** : chaque item a soit un masque UI, soit une note « non supporté » ; aucun 404/500 sur une session vibe.

---

## 4. Risques & règles communes

- **Journal Vibe = store CRDT** : ne jamais éditer à la main (sha256), parser défensif, fixtures de test.
- **Aucune régression Claude** : `npm test` (1138 tests) vert à chaque session ; tests de caractérisation inchangés.
- **Routes id** : règle simple — toute route qui reçoit un `id` de session doit résoudre via `scanAllSessions()`.
- **Dégradation gracieuse** : une feature sans équivalent vibe est masquée, jamais en erreur.
- Déploiement après chaque session : `npm run build && mise run deploy` ; vérif live via
  `curl http://192.168.0.12:4123/api/...` et une session vibe de test.
