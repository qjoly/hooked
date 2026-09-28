/**
 * Parsing of `claude -p --output-format json` output.
 *
 * The CLI changed shape: it now emits an ARRAY of events (`rate_limit_event`, `system/init`,
 * `assistant`…) terminated by `{ type: 'result', result: '<model text>', session_id,
 * total_cost_usd }`. The older shape — the bare SDKResultMessage envelope — still shows up
 * depending on the version, so both are accepted.
 *
 * Extraction goes by bracket bounds rather than a plain JSON.parse: a login-shell preamble
 * (zoxide/p10k/nvm) can prepend noise to stdout when hooked runs under launchd/systemd.
 */

function sliceJson(text, open, close) {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
}

export function objFromBraces(text) {
  return typeof text === 'string' ? sliceJson(text, '{', '}') : null;
}

// The `result` envelope of the output, whatever the shape (event array or bare object).
export function resultEnvelope(stdout) {
  if (typeof stdout !== 'string') return null;
  const arr = sliceJson(stdout, '[', ']');
  if (Array.isArray(arr)) {
    const res = arr.filter((e) => e && e.type === 'result').pop();
    if (res) return res;
  }
  const obj = objFromBraces(stdout);
  return obj && !Array.isArray(obj) ? obj : null;
}

// The JSON produced by the model itself, unwrapped from its envelope and any fences.
export function modelJson(stdout) {
  const env = resultEnvelope(stdout);
  if (env && typeof env.result === 'string') return objFromBraces(env.result);
  return env;
}
