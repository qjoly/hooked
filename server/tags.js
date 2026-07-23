/*
 * Étiquettes de session persistées côté serveur (tags.json de HOOKED_DIR), partagées entre tous
 * les navigateurs — contrairement à l'ancien stockage par-navigateur (localStorage 'hooked.ui').
 * Forme : { [sessionId]: string[] }. Le serveur re-normalise toujours (dédup, trim, cap) : la
 * couche cliente peut envoyer une liste brute, la source de vérité est ici.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR } from './config.js';

const TAGS_FILE = path.join(HOOKED_DIR, 'tags.json');
const MAX_TAG_LEN = 40;          // longueur max d'un tag (aligné sur l'ancien setSessionTags client)
const MAX_TAGS_PER_SESSION = 40; // borne anti-abus par session

// Normalise une liste de tags : chaînes uniquement, trim, non vides, rognées, dédupliquées, bornées.
function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const clean = [...new Set(
    list
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => t.slice(0, MAX_TAG_LEN)),
  )];
  return clean.slice(0, MAX_TAGS_PER_SESSION);
}

// Ramène une map arbitraire (fichier ou payload client) à { [sessionId]: string[] } sûr. Les
// entrées vides (aucun tag valide) sont retirées → le fichier ne garde que des assignations réelles.
function sanitize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const [id, list] of Object.entries(o)) {
    if (typeof id !== 'string' || !id) continue;
    const clean = cleanList(list);
    if (clean.length) out[id] = clean;
  }
  return out;
}

// Lit la map complète (vide si le fichier est absent/illisible). Pas de cache : lecture directe,
// le fichier est petit et rarement lu (chargement de page + édition ponctuelle).
function readTags() {
  try {
    return sanitize(JSON.parse(fs.readFileSync(TAGS_FILE, 'utf8')));
  } catch (_) {
    return {};
  }
}

// Écrit la map complète (validée), renvoie le résultat persisté.
function writeTags(map) {
  const clean = sanitize(map);
  try {
    fs.mkdirSync(HOOKED_DIR, { recursive: true });
    fs.writeFileSync(TAGS_FILE, JSON.stringify(clean, null, 2) + '\n');
  } catch (e) {
    throw new Error('tags.json write failed: ' + (e.message || e));
  }
  return clean;
}

// Remplace (ou efface) les tags d'une seule session ; renvoie la map complète à jour. Liste vide
// (ou aucun tag valide) → l'entrée est retirée.
function setTags(id, list) {
  if (typeof id !== 'string' || !id) throw new Error('invalid session id');
  const map = readTags();
  const clean = cleanList(list);
  if (clean.length) map[id] = clean;
  else delete map[id];
  return writeTags(map);
}

export { TAGS_FILE, readTags, writeTags, setTags };
