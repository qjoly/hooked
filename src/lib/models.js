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
 * Même liste noire pour le provider pi (catalogue de `pi --list-models mistral`). Deux différences
 * avec Claude : aucune grammaire de version à respecter (`mistral-large-latest`,
 * `zai-glm-5-3-flash`, `labs-devstral-small-2512`…) et aucun alias de famille à protéger — donc
 * TOUS les ids du catalogue sont masquables. La seule garde est celle de la forme : un id vide, une
 * phrase ou un chemin ne sont pas des modèles, et on ne veut pas les voir traîner dans les réglages.
 */
export const PI_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;

export const isHideablePiModel = (id) => typeof id === 'string' && PI_MODEL_RE.test(id);

// Set des ids réellement masquables (un réglage trafiqué ne masque pas autre chose qu'un modèle).
const hiddenSet = (hidden, isHideable) => new Set((hidden || []).filter(isHideable));

/*
 * Retire des groupes (forme de server/capabilities.js : [{ label, opts: [[id, label], …] }]) les
 * versions listées dans `hidden`. `keep` est le modèle actuellement sélectionné : il survit toujours
 * au filtre, sinon un <select> lié perdrait sa valeur. Un groupe vidé disparaît.
 */
export function filterModelGroups(groups, hidden, keep = '') {
  const hide = hiddenSet(hidden, isHideableModel);
  if (!hide.size) return groups || [];
  return (groups || [])
    .map((g) => ({ ...g, opts: (g.opts || []).filter(([id]) => !hide.has(id) || id === keep) }))
    .filter((g) => g.opts.length);
}

/*
 * Même filtre pour une liste plate de modèles pi (forme [[id, label], …], cf. /api/pi-options),
 * qui n'a pas de groupes. `keep` joue le même rôle que ci-dessus.
 */
export function filterModelOpts(opts, hidden, keep = '') {
  const hide = hiddenSet(hidden, isHideablePiModel);
  if (!hide.size) return opts || [];
  // Catalog entries are `provider/id`; an id hidden before models were qualified still hides them.
  const bare = (id) => (String(id).includes('/') ? String(id).slice(String(id).indexOf('/') + 1) : id);
  return (opts || []).filter(([id]) => !(hide.has(id) || hide.has(bare(id))) || id === keep);
}

// Liste noire par défaut du provider pi : rien de masqué. Le catalogue pi est déjà court et mis à
// jour par `pi`, et masquer une famille « ancienne » n'a pas de sens ici (les `-latest` sont des
// alias du catalogue, pas des doublons de version).
export const DEFAULT_HIDDEN_PI_MODELS = [];

/*
 * ---- Quota-aware default (New Session) ----
 *
 * Fable carries its OWN weekly quota, scoped to the model (cf. server/utilization.js → scopedLimit);
 * the 5h / 7d account buckets say nothing about it. Once it is spent, launching on Fable does not
 * degrade gracefully — the session errors out on its first turn. So when the *default* model of the
 * New Session page resolves to Fable and that bucket is full, we fall back to the family alias
 * `opus` ("Opus (default)"). Only the default is overridden: picking Fable by hand stays possible,
 * because the quota we read can be minutes old (cache fallback) and the user may know better.
 */

// Does this model id belong to the Fable family? Covers both the rolling alias ('fable') and a
// concrete version ('claude-fable-5-1').
export const isFableModel = (id) => /^(claude-)?fable\b/.test(String(id || ''));

// Model the quota fallback lands on — the family alias, never a pinned version.
export const QUOTA_FALLBACK_MODEL = 'opus';

/*
 * Is a model-scoped bucket (shape of scopedLimit: { pct, severity, … }) spent? `pct` is the
 * authority — it is what the gauge shows — and we only treat a *full* bucket as blocking: at 99%
 * a session still starts. `severity` is a server-side label whose vocabulary is not ours to pin,
 * so only its unambiguous value is honoured, as a second witness when the percentage is missing.
 */
export function isQuotaExhausted(bucket) {
  if (!bucket) return false;
  if (bucket.pct != null) return bucket.pct >= 100;
  return String(bucket.severity || '').toLowerCase() === 'exhausted';
}

/*
 * The model a fresh session should DEFAULT to, given the configured default and the Fable bucket.
 * Pure — the whole point of the feature lives here, the component only wires data in.
 * Returns the input unchanged whenever nothing is wrong.
 */
export function defaultModelForQuota(model, fableBucket) {
  return isFableModel(model) && isQuotaExhausted(fableBucket) ? QUOTA_FALLBACK_MODEL : model;
}
