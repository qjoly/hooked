/*
 * Writing to profiles.json. Everything else about profiles only reads it; this is the one place
 * that adds to it, for the "Add account" button.
 *
 * It edits the user's file, so it is careful with it: the raw entries are read back as they are and
 * the new one is appended (never the parsed ones written out, which would drop what the parser
 * does not know), a file that is not a JSON array is refused rather than overwritten, and the write
 * is atomic (tmp + rename) so a crash cannot leave half a file.
 *
 * Node stdlib only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR, PROFILES_FILE } from './config.js';
import { DEFAULT_PROFILE_ID, normalizeConfigDir, parseProfiles, publicProfile } from './profiles.js';

const MAX_LABEL = 60;
const MAX_ID = 32;

// "Perso (Outlook)" -> "perso-outlook": lowercase letters and digits, single dashes, at most
// `room` characters, never empty. Pure.
export function slugify(label, room = MAX_ID) {
  const s = String(label || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, room).replace(/-+$/g, '');
  return s || 'account';
}

// A profile id from a label that is free among `taken` (and is not the reserved one): the slug,
// else the slug with -2, -3… Stays within the id length limit. Pure.
export function uniqueProfileId(label, taken) {
  const used = new Set([...taken, DEFAULT_PROFILE_ID]);
  const base = slugify(label);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = '-' + n;
    const id = slugify(label, MAX_ID - suffix.length) + suffix;
    if (!used.has(id)) return id;
  }
}

// Reads profiles.json as the raw array it is, for appending to. { raw } or { error }: a missing file
// is an empty list, anything else that is not a JSON array is refused and left as it is.
function readRaw(file) {
  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { error: `profiles.json cannot be read, it was left as it is: ${(e && e.message) || e}` };
  }
  if (!Array.isArray(raw)) return { error: 'profiles.json is not a JSON array, it was left as it is' };
  return { raw };
}

// Appends `entry` (id already chosen) to the file as it is. The entry has to be acceptable on top of
// the existing ones (a configDir another profile already uses, a missing base URL…): that is checked
// before anything is written, not after. Atomic (tmp + rename), and created private (0600): a profile
// may carry a token in its env, and the other files of the data dir that hold secrets are private
// too. → { profile } (the public shape) or { error }.
function appendEntry(raw, entry, file, what) {
  const parsed = parseProfiles([...raw, entry]);
  const added = parsed.profiles.find((p) => p.id === entry.id);
  if (!added) return { error: parsed.errors.find((e) => e.includes(`(${entry.id})`)) || `the new ${what} was refused` };
  const w = writeRaw(file, [...raw, entry]);
  return w.error ? w : { profile: publicProfile(added) };
}

// Atomic (tmp + rename) and private. → {} or { error }.
function writeRaw(file, entries) {
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); // the mode above only counts when the file is created
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { error: `profiles.json could not be written: ${(e && e.message) || e}` };
  }
  return {};
}

/**
 * Takes a profile's entry out of profiles.json. The other entries are written back exactly as they
 * were, whatever the parser makes of them, and the file is refused rather than rewritten when it is
 * not a JSON array. Nothing outside the file is touched: a profile's directory stays on disk.
 * → { removed: true } or { error }; never throws.
 */
export function removeProfileEntry(id, { file = PROFILES_FILE } = {}) {
  if (typeof id !== 'string' || !id || id === DEFAULT_PROFILE_ID) return { error: 'unknown profile' };
  const r = readRaw(file);
  if (r.error) return r;
  const rest = r.raw.filter((p) => !(p && p.id === id));
  if (rest.length === r.raw.length) return { error: 'unknown profile' };
  const w = writeRaw(file, rest);
  return w.error ? w : { removed: true };
}

function checkName(label) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name) return { error: 'a name is required' };
  if (name.length > MAX_LABEL) return { error: `the name is too long (${MAX_LABEL} characters at most)` };
  return { name };
}

/**
 * Adds an `anthropic` profile with its own account to profiles.json, its directory under
 * `accountsRoot`. Returns { profile } (the public shape) or { error }; never throws.
 * `file` and `accountsRoot` are injectable for the tests.
 */
export function addAccountProfile(label, { file = PROFILES_FILE, accountsRoot = path.join(HOOKED_DIR, 'accounts') } = {}) {
  const n = checkName(label);
  if (n.error) return n;
  const r = readRaw(file);
  if (r.error) return r;
  const id = uniqueProfileId(n.name, r.raw.map((p) => p && p.id).filter((x) => typeof x === 'string'));
  const entry = { id, label: n.name, kind: 'anthropic', configDir: normalizeConfigDir(path.join(accountsRoot, id)) };
  return appendEntry(r.raw, entry, file, 'account');
}

// What a user pastes for a server's address, as the base URL the CLI wants: http(s) only, no
// credentials, query or fragment, no trailing slash, and without the `/v1` an OpenAI-style URL ends
// with (the CLI adds its own path, and hooked asks `<base>/v1/models`). An address typed without a
// scheme (`mew:1234`, `192.168.1.5:1234`) is taken as http://, which is what a local server is: left
// to `new URL`, `mew:1234` reads as the scheme "mew:" and fails with a message about something else.
// → { url } or { error } where the error says what is wrong with what was typed.
export function parseServerUrl(input) {
  const typed = String(input == null ? '' : input).trim();
  if (!typed) return { error: 'Enter the server\'s address, e.g. http://127.0.0.1:1234' };
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(typed);
  let u;
  try { u = new URL(hasScheme ? typed : 'http://' + typed); } catch (_) {
    return { error: `“${typed}” does not look like an address. Example: http://127.0.0.1:1234` };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'Only http:// and https:// addresses are supported.' };
  if (!u.hostname) return { error: `“${typed}” has no host name. Example: http://127.0.0.1:1234` };
  if (u.username || u.password) return { error: 'Remove the user name and password from the address: the token goes in the Token field.' };
  const pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return { url: u.origin + pathname };
}

// The same, for the callers that only need the URL: null when it is not usable.
export function normalizeServerUrl(input) {
  return parseServerUrl(input).url || null;
}

const DEFAULT_SERVER_TOKEN = 'lmstudio'; // LM Studio asks for none; the CLI wants something

/**
 * Adds a `compatible` profile for an Anthropic-compatible server (LM Studio…) to profiles.json.
 * `opts`: { url, token?, contextWindow?, models? (ids) }. The token is stored in the file, which is
 * private; leave it out for a server that has no authentication.
 * Returns { profile } or { error }; never throws.
 */
export function addServerProfile(label, opts = {}, { file = PROFILES_FILE } = {}) {
  const n = checkName(label);
  if (n.error) return n;
  const addr = parseServerUrl(opts.url);
  if (addr.error) return { error: addr.error };
  const base = addr.url;
  const token = typeof opts.token === 'string' && opts.token.trim() ? opts.token.trim() : DEFAULT_SERVER_TOKEN;
  const r = readRaw(file);
  if (r.error) return r;
  const id = uniqueProfileId(n.name, r.raw.map((p) => p && p.id).filter((x) => typeof x === 'string'));
  const entry = {
    id, label: n.name, kind: 'compatible',
    env: { ANTHROPIC_BASE_URL: base, ANTHROPIC_AUTH_TOKEN: token, ANTHROPIC_API_KEY: '' },
  };
  if (Array.isArray(opts.models) && opts.models.length) entry.models = opts.models;
  if (opts.contextWindow !== undefined && opts.contextWindow !== null && opts.contextWindow !== '') entry.contextWindow = Number(opts.contextWindow);
  return appendEntry(r.raw, entry, file, 'server');
}
