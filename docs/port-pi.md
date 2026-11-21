# Port hooked sur pi (Mistral via `pi-mistral-subscription`) — plan

Branche `feat/pi-mistral`, repartie de `feat/vibe-provider`. Même objectif que
`docs/port-vibe.md`, mais le provider Mistral est piloté par [**pi**](https://github.com/earendil-works/pi)
(CLI agent de Earendil Works) avec le package
[**pi-mistral-subscription**](https://github.com/5omeOtherGuy/pi-mistral-subscription) (sign-in
abonnement Mistral AI Studio) **au lieu de `vibe-acp` (ACP)**. Sur cette branche, le provider id
est **`pi`** (il remplace `vibe` partout : scan, driver, routes, UI web, rune).

## 0. Ce qui a été vérifié sur l'installation locale (2026-11-21)

- `npm i -g @earendil-works/pi-coding-agent` → `pi` 1.6.0 (bin `pi`, node ≥ 22.19 ; ici node 24.22.2).
- `pi install https://github.com/5omeOtherGuy/pi-mistral-subscription` → package listé dans
  `~/.pi/agent/settings.json` (`packages: [...]`), il enregistre le provider built-in `mistral`
  avec un OAuth « browser sign-in » Mistral AI Studio.
- **Sign-in headless faisable** (device flow pur, cf. `src/mistral-oauth.ts` du package) :
  POST `https://console.mistral.ai/api/vibe/sign-in` `{code_challenge, code_challenge_method:"S256"}`
  → `{process_id, sign_in_url, poll_url, expires_at}` ; ouvrir `sign_in_url` ; poller `poll_url`
  (3 s) → `{"status":"completed","exchange_token"}` ; POST
  `/api/vibe/sign-in/{process_id}/exchange` `{exchange_token, code_verifier}` → `{api_key}` ;
  écrire `~/.pi/agent/auth.json` :
  `{"mistral":{"type":"oauth","access":api_key,"refresh":"mistral-browser-sign-in","expires":<ms+10 ans>}}`
  (mode 0600). ✅ fait sur cette machine (`~/.pi/agent/auth.json`). Script de référence :
  `~/pi-signin.mjs`.
- `pi --list-models mistral` liste le catalogue (mistral-large-4, medium-3.5, small, devstral, glm…).
- `pi -p "…" --model mistral/<id> --no-session` → texte final sur stdout (headless).
- `pi --mode json …` → events JSONL sur stdout. **`pi --mode rpc`** → protocole JSONL bidirectionnel
  sur stdio (commandes `prompt`, `abort`, `get_state`, `get_messages`, `get_entries`,
  `get_session_stats`, `set_model`, `set_thinking_level`, `switch_session`, `fork`, `clone`,
  `new_session`, `set_session_name`, `bash`… ; réponses `{id,type:"response",command,success,data}` ;
  events `agent_start/turn_start/message_start/message_update(assistantMessageEvent: text_delta,
  thinking_delta, toolcall_*)/message_end/turn_end/agent_end/agent_settled`,
  `tool_execution_start{toolCallId,toolName,args}/update/end{result,isError}`).
- Sessions persistées : `~/.pi/agent/sessions/--<cwd encodé>--/<timestamp>_<sessionId>.jsonl`
  (JSONL, arbre `id`/`parentId`, v3). Header `{"type":"session","version":3,"id","timestamp","cwd","parentSession"?}`.
  Entrées : `model_change`, `thinking_level_change`, `message` (system/user/assistant/toolResult),
  `session_info` (name), `usage`, `compaction`, `branch_summary`, `label`, `custom`.
  `--session-id <id>` crée/reprend une session avec cet id ; `--session <file>` reprend par fichier.
  ✅ testé en RPC : prompt → toolcall `write` → tool_exec → réponse → `agent_settled` ;
  `get_session_stats` renvoie `tokens`, `cost`, `contextUsage{tokens,contextWindow,percent}`.
- MCP : `~/.pi/agent/mcp.json` + `<projet>/.pi/mcp.json`, format standard
  `{"mcpServers":{"name":{"command","args","env"} | {"url","headers","type":"http"}}}`.
- Prompts slash : `~/.pi/agent/prompts/*.md` + `<projet>/.pi/prompts/*.md`. Skills : `~/.pi/agent/skills`, `.pi/skills`.

## 1. Architecture cible (miroir de port-vibe.md, provider `pi` à la place de `vibe`)

```
session.provider = "claude" | "pi"
  ├─ scan     server/transcript.js (claude) + server/pi.js (pi) → server/sessions.js scanAllSessions()
  ├─ pilotage server/agent.js dispatch st.provider === 'pi' → server/piAgent.js (RPC JSONL stdio vers `pi --mode rpc`)
  ├─ live     registre agent.js (st.pi) → emitAgent → SSE /api/session/stream (pas de hooks fichier pi ;
  │           état "working" déduit du mtime du .jsonl si pi tourne en externe)
  └─ détail   server/stats.js branches provider==='pi' → buildPiConversation, piContext, etc.
```

## 2. Étapes

| # | Contenu | Fichiers |
|---|---------|----------|
| P1 | Détection provider pi | `server/providers.js` (`pi: which('pi') \|\| exists(~/.pi/agent)`), `server/config.js` (`PI_SESSIONS_DIR`) |
| P2 | Scan + parse sessions pi | `server/pi.js` : `scanPiSessions()`, `buildPiConversation(file)`, `piContext`, `piSetArchived` (rename `.jsonl.trashed`), `piToolDetail/Output`, `buildPiTrace`, `piToolPaths`, liens PR/issue ; `server/sessions.js` |
| P3 | Conversation → shape front | messages `{role, ts, text, thinking?, tools:[{id,name,detail,inputText,result,status,input,output,diff}], forkUuid}` (toolCall/toolResult appariés par `toolCallId`) |
| P4 | Driver RPC | `server/piAgent.js` : `PiRpcClient` (spawn `pi --mode rpc`), `piStart/piPrompt/piCancel/piSetConfig/piKill/piFork/piOptions` ; dispatch dans `server/agent.js` |
| P5 | Routes | `/api/pi-options`, `provider=pi` dans `/api/launch`, `/api/reply`, `/api/commands`, `/api/mcp`, `/api/skills`, `/api/session/message|trace|file-changes`, `/api/trash|restore`, `/api/fork` |
| P6 | stats.js branches pi | état live, todos (aucun outil todo natif → `[]`), subagents (`[]`), context (`contextUsage` du driver ou estimé depuis dernier usage + contextWindow modèle), detail |
| P7 | MCP + commandes + skills pi | `server/piMcp.js` (parse mcp.json + health-check HTTP `initialize`), `server/piCommands.js` (`.pi/prompts`), `server/skills.js` provider pi |
| P8 | Headless | `server/piCli.js` : `runPiHeadless` (`pi -p --model mistral/<m>`), utilisé par digests/autoTags en fallback |
| P9 | UI web | remplacer `'vibe'` par `'pi'` : `src/lib/providers.js`, badges (SessionSidebar/Deck), `NewSession.svelte` (picker claude/pi + options pi), `SessionDetail.svelte`, `format.js` (agentName, resume cmd), routes |
| P10 | desktop-rune | `Providers{claude,pi}`, badge `pi`, filtre cycle claude→pi, `new_session.rs` modèles pi, `session.rs` |
| P11 | Tests + E2E | fixtures `.jsonl` pi dans `test/pi.test.mjs` ; E2E live : launch provider=pi → prompt → SSE → réponse → resume → fork ; `npm test`, `cargo test`, build, deploy |

## 3. Différences pi vs vibe à garder en tête

- **Pas d'approbation/question côté protocole** : pi RPC n'a pas de `request_permission`/`elicitation`
  → les sessions pi pilotées par hooked tournent en **auto-approve** (pas de `pendingAsk`
  permission/question). Le sélecteur de mode est masqué ou forcé « auto » pour pi.
- **Pas de subagents / todos / screenshots natifs** → sections vides (le front masque déjà quand vide).
- **Trash** : renommer le `.jsonl` en `.jsonl.trashed` (pi ne lit que les `.jsonl`).
- **Fork** : `fork` RPC avec `entryId` (message user) dans un process pi jetable
  (`--session <file>` → `fork` → `get_state` → nouveau fichier), comme `vibeFork`.
- **Titre** : entry `session_info` (`set_session_name`) prioritaire, sinon premier prompt user.
- **Usage/contexte** : `usage` des messages assistant (`input/output/cacheRead/cacheWrite/totalTokens/cost`) ;
  `get_session_stats` donne `contextUsage` exact côté driver.
- **Modèles** : `pi --list-models mistral` (parse texte) ou catalog pi ; thinking levels
  `off|minimal|low|medium|high|xhigh|max` clampés par modèle.
- **Events live hors driver** : pas de hooks fichier → si pi tourne dans un terminal externe, l'état
  est déduit du mtime du fichier de session (< 90 s → working).

## 4. Non-régression Claude

Tout le chemin claude reste par défaut. `npm test` (tests existants, moins les tests vibe remplacés
par des tests pi) + `cargo test` + E2E claude (`618f3fae`-style) à chaque étape.

## 5. État de l'implémentation (branche feat/pi-mistral, PR #132) — 2026-11-21

Toutes les étapes P1–P11 sont livrées et testées en E2E live contre le service déployé :

| Feature | Statut E2E |
|---|---|
| Scan + liste sessions pi (`/api/sessions`, `providers {claude, pi}`) | ✅ 13 sessions pi visibles |
| Launch `provider=pi` + prompt | ✅ `PI-E2E-OK` |
| Reply / resume (même session) | ✅ `PI-E2E-RESUME`, resume externe `resumeId` garde l'historique |
| Stream SSE live (`/api/session/stream`) | ✅ 1019 caractères streamés, states running→idle, preview vidée à `agent_settled` |
| Tool call (bash) avec détail (inputText/result/status) | ✅ `PI-TOOL-OK` |
| Diff inline write/edit | ✅ `piToolDiff` (write→Write, edit→MultiEdit) |
| Jauge contexte | ✅ `piContext` (dernier usage + fenêtre modèle) ; `get_session_stats` exact côté driver |
| setModel / setMode / interrupt / kill | ✅ modèle changé à chaud, `APRES-INTERRUPT` répond |
| Trash / restore | ✅ rename `.jsonl.trashed`, la session quitte/revient de la liste |
| Fork | ✅ RPC `fork`/`clone` + relance → `FORK-OK` (pas de bug vibe-acp) |
| Auto-resume après restart du service (DRIVEN_FILE) | ✅ session pi reprise `live=true`, reply → `APRES-RESTART-OK` |
| MCP hooked dans pi (`~/.pi/agent/mcp.json`) | ✅ `mcp__hooked__list_sessions` → `MCP-PI-OK 16` |
| MCP lens `/api/mcp?provider=pi&check=1` | ✅ stdio « configured », HTTP vrai handshake `initialize` → `connected` |
| Skills pi (`~/.pi/agent/skills`, `.pi/skills`) | ✅ `demo-skill` listée, `provider: 'pi'` |
| Commandes `/` pi (`.pi/prompts`, skills) | ✅ `review`, `skill:demo-skill` |
| Recherche plein texte (index) | ✅ session pi retrouvée (`APRES-INTERRUPT`) |
| `/api/session/message` (texte complet), `/trace`, `/file-changes` (diff VCS) | ✅ |
| Headless `pi -p` (digests/autoTags fallback) | ✅ `HEADLESS-PI-OK` (stdin fermé : pi lit stdin jusqu'à EOF) |
| Non-régression claude | ✅ `CLAUDE-REGRESS-OK` |

Tests : `npm test` 1120 OK (dont `test/pi.test.mjs` 6 tests sur fixture JSONL), `cargo test` 128 OK,
`cargo check` 0 warning, `npm run build` OK, app rune rebuildée+installée.

Notes : pas d'approbation/question côté RPC pi (auto-approve), pas de sous-agents/todos/screenshots
natifs (sections vides), pas de hooks fichier pi (état live via le driver + mtime du `.jsonl`).

## 6. Réglage « activer/désactiver un provider » (providers on/off/auto) — 2026-11-21

Motivation : déploiement sur une machine **sans pi** (ou avec pi hors PATH sous launchd) —
le provider pi ne doit ni apparaître dans l'UI ni être lançable, et à l'inverse `on` force
pi actif quand la détection auto échoue.

- `settings.json` : `providers: { claude: 'auto', pi: 'auto' }` — `'auto'` = détection machine
  (binaire dans le PATH / `~/.pi/agent`), `'on'` = forcé actif, `'off'` = masqué + lancement
  refusé. Sanitize : toute valeur inconnue retombe sur `'auto'` (`server/settings.js`).
- `server/providers.js` : `applyProviderOverride(auto, setting)` (pur, testé) +
  `configuredProviders()` — détection auto mémoïsée 30 s, **réglage relu à chaque appel** ;
  exposé via `GET /api/sessions` → `{ providers: { claude, pi } }` (badges/picker web + rune
  suivent automatiquement ; pillule affichée seulement quand les deux sont actifs).
- Refus clair au lancement (`server/agent.js`) : provider réglé `'off'` →
  err400 `the pi provider is disabled in the hooked settings (providers.pi = "off")` ;
  provider pi actif mais binaire introuvable (`piBinaryAvailable()` :
  `HOOKED_PI_BIN`/which/candidats usuels) → err400 « install @earendil-works/pi-coding-agent
  or set HOOKED_PI_BIN… ». Même garde dans `runPiHeadless` (`server/piCli.js`).
- UI : page web Réglages → « Providers », deux selects Auto/On/Off (claude + pi), sauvés via
  `POST /api/settings` puis `loadSessions()` pour rafraîchir badges/picker. Rune : pas de
  réglage propre — il lit `providers` via `/api/sessions` (pillules cachées si un seul actif).
- Tests : `test/providersOverride.test.mjs` (11 tests — override pur, sanitize, configuredProviders
  avec env déterministe, piBinaryAvailable faux sur binaire bidon).
