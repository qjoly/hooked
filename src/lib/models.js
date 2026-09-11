/*
 * Filtre d'affichage des modèles — partagé serveur (server/settings.js, pour le défaut) et client
 * (ModelEffort.svelte, page Réglages). Même statut que src/lib/editors.js : un registre neutre que
 * les deux côtés importent.
 *
 * C'est une LISTE NOIRE, pas une liste blanche, et c'est le point de conception : server/capabilities.js
 * dérive les modèles LIVE du binaire claude justement pour ne pas rater une nouvelle version. Une liste
 * blanche annulerait ça — un `claude-opus-5-1` fraîchement livré resterait invisible jusqu'à ce que
 * l'utilisateur pense à le cocher. En liste noire, ce qui est nouveau est visible par défaut, et seules
 * les vieilles versions déjà connues sont masquées.
 *
 * Le filtre est purement COSMÉTIQUE et appliqué côté client : /api/capabilities renvoie toujours la
 * liste complète (la page Réglages en a besoin pour proposer les cases à cocher, et le store `settings`
 * est réactif → décocher une version met à jour les sélecteurs sans recharger). Rien ici ne restreint
 * ce qu'une session peut réellement utiliser : un modèle masqué reste valide au lancement, et
 * ModelEffort ré-injecte toujours le modèle courant d'une session même s'il est masqué.
 */

// Versions masquées par défaut : les générations anciennes de chaque famille. Ce qui reste visible
// d'origine = Opus 5 / 4.8 / 4.7 / 4.6, Sonnet 5 / 4.6, Haiku 4.5, Fable 5.1 / 5, plus l'alias de
// famille (« Opus (default) »…), jamais masquable.
export const DEFAULT_HIDDEN_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-5',
  'claude-sonnet-4-0',
  'claude-sonnet-3-7',
  'claude-haiku-3-5',
];

// Un id de version concrète tel que buildModelGroups les produit. Sert de validation à l'écriture
// des réglages : seule une version concrète est masquable (donc jamais un alias de famille, ce qui
// interdit de se retrouver avec une famille entièrement vide).
export const MODEL_VERSION_RE = /^claude-(opus|sonnet|haiku|fable)-\d+(-\d+)?$/;

export const isHideableModel = (id) => typeof id === 'string' && MODEL_VERSION_RE.test(id);

/*
 * Retire des groupes (forme de server/capabilities.js : [{ label, opts: [[id, label], …] }]) les
 * versions listées dans `hidden`. `keep` est le modèle actuellement sélectionné : il survit toujours
 * au filtre, sinon un <select> lié perdrait sa valeur. Un groupe vidé disparaît.
 */
export function filterModelGroups(groups, hidden, keep = '') {
  const hide = new Set((hidden || []).filter(isHideableModel));
  if (!hide.size) return groups || [];
  return (groups || [])
    .map((g) => ({ ...g, opts: (g.opts || []).filter(([id]) => !hide.has(id) || id === keep) }))
    .filter((g) => g.opts.length);
}
