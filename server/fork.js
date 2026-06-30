/*
 * Fork d'une session à partir d'un message.
 *
 * Principe : un transcript Claude Code est un JSONL append-only où chaque ligne porte un
 * `uuid` stable et un `sessionId` (= nom du fichier). Forker « à partir d'un message » =
 * copier le PRÉFIXE brut du transcript jusqu'à la ligne de ce message (incluse), réécrire
 * le `sessionId` sur un nouvel id, écrire ce préfixe dans `<projet>/<newId>.jsonl`, puis
 * `claude --resume <newId>` (cf. tmux.launchSession). La session d'origine n'est JAMAIS
 * touchée (fichier distinct) — c'est une vraie branche indépendante.
 *
 * Le point de coupe (`forkUuid`) est l'uuid exposé par buildConversation sur chaque bulle.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { scanSessions } from './transcript.js';
import { launchSession, err400 } from './tmux.js';

function safeParse(line) { try { return JSON.parse(line); } catch (_) { return null; } }

// Nombre de tool_use sans tool_result correspondant parmi les objets fournis. Sert à
// détecter un préfixe non reprenable (tour coupé en plein appel d'outil) avant le resume.
function danglingToolUses(parsed) {
  const results = new Set();
  for (const j of parsed) {
    if (j && j.type === 'user' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) if (b && b.type === 'tool_result' && b.tool_use_id) results.add(b.tool_use_id);
    }
  }
  let open = 0;
  for (const j of parsed) {
    if (j && j.type === 'assistant' && j.message && Array.isArray(j.message.content)) {
      for (const b of j.message.content) if (b && b.type === 'tool_use' && b.id && !results.has(b.id)) open++;
    }
  }
  return open;
}

// Construit les lignes du transcript forké : préfixe JSONL [début .. ligne `forkUuid`]
// (incluse), `sessionId` réécrit sur `newId`. Pur (aucune I/O) → testable seul.
// Garde-fou : si la dernière ligne retenue laisse un tool_use sans résultat (tour interrompu),
// on retire les lignes de fin jusqu'à rééquilibrer — sinon le resume part d'un état cassé.
function buildForkLines(rawText, forkUuid, newId) {
  const kept = [];     // lignes JSON réécrites (strings)
  const parsed = [];   // objets correspondants (pour le contrôle d'équilibre)
  let found = false;
  for (const line of String(rawText).split('\n')) {
    if (!line) continue;
    const j = safeParse(line);
    if (!j) continue; // ligne corrompue : ignorée (cohérent avec parseTranscript/buildConversation)
    if (j.sessionId) j.sessionId = newId;
    kept.push(JSON.stringify(j));
    parsed.push(j);
    if (j.uuid && j.uuid === forkUuid) { found = true; break; }
  }
  if (!found) return { found: false, lines: [] };
  while (kept.length && danglingToolUses(parsed) > 0) { kept.pop(); parsed.pop(); }
  return { found: true, lines: kept };
}

// Forke la session `id` au message `forkUuid`, puis reprend la branche dans une nouvelle
// session tmux (modèle/effort optionnels, prompt optionnel envoyé après démarrage).
function forkSession({ id, forkUuid, prompt, model, effort, permissionMode }, cb) {
  if (!/^[A-Za-z0-9._-]+$/.test(id || '')) return cb(err400('id de session invalide'));
  if (!/^[A-Za-z0-9-]{6,}$/.test(forkUuid || '')) return cb(err400('message (uuid) invalide'));
  const sess = scanSessions().find((s) => s.id === id);
  if (!sess || !sess.file) return cb(err400('session introuvable'));

  let raw;
  try { raw = fs.readFileSync(sess.file, 'utf8'); } catch (_) { return cb(err400('transcript illisible')); }

  const newId = crypto.randomUUID();
  const { found, lines } = buildForkLines(raw, forkUuid, newId);
  if (!found) return cb(err400('message introuvable dans le transcript'));
  if (!lines.length) return cb(err400('rien à forker à ce point'));

  const newFile = path.join(path.dirname(sess.file), newId + '.jsonl');
  try { fs.writeFileSync(newFile, lines.join('\n') + '\n'); }
  catch (e) { return cb(new Error('écriture du fork échouée : ' + (e.message || e))); }

  // on reprend dans le dossier d'origine de la session (cwd conservé dans le préfixe copié).
  launchSession({ resumeId: newId, cwd: sess.project, prompt, model, effort, permissionMode }, (err, info) => {
    if (err) {
      try { fs.unlinkSync(newFile); } catch (_) {} // nettoyage si le lancement tmux échoue
      return cb(err);
    }
    cb(null, { ...info, forkedFrom: id });
  });
}

export { buildForkLines, danglingToolUses, forkSession };
