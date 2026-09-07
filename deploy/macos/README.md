# hooked — service macOS (LaunchAgent, dev/HMR)

Fait tourner hooked en **dev (auto-reload Vite/HMR)** comme **service utilisateur** qui démarre
**au login** et se relance tout seul en cas de crash.

## Installation (sur le Mac)

```bash
git clone git@github.com:LuccaSA/hooked.git ~/dev/hooked
cd ~/dev/hooked
mise install 2>/dev/null || true   # si tu utilises mise (node est pinné dans mise.toml)
npm install
npm run setup                       # branche les hooks Claude Code de CE Mac
./deploy/macos/install.sh           # installe + démarre le LaunchAgent
```

Puis ouvre **http://localhost:4123**. En local (`localhost`), le contexte est « sécurisé » →
les **notifications bureau natives** fonctionnent sans HTTPS.

Changer de port : `HOOKED_PORT=5000 ./deploy/macos/install.sh`.

## Gérer le service

```bash
tail -f /tmp/hooked.log                                  # logs (Vite)
launchctl print gui/$(id -u)/com.hooked.dev | grep state # doit afficher "running"
launchctl kickstart -k gui/$(id -u)/com.hooked.dev       # redémarrer
launchctl bootout    gui/$(id -u)/com.hooked.dev         # arrêter + désactiver
```

## Notes

- **PATH** : launchd démarre avec un PATH minimal. `run-dev.sh` y remet node/npm (shims **mise**
  + **Homebrew**). Si `/tmp/hooked.err.log` montre `node: command not found`, ajoute le dossier
  renvoyé par `which node` dans le `export PATH` de `run-dev.sh`.
- **Auto-reload** : c'est `vite dev` → HMR à chaque modif de fichier ; `KeepAlive` le relance au
  login et après un crash.
- **Accès via un nom d'hôte custom** (pas `localhost`/IP) : Vite bloquera tant que
  `server.allowedHosts` n'est pas configuré dans `vite.config.js`.
