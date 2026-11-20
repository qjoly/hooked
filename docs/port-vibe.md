# Port hooked sur Mistral Vibe — plan

Objectif : rendre hooked capable d'afficher et piloter des sessions **Mistral Vibe** (le CLI
agentique de Mistral) **sans perdre aucune feature côté Claude Code**. hooked n'est pas qu'un
client API Anthropic : il pilote le CLI Claude Code (Agent SDK), parse ses transcripts et reçoit
ses hooks. Le portage consiste donc à brancher un second « provider » derrière les mêmes couches,
pas à changer de modèle dans un dropdown.

## 1. Couplage actuel (ce qui rend hooked « Claude-only »)

| Couche | Fichier(s) | Détail |
|---|---|---|
| Pilotage live des sessions | `server/agent.js` (1715 l.) | `query()` du `@anthropic-ai/claude-agent-sdk`, `sdkOptions` (model/effort/permissionMode/resume), `canUseTool` pour les approbations |
| Événements temps réel | `hook.cjs` + `.claude/settings.local.json` → `~/.claude/hooked/events.jsonl` | hooks Claude Code (JSON stdin) : `SessionStart`, `UserPromptSubmit`, `PreToolUse`/`PostToolUse`, `Notification`, `Stop`, `SessionEnd`… |
| Transcripts | `server/transcript.js`, `server/conversation.js` | JSONL `~/.claude/projects/<proj>/<id>.jsonl` (format messages Anthropic) |
| Config écosystème | `~/.claude/settings.json`, `~/.claude.json`, OAuth, skills, commandes slash | MCP, permissions, modèles, efforts |

Le reste (~80 %) est **agnostique du moteur** : Review (diffs git), worktrees, tags, snooze,
stats, terminal PTY, digests, PR watch, trash, incognito, toute l'UI Svelte.

## 2. Équivalents côté Mistral Vibe (vérifiés sur l'installation locale)

| Besoin | Équivalent Vibe |
|---|---|
| Agent SDK `query()` | **ACP** (`vibe` en mode ACP, JSON-RPC stdio, protocole ouvert Agent Client Protocol) + **app server** interne (`vibe-app-server`, JSON-RPC : `SessionOpenParams`, stream `EventBatch`) + `vibe -p --output json\|streaming` |
| Hooks temps réel | `~/.vibe/hooks.toml` / `.vibe/hooks.toml` : `session_start`, `pre_agent`, `pre_llm`, `post_llm`, `pre_tool`, `post_tool`, `post_agent`, `notification` (`approval_requested`, `question_asked`, `turn_completed`, `turn_failed`), `session_end` — même pattern JSON-sur-stdin (`hook_event_name`, `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`, `usage`…) |
| Transcripts | `~/.vibe/logs/session/unified/<id>/` : `meta.json` (titre, cwd, branche, start/end) + `journal/*.jsonl` (ops CRDT : `append_entry`/`replace_entry` avec entrées `message`/`reasoning`/`effect`/`checkpoint`, et actions `completion` dont `payload.result.result.usage` porte les tokens) + `chunks/`, `generations/` |
| Permission modes | agents `ask` / `accept-edits` / `auto-approve` / `smart-approve` (`--agent`, `/model`, `/thinking` ≈ effort) |
| MCP + OAuth | `[[mcp_servers]]` dans `~/.vibe/config.toml`, `vibe mcp add`, tokens OAuth dans le keyring |
| Resume / fork / worktrees / cron | `vibe --resume <id>`, `/branch`, `vibe --worktree`, `/loop` |
| Usage/coûts | `usage` des hooks `post_llm` et des actions `completion` du journal (`input_tokens`, `output_tokens`, `cached_input_tokens`, `cache_write_tokens`) |

## 3. Architecture cible : un champ `provider` par session

```
session.provider = "claude" (défaut) | "vibe"
        │
        ├─ scan        server/transcript.js (claude)  +  server/vibe.js (vibe)
        │               → server/sessions.js : scanAllSessions() = les deux, même shape (blankSummary + provider)
        ├─ events live hook.cjs → ~/.claude/hooked/events.jsonl
        │               hook-vibe.cjs → ~/.vibe/hooked/events.jsonl  (événements NORMALISÉS, même noms
        │               que hook.cjs : SessionStart/UserPromptSubmit/PreToolUse/… → server/events.js
        │               lit les deux fichiers, live.js ne change pas)
        └─ pilotage    server/agent.js (SDK Anthropic)  +  futur server/vibeAgent.js (ACP/app-server)
```

Règles :
- **Aucune régression Claude** : tout le code existant reste le chemin par défaut ; le provider
  `vibe` s'ajoute à côté. Les tests de caractérisation existants doivent passer tels quels.
- **Dégradation gracieuse** : une feature sans équivalent Vibe est masquée/désactivée pour les
  sessions `provider: "vibe"` (pas d'erreur). Ex. : prompt-cache warmup Anthropic, plan mode.
- **Events normalisés** : `hook-vibe.cjs` traduit les hooks Vibe vers les noms d'événements
  existants de hooked, donc `live.js`, `events.js`, le Deck et les cartes question/plan
  fonctionnent sans modification.

## 4. Phasage

### M0 — spike read-only (ce commit)
- `scripts/hook-vibe.cjs` + `scripts/hooks-vibe.toml` (exemple à merger dans `~/.vibe/hooks.toml`)
  → `~/.vibe/hooked/events.jsonl` normalisé.
- `server/vibe.js` : scan de `~/.vibe/logs/session/unified/*/` (meta.json + journal) → summaries
  compatibles `blankSummary()` avec `provider: "vibe"` ; `buildVibeConversation()` pour l'onglet
  Converse (bulles user/assistant + outils).
- `server/sessions.js` : `scanAllSessions()` ; wiring dans `server/stats.js` (liste, stats, détail)
  avec guards `provider === "vibe"` ; `server/events.js` lit les deux fichiers d'events ;
  `server/config.js` expose les chemins Vibe (surchargeables par env, comme le reste) ;
  tier de pricing `mistral` dans `server/pricing.js`.
- Tests : `test/vibe.test.mjs` (parse journal + meta sur fixture), `test/hookVibe.test.mjs`
  (mapping des hooks via spawn du script).
- Résultat : les sessions Vibe apparaissent dans le Deck/la sidebar avec état live, coût, titre,
  conversation en lecture seule. Aucune action de pilotage (grisée côté UI à terme).

### M1 — Launch & Converse (pilotage de base)
- `server/vibeAgent.js` : lancer/reprendre/interrompre/envoyer un message via **ACP** (spawn
  `vibe` en mode ACP, JSON-RPC stdio) ou l'app server ; file de messages entrants comme
  `agent.js` ; état live dans le même registre.
- Routes `launch`/`reply`/`interrupt` : dispatch par provider.
- UI : permettre composer/launch sur une session vibe.

### M2 — Approbations & questions
- `notification` `approval_requested` → carte Allow/Deny (réponse via ACP `session/approve`).
- `question_asked` / outil `ask_user_question` → carte question avec options.

### M3 — Parité écosystème
- Modèles/thinking live (`/model`, `/thinking` via ACP), agents ≈ modes de permission,
  worktrees (`vibe --worktree`), fork (`/branch`), MCP lens (`[[mcp_servers]]` + OAuth),
  skills, resume.

### M4 — Sans équivalent exact (à décider feature par feature)
- Plan mode (`ExitPlanMode`), warmup de prompt cache Anthropic, `canUseTool` « allow always »
  granulaire, commandes slash custom `~/.claude/commands` → à réimplémenter au-dessus de Vibe
  ou à marquer indisponible pour le provider vibe.

## 5. Contrat de données

- **Summary** : shape `blankSummary()` (server/transcript.js) + `provider` + `dir` (dossier session
  vibe). `file` pointe vers `<dir>/journal` (jamais parsé par les parseurs Claude : guards
  `provider === "vibe"` dans `stats.js`).
- **Events normalisés** (`events.jsonl`, les deux providers) : `{ ts, event, session_id, cwd,
  transcript, tool, mode, prompt?, message?, ask?, plan?, provider, model?, usage? }` avec
  `event` ∈ noms Claude (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Notification`, `Stop`, `SessionEnd`, `SubagentStop`, `PreCompact`). Mapping Vibe :
  `session_start→SessionStart`, `pre_agent→UserPromptSubmit`, `pre_tool→PreToolUse`,
  `post_tool→PostToolUse`, `post_agent→Stop`, `notification(approval_requested)→Notification`,
  `notification(question_asked)→Notification`, `notification(turn_completed)→Stop`,
  `session_end→SessionEnd`, `pre_llm/post_llm→VibeLLM` (neutre, porte `model`+`usage`).
  `agent_name` → `mode` : `ask→default`, `accept-edits→acceptEdits`,
  `auto-approve→bypassPermissions`, `smart-approve→auto`.
  Noms d'outils qualifiés (`file_system.bash`) → dernier segment, avec
  `ask_user_question→AskUserQuestion` pour que `live.js` rende l'état « attention ».

## 6. Tests & non-régression

- Nouveaux tests unitaires (fixtures `test/fixtures/vibe-session/`) : parse journal/meta, mapping
  des hooks, `scanAllSessions` avec les deux providers, events multi-fichiers.
- Non-régression : `npm test` complet doit rester vert (les tests existants couvrent le provider
  claude ; `HOOKED_*` env vars permettent de pointer sur des fixtures, idem pour
  `HOOKED_VIBE_SESSIONS_DIR` / `HOOKED_VIBE_DATA_DIR`).

## 7. Risques & inconnues

- Le journal Vibe est un store CRDT (`mistral.vibe.unified-session-store/v1`, minor 10) : format
  **non garanti stable** entre versions de Vibe. Mitigation : parser défensif (champs optionnels),
  tests sur fixture, et les hooks (format documenté, stable) comme source live principale.
- ACP/app-server : surface vivante côté Mistral ; le pilotage passera par là en M1, avec
  fallback possible par PTY (hooked a déjà eu un pilotage tmux avant le SDK).
- Coût : tarifs Mistral ajoutés dans `server/pricing.js` (tier `mistral`), ajustables.

## 8. Installation des hooks Vibe (manuel, une fois)

Merger `scripts/hooks-vibe.toml` dans `~/.vibe/hooks.toml` (user) — chaque hook appelle
`node scripts/hook-vibe.cjs`, qui append une ligne normalisée dans `~/.vibe/hooked/events.jsonl`.
Sans ces hooks, les sessions Vibe restent visibles (scan du journal) mais sans état live.
