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

/**
 * Adds an `anthropic` profile with its own account to profiles.json, its directory under
 * `accountsRoot`. Returns { profile } (the public shape) or { error }; never throws.
 * `file` and `accountsRoot` are injectable for the tests.
 */
export function addAccountProfile(label, { file = PROFILES_FILE, accountsRoot = path.join(HOOKED_DIR, 'accounts') } = {}) {
  const name = typeof label === 'string' ? label.trim() : '';
  if (!name) return { error: 'a name is required' };
  if (name.length > MAX_LABEL) return { error: `the name is too long (${MAX_LABEL} characters at most)` };

  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { error: `profiles.json cannot be read, it was left as it is: ${(e && e.message) || e}` };
  }
  if (!Array.isArray(raw)) return { error: 'profiles.json is not a JSON array, it was left as it is' };

  const id = uniqueProfileId(name, raw.map((p) => p && p.id).filter((x) => typeof x === 'string'));
  const entry = { id, label: name, kind: 'anthropic', configDir: normalizeConfigDir(path.join(accountsRoot, id)) };
  // The new entry has to be acceptable on top of the file as it is (a configDir another profile
  // already uses, the default account's own…): check before writing, not after.
  const parsed = parseProfiles([...raw, entry]);
  const added = parsed.profiles.find((p) => p.id === id);
  if (!added) return { error: parsed.errors.find((e) => e.includes(`(${id})`)) || 'the new account was refused' };

  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify([...raw, entry], null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { error: `profiles.json could not be written: ${(e && e.message) || e}` };
  }
  return { profile: publicProfile(added) };
}
