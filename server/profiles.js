/*
 * Connection profiles: where a driven session sends its requests.
 *
 * Until now every session used the one Claude account the CLI is signed in to. A profile names
 * another destination instead: a second Anthropic account, or an Anthropic-compatible server such
 * as LM Studio (possibly several of them). A profile is nothing more than the environment variables
 * the session's `claude` process is given, plus the label and models the pickers show.
 *
 * profiles.json (in the hooked data dir) is a JSON array:
 *
 *   [
 *     {
 *       "id": "lmstudio-home",              // [a-z0-9_-], 1-32 chars; "default" is reserved
 *       "label": "LM Studio (home)",        // optional, defaults to the id
 *       "kind": "compatible",               // "anthropic" | "compatible"
 *       "env": {
 *         "ANTHROPIC_BASE_URL": "http://127.0.0.1:1234",
 *         "ANTHROPIC_AUTH_TOKEN": "lmstudio",
 *         "ANTHROPIC_API_KEY": { "fromEnv": "WORK_API_KEY" },
 *         "SECRET_FROM_FILE": { "file": "~/.config/hooked/token" }
 *       },
 *       "models": ["qwen/qwen3-coder-30b", { "id": "qwen/qwen3.8-27b", "label": "Qwen 27B" }]
 *     }
 *   ]
 *
 * An env value is a literal string, or a reference resolved when a session starts, so that a token
 * never has to sit in this file: `{ "fromEnv": NAME }` reads the login environment the sessions run in (so a variable
 * exported in your shell profile works),
 * `{ "file": PATH }` reads a file (absolute, or `~/…`; one trailing newline is dropped).
 *
 * The implicit `default` profile is always first and has no env: it is today's behaviour. A missing
 * file means only that profile. A bad entry is skipped and reported, never fatal: one typo must not
 * take the whole dashboard's launch screen down.
 *
 * Nothing here is secret-aware beyond that: `publicProfile` is the only shape that leaves the
 * server, and it carries no env at all.
 *
 * A session launched with a profile gets its env merged over the login environment, after the
 * credential variables the login environment may carry (`ANTHROPIC_*`, `CLAUDE_CODE_OAUTH_TOKEN`)
 * have been dropped: a profile picks the destination entirely, so an `ANTHROPIC_API_KEY` exported
 * in a shell profile must not follow a session to another account or to a local server. The
 * `default` profile touches nothing.
 *
 * Node stdlib only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROFILES_FILE, isValidModelArg } from './config.js';

export const DEFAULT_PROFILE_ID = 'default';
export const PROFILE_KINDS = ['anthropic', 'compatible'];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Model ids are interpolated into the CLI's `--model` / the SDK's `setModel`, and LM Studio's carry
// a publisher prefix (`qwen/qwen3-coder-30b`): a strict charset, but one that allows `/` and `.`.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/;

export function defaultProfile() {
  return { id: DEFAULT_PROFILE_ID, label: 'Default', kind: 'anthropic', env: {}, models: [], implicit: true };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// One env entry → the normalized value (a string, or a `{ fromEnv }` / `{ file }` reference), or an
// error message. Exactly one reference key, and no empty reference.
function parseEnvValue(v) {
  if (typeof v === 'string') return { value: v };
  if (!isPlainObject(v)) return { error: 'must be a string, { "fromEnv": NAME } or { "file": PATH }' };
  const keys = Object.keys(v);
  if (keys.length !== 1 || !['fromEnv', 'file'].includes(keys[0])) {
    return { error: 'a reference has exactly one key, "fromEnv" or "file"' };
  }
  const key = keys[0];
  if (typeof v[key] !== 'string' || !v[key]) return { error: `"${key}" must be a non-empty string` };
  if (key === 'fromEnv' && !ENV_NAME_RE.test(v[key])) return { error: '"fromEnv" must be a variable name' };
  if (key === 'file' && !(path.isAbsolute(v[key]) || v[key].startsWith('~/'))) {
    return { error: '"file" must be an absolute path or start with ~/' };
  }
  return { value: { [key]: v[key] } };
}

function parseModels(raw) {
  if (raw === undefined) return { models: [] };
  if (!Array.isArray(raw)) return { error: '"models" must be an array' };
  const models = [];
  const seen = new Set();
  for (const m of raw) {
    const id = typeof m === 'string' ? m : isPlainObject(m) ? m.id : null;
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id)) return { error: `invalid model id ${JSON.stringify(id)}` };
    if (seen.has(id)) continue;
    seen.add(id);
    const label = isPlainObject(m) && typeof m.label === 'string' && m.label.trim() ? m.label.trim() : id;
    models.push({ id, label });
  }
  return { models };
}

// One raw entry → { profile } or { error }.
function parseProfile(raw) {
  if (!isPlainObject(raw)) return { error: 'must be an object' };
  const { id, kind } = raw;
  if (typeof id !== 'string' || !ID_RE.test(id)) return { error: 'invalid "id" (lowercase letters, digits, "-" and "_", 1-32 chars)' };
  if (id === DEFAULT_PROFILE_ID) return { error: `"${DEFAULT_PROFILE_ID}" is reserved for the implicit profile` };
  if (!PROFILE_KINDS.includes(kind)) return { error: `"kind" must be one of ${PROFILE_KINDS.join(', ')}` };
  if (raw.label !== undefined && typeof raw.label !== 'string') return { error: '"label" must be a string' };

  if (raw.env !== undefined && !isPlainObject(raw.env)) return { error: '"env" must be an object' };
  const env = {};
  for (const [name, v] of Object.entries(raw.env || {})) {
    if (!ENV_NAME_RE.test(name)) return { error: `invalid env variable name ${JSON.stringify(name)}` };
    const r = parseEnvValue(v);
    if (r.error) return { error: `env ${name}: ${r.error}` };
    env[name] = r.value;
  }
  // Without a base URL a `compatible` session would send a local model name to Anthropic.
  if (kind === 'compatible' && !env.ANTHROPIC_BASE_URL) return { error: 'a "compatible" profile needs env.ANTHROPIC_BASE_URL' };

  const m = parseModels(raw.models);
  if (m.error) return { error: m.error };
  return { profile: { id, label: (raw.label || '').trim() || id, kind, env, models: m.models } };
}

// The whole file's parsed JSON → { profiles, errors }. Pure. `default` always comes first.
export function parseProfiles(json) {
  const profiles = [defaultProfile()];
  const errors = [];
  if (!Array.isArray(json)) return { profiles, errors: ['profiles.json must be a JSON array'] };
  const seen = new Set([DEFAULT_PROFILE_ID]);
  json.forEach((raw, i) => {
    const r = parseProfile(raw);
    const where = `profile #${i + 1}${raw && typeof raw.id === 'string' ? ` (${raw.id})` : ''}`;
    if (r.error) return errors.push(`${where}: ${r.error}`);
    if (seen.has(r.profile.id)) return errors.push(`${where}: duplicate id`);
    seen.add(r.profile.id);
    profiles.push(r.profile);
  });
  return { profiles, errors };
}

// Reads the file on every call (a few hundred bytes, and an edit then shows up without a restart,
// as readClaudeDefaults does). Never throws.
export function loadProfiles(file = PROFILES_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { profiles: [defaultProfile()], errors: [] };
    return { profiles: [defaultProfile()], errors: [`cannot read profiles.json: ${(e && e.message) || e}`] };
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { profiles: [defaultProfile()], errors: [`profiles.json is not valid JSON: ${(e && e.message) || e}`] };
  }
  return parseProfiles(json);
}

// The only shape of a profile that leaves the server: no env, so no token and no reference to one.
export function publicProfile(p) {
  return { id: p.id, label: p.label, kind: p.kind, models: p.models, implicit: !!p.implicit };
}

export function profilesOverview(file = PROFILES_FILE) {
  const { profiles, errors } = loadProfiles(file);
  return { profiles: profiles.map(publicProfile), errors };
}

// A profile's env with every reference resolved, ready to be merged into a session's environment.
// Returns { env, errors } rather than throwing, so the caller can refuse a launch with a message
// that names the variable (never its value). An unset variable, an unreadable or empty file is an
// error: a session must not start with a token silently missing and fall back to another account.
// `env`, `readFile` and `home` are injectable for tests.
export function resolveProfileEnv(profile, { env = process.env, readFile = fs.readFileSync, home = os.homedir() } = {}) {
  const out = {};
  const errors = [];
  for (const [name, v] of Object.entries(profile.env || {})) {
    if (typeof v === 'string') { out[name] = v; continue; }
    if (v.fromEnv) {
      const val = env[v.fromEnv];
      if (val) out[name] = val; else errors.push(`${name}: $${v.fromEnv} is not set`);
      continue;
    }
    const file = v.file.startsWith('~/') ? path.join(home, v.file.slice(2)) : v.file;
    let text = '';
    try { text = String(readFile(file, 'utf8')).replace(/\r?\n$/, ''); } catch (_) { /* reported below */ }
    if (text) out[name] = text; else errors.push(`${name}: ${v.file} is missing or empty`);
  }
  return { env: out, errors };
}

export function findProfile(id, file = PROFILES_FILE) {
  return loadProfiles(file).profiles.find((p) => p.id === (id || DEFAULT_PROFILE_ID)) || null;
}

// Whether `model` may be launched or switched to under `profile`. An `anthropic` profile takes the
// CLI's own family names (`opus`, `claude-opus-4-7`…). A `compatible` one takes ids of its server,
// which are free-form (`qwen/qwen3-coder-30b`): when the profile lists models, only those; with no
// list, anything within the model-id charset (the anti-injection guard, as for the family names).
export function isValidModelForProfile(profile, model) {
  if (typeof model !== 'string') return false;
  if (profile.kind === 'anthropic') return isValidModelArg(model);
  if (!MODEL_ID_RE.test(model)) return false;
  return profile.models.length === 0 || profile.models.some((m) => m.id === model);
}

// Variables that decide which account or server a `claude` process talks to.
const CREDENTIAL_ENV_RE = /^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN$)/;

// The environment of a session: `base` (the login environment) with the profile's resolved env on
// top. For the implicit `default` profile that is `base` itself. For any other, the credential
// variables of `base` are dropped first, so only what the profile says reaches the CLI.
export function buildSessionEnv(base, profile, resolved) {
  if (profile.id === DEFAULT_PROFILE_ID) return base;
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!CREDENTIAL_ENV_RE.test(k)) out[k] = v;
  return Object.assign(out, resolved);
}

// resolveProfileEnv + buildSessionEnv in one step: { env } to hand to the SDK, or { error } with a
// message naming the profile and the variables at fault, to fail the launch with.
export function sessionEnvFor(profile, base) {
  const r = resolveProfileEnv(profile, { env: base });
  if (r.errors.length) return { error: `profile "${profile.id}": ${r.errors.join('; ')}` };
  return { env: buildSessionEnv(base, profile, r.env) };
}
