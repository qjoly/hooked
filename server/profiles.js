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
 *       "models": ["qwen/qwen3-coder-30b", { "id": "qwen/qwen3.8-27b", "label": "Qwen 27B" }],
 *       "contextWindow": 65536              // "compatible" only: the context the server loads models at
 *     }
 *   ]
 *
 * An env value is a literal string, or a reference resolved when a session starts, so that a token
 * never has to sit in this file: `{ "fromEnv": NAME }` reads the login environment the sessions run in (so a variable
 * exported in your shell profile works),
 * `{ "file": PATH }` reads a file (absolute, or `~/…`; one trailing newline is dropped).
 *
 * `configDir` (an "anthropic" profile only) gives the profile its own Claude account: the session's
 * CLAUDE_CONFIG_DIR. The CLI keeps the login there, so each profile signs in separately and shows
 * its own identity. On macOS the login goes to a Keychain item named after a hash of that path
 * (`Claude Code-credentials-<first 8 hex of sha256(path)>`): the path is stored normalized, absolute
 * and without a trailing slash, and must never change, or the account would look signed out.
 * Two profiles cannot share a dir, and none can use the default account's own.
 *
 * `contextWindow` tells the CLI how big the server's context really is. It assumes 200k for any
 * model it does not know, so it would never compact before the server refuses the request. It is
 * handed over as CLAUDE_CODE_MAX_CONTEXT_TOKENS (unless the profile's env sets that itself).
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
import { ENV_NAME_RE, isPlainObject, parseSecretValue, resolveSecretMap } from './secretValues.js';
import { parseMcpServerMap } from './mcpServers.js';

export const DEFAULT_PROFILE_ID = 'default';
export const PROFILE_KINDS = ['anthropic', 'compatible'];

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
// Model ids are interpolated into the CLI's `--model` / the SDK's `setModel`, and LM Studio's carry
// a publisher prefix (`qwen/qwen3-coder-30b`): a strict charset, but one that allows `/` and `.`.
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+/-]{0,127}$/;

export const isValidModelId = (m) => typeof m === 'string' && MODEL_ID_RE.test(m);

// Where the default account keeps its state: CLAUDE_CONFIG_DIR when the environment sets one, else
// ~/.claude. Account dirs share parts of it (cf. server/accountDir.js).
export function mainConfigDir(env = process.env, home = os.homedir()) {
  return normalizeConfigDir(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), home);
}

// A config dir as a stable string: `~/` expanded, absolute, normalized, no trailing separator. null
// when it cannot be made absolute. Symlinks are NOT resolved: the CLI hashes the path it is given.
export function normalizeConfigDir(dir, home = os.homedir()) {
  if (typeof dir !== 'string' || !dir) return null;
  const expanded = dir.startsWith('~/') ? path.join(home, dir.slice(2)) : dir;
  if (!path.isAbsolute(expanded)) return null;
  const n = path.normalize(expanded);
  return n.length > 1 ? n.replace(/[\\/]+$/, '') : n;
}

export function defaultProfile() {
  return { id: DEFAULT_PROFILE_ID, label: 'Default', kind: 'anthropic', env: {}, models: [], implicit: true };
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
function parseProfile(raw, { home, mainDir }) {
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
    const r = parseSecretValue(v);
    if (r.error) return { error: `env ${name}: ${r.error}` };
    env[name] = r.value;
  }
  // Without a base URL a `compatible` session would send a local model name to Anthropic.
  if (kind === 'compatible' && !env.ANTHROPIC_BASE_URL) return { error: 'a "compatible" profile needs env.ANTHROPIC_BASE_URL' };

  const m = parseModels(raw.models);
  if (m.error) return { error: m.error };

  let contextWindow;
  if (raw.contextWindow !== undefined) {
    if (kind !== 'compatible') return { error: '"contextWindow" only applies to a "compatible" profile' };
    if (!Number.isInteger(raw.contextWindow) || raw.contextWindow < 2048 || raw.contextWindow > 10_000_000) {
      return { error: '"contextWindow" must be an integer between 2048 and 10000000' };
    }
    contextWindow = raw.contextWindow;
  }
  let configDir;
  if (raw.configDir !== undefined) {
    if (kind !== 'anthropic') return { error: '"configDir" only applies to an "anthropic" profile' };
    configDir = normalizeConfigDir(raw.configDir, home);
    if (!configDir) return { error: '"configDir" must be an absolute path or start with ~/' };
    if (configDir === '/' || configDir === home) return { error: '"configDir" cannot be the root or the home directory' };
    if (configDir === mainDir) return { error: '"configDir" is the default account\'s own directory' };
  }
  // MCP servers dedicated to this profile, and whether it also gets the common ones (cf.
  // server/mcpServers.js). Strict like the rest of the entry: a bad server skips the profile.
  let mcpServers;
  if (raw.mcpServers !== undefined) {
    const r = parseMcpServerMap(raw.mcpServers);
    if (r.errors.length) return { error: `mcpServers: ${r.errors.join('; ')}` };
    if (Object.keys(r.servers).length) mcpServers = r.servers;
  }
  if (raw.commonMcp !== undefined && typeof raw.commonMcp !== 'boolean') return { error: '"commonMcp" must be true or false' };
  const profile = { id, label: (raw.label || '').trim() || id, kind, env, models: m.models };
  if (contextWindow) profile.contextWindow = contextWindow;
  if (configDir) profile.configDir = configDir;
  if (mcpServers) profile.mcpServers = mcpServers;
  if (raw.commonMcp === false) profile.commonMcp = false;
  return { profile };
}

// The whole file's parsed JSON → { profiles, errors }. Pure. `default` always comes first.
// `home` and `mainDir` are injectable for the tests (they decide what `~/` and "the default account's
// directory" mean).
export function parseProfiles(json, { home = os.homedir(), mainDir = mainConfigDir(process.env, home) } = {}) {
  const profiles = [defaultProfile()];
  const errors = [];
  if (!Array.isArray(json)) return { profiles, errors: ['profiles.json must be a JSON array'] };
  const seen = new Set([DEFAULT_PROFILE_ID]);
  const dirs = new Map();
  json.forEach((raw, i) => {
    const r = parseProfile(raw, { home, mainDir });
    const where = `profile #${i + 1}${raw && typeof raw.id === 'string' ? ` (${raw.id})` : ''}`;
    if (r.error) return errors.push(`${where}: ${r.error}`);
    if (seen.has(r.profile.id)) return errors.push(`${where}: duplicate id`);
    if (r.profile.configDir && dirs.has(r.profile.configDir)) {
      return errors.push(`${where}: "configDir" is already used by profile "${dirs.get(r.profile.configDir)}"`);
    }
    if (r.profile.configDir) dirs.set(r.profile.configDir, r.profile.id);
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
  // `hasAccount`: it has a Claude account of its own (a configDir), which can be signed in and out.
  return { id: p.id, label: p.label, kind: p.kind, models: p.models, implicit: !!p.implicit, hasAccount: !!p.configDir };
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
export function resolveProfileEnv(profile, opts = {}) {
  const { values, errors } = resolveSecretMap(profile.env, opts);
  return { env: values, errors };
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
// What the CLI reads as the size of the model's context window.
const CONTEXT_WINDOW_ENV = 'CLAUDE_CODE_MAX_CONTEXT_TOKENS';
// Where the CLI keeps its state and login.
const CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';

// The environment of a session: `base` (the login environment) with the profile's resolved env on
// top. For the implicit `default` profile that is `base` itself. For any other, the credential
// variables of `base` are dropped first, so only what the profile says reaches the CLI.
export function buildSessionEnv(base, profile, resolved) {
  if (profile.id === DEFAULT_PROFILE_ID) return base;
  const out = {};
  for (const [k, v] of Object.entries(base)) if (!CREDENTIAL_ENV_RE.test(k)) out[k] = v;
  Object.assign(out, resolved);
  if (profile.contextWindow && !Object.hasOwn(resolved, CONTEXT_WINDOW_ENV)) out[CONTEXT_WINDOW_ENV] = String(profile.contextWindow);
  if (profile.configDir && !Object.hasOwn(resolved, CONFIG_DIR_ENV)) out[CONFIG_DIR_ENV] = profile.configDir;
  return out;
}

// resolveProfileEnv + buildSessionEnv in one step: { env } to hand to the SDK, or { error } with a
// message naming the profile and the variables at fault, to fail the launch with.
export function sessionEnvFor(profile, base) {
  const r = resolveProfileEnv(profile, { env: base });
  if (r.errors.length) return { error: `profile "${profile.id}": ${r.errors.join('; ')}` };
  return { env: buildSessionEnv(base, profile, r.env) };
}

// The model a fork has to be launched with. The CLI restores a resumed session's model from its
// transcript, which is why hooked never passes one on resume. A fork cut at the very first message
// has no assistant message to restore it from, and the CLI then falls back to its own default
// (`opus`): harmless on Anthropic, wrong on a compatible server, which expects its own model ids.
// So a compatible profile hands the original's model on, when it is still one the profile allows.
export function modelToKeepOnFork(profile, sessionModel) {
  if (!profile || profile.kind !== 'compatible') return undefined;
  return isValidModelForProfile(profile, sessionModel) ? sessionModel : undefined;
}

// What a session list entry carries about its profile: null for the default profile (and for a
// session that predates profiles), so the UI shows nothing for the usual case. A profile that has
// been removed from the file is still named, flagged `missing`, because the session did run on it.
export function profileInfo(profileId, profiles) {
  if (!profileId || profileId === DEFAULT_PROFILE_ID) return null;
  const p = profiles.find((x) => x.id === profileId);
  return p ? { id: p.id, label: p.label, kind: p.kind } : { id: profileId, label: profileId, kind: null, missing: true };
}
