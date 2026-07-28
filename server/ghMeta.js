import { execFile } from 'node:child_process';
import fs from 'node:fs';

const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const GH_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/;

// Résout le binaire `gh` UNE fois. Sous systemd/launchd le PATH du serveur est minimal (cf. la
// mémoire live-dashboard / CLAUDE.md) → `execFile('gh')` échoue en ENOENT alors que gh est bien
// installé (brew, ~/.local…). On teste d'abord les emplacements usuels, sinon on demande son
// chemin à un shell de LOGIN (profils sourcés → PATH complet), sinon on retombe sur 'gh' (marche
// si le PATH le contient). Résultat mémoïsé (promesse) — coût payé au premier lien enrichi.
let ghBinPromise = null;
function resolveGh() {
  if (ghBinPromise) return ghBinPromise;
  ghBinPromise = new Promise((resolve) => {
    const home = process.env.HOME || '';
    const candidates = [
      '/home/linuxbrew/.linuxbrew/bin/gh', '/opt/homebrew/bin/gh',
      '/usr/local/bin/gh', '/usr/bin/gh', `${home}/.local/bin/gh`,
    ];
    for (const p of candidates) { try { if (fs.existsSync(p)) return resolve(p); } catch { /* ignore */ } }
    const shell = process.env.SHELL || '/bin/sh';
    execFile(shell, ['-l', '-c', 'command -v gh'], { timeout: 4000 }, (err, out) => {
      const p = String(out || '').trim().split('\n').filter(Boolean).pop();
      resolve(err || !p ? 'gh' : p);
    });
  });
  return ghBinPromise;
}

function run(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 6000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

async function ghView(url) {
  const m = GH_URL.exec(String(url || ''));
  if (!m) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const gh = await resolveGh();
  const kind = m[1] === 'pull' ? 'pr' : 'issue';
  // reviewDecision n'existe que pour `pr view` (APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED/'').
  const fields = kind === 'pr' ? 'title,body,state,author,number,reviewDecision' : 'title,body,state,author,number';
  const d = await run(gh, [kind, 'view', url, '--json', fields]);
  const out = d ? { kind, number: d.number, title: d.title, state: d.state, author: d.author?.login || '', body: (d.body || '').slice(0, 4000), reviewDecision: d.reviewDecision || '' } : null;
  cache.set(url, { at: Date.now(), data: out });
  return out;
}

export { ghView };
