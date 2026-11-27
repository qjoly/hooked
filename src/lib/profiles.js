/*
 * Connection profiles, client side (server/profiles.js is the other half). Pure helpers shared by
 * the pickers and the session view: a neutral registry both import, like src/lib/models.js.
 *
 * A profile as the client sees it never carries its env: { id, label, kind, models, implicit }
 * from GET /api/profiles, and { id, label, kind, missing? } on a session (null on the default one).
 */
import { modelAlias } from './format.js';

export const isCompatible = (p) => !!p && p.kind === 'compatible';

/*
 * The model <select> options of a compatible profile, in the groups shape ModelEffort renders
 * ([{ label, opts: [[id, label], …] }]). `current` always stays listed, even when the server's list
 * does not include it (a model unloaded since, or a list that has not arrived yet): a bound <select>
 * would lose its value otherwise.
 */
export function profileModelGroups(models, current = '') {
  const opts = (models || []).map((m) => [m.id, m.label || m.id]);
  if (current && !opts.some(([id]) => id === current)) opts.unshift([current, current]);
  return opts.length ? [{ label: '', opts }] : [];
}

/*
 * The picker key of a session's model. On Claude it is the family alias or version (`opus`,
 * `claude-opus-4-8`), which is what `modelAlias` extracts from the transcript's id. A model of
 * another server has no such shape — `qwen/qwen3-coder-30b` contains no family name, so the alias
 * would come out empty and the picker would show `opus` — it is used as it is.
 */
export function sessionModelKey(s) {
  if (!s) return '';
  const own = s.profile && s.profile.kind !== 'anthropic';
  return s.launchModel || (own ? s.model || '' : modelAlias(s.model));
}
