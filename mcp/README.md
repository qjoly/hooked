# MCP hooked

Serveur MCP local (stdio) pour piloter hooked depuis Claude Code (ou tout client MCP).

C'est un **client mince** : chaque outil appelle l'API HTTP de hooked sur localhost. Le
serveur hooked doit donc tourner (`npm run dev` ou `npm start`) pour que les outils répondent.

- Zéro dépendance (Node ≥ 24, comme le reste du projet), protocole JSON-RPC MCP en stdio.
- Aucun SSO / auth / exposition réseau : strictement local.

## Configuration

Déjà déclaré dans `.mcp.json` à la racine (scope projet) :

```json
{ "mcpServers": { "hooked": { "command": "node", "args": ["mcp/server.cjs"] } } }
```

Au prochain lancement de Claude Code dans ce dossier, approuve le serveur projet
(`/mcp` pour vérifier l'état). Pour l'enregistrer manuellement ailleurs :

```bash
claude mcp add hooked -- node /chemin/vers/hooked/mcp/server.cjs
```

### Variables d'environnement

| Var | Défaut | Rôle |
|-----|--------|------|
| `HOOKED_MCP_URL` | `http://127.0.0.1:<HOOKED_PORT>` | URL de base de l'API hooked |
| `HOOKED_PORT` | `4123` | port de hooked (utilisé si `HOOKED_MCP_URL` absent) |

## Outils exposés

| Outil | Méthode API | Description |
|-------|-------------|-------------|
| `list_sessions` | `GET /api/sessions` | Liste les sessions (live + passées) avec leur état |
| `get_session` | `GET /api/session` | Détail complet d'une session |
| `start_session` | `POST /api/launch` | Démarre / reprend une session (cwd, prompt, model, effort, resumeId, worktree) |
| `stop_session` | `POST /api/kill` | Stoppe une session (tue le pane tmux) |
| `reply_to_session` | `POST /api/reply` | Envoie un message à une session live |
| `interrupt_session` | `POST /api/interrupt` | Envoie Échap (interrompt Claude) |
| `set_mode` | `POST /api/mode` | Change le mode de permission (default / auto / plan) |
| `set_model` | `POST /api/model` | Change le modèle et/ou l'effort |
| `show_in_pane` | `POST /api/pane` | Ouvre un pane/fenêtre tmux dans la session et y lance une commande (mirroir read-only dans l'onglet « Terminal ») |
| `search_sessions` | `GET /api/search` | Recherche plein-texte |
| `get_stats` | `GET /api/stats` | Statistiques d'usage |

## Test rapide (sans client MCP)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}' \
  | node mcp/server.cjs
```
