/*
 * Values that may be a secret, in the files hooked reads (profiles.json, mcp-common.json): a literal
 * string, or a reference resolved only when it is needed, so that a token never has to sit in the
 * file.
 *
 *   "value"                    a literal (an empty one is allowed: it blanks a variable)
 *   { "fromEnv": "NAME" }      a variable of the login environment
 *   { "file": "/path" }        a file, absolute or `~/…`; one trailing newline is dropped
 *
 * `parseSecretValue` checks one at read time; `resolveSecretMap` turns a whole map of them into
 * strings at the moment they are used. Resolving never throws: it returns the errors, naming each
 * variable (never its value), so the caller can refuse a launch with a message. An unset variable,
 * an unreadable or empty file is an error, never an empty string: a session must not start with a
 * token silently missing.
 *
 * Node stdlib only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// One value → { value } (normalized: a string, or a `{ fromEnv }` / `{ file }` reference) or { error }.
export function parseSecretValue(v) {
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

// A map of parsed values → { values, errors }. `env`, `readFile` and `home` are injectable for tests.
export function resolveSecretMap(map, { env = process.env, readFile = fs.readFileSync, home = os.homedir() } = {}) {
  const values = {};
  const errors = [];
  for (const [name, v] of Object.entries(map || {})) {
    if (typeof v === 'string') { values[name] = v; continue; }
    if (v.fromEnv) {
      const val = env[v.fromEnv];
      if (val) values[name] = val; else errors.push(`${name}: $${v.fromEnv} is not set`);
      continue;
    }
    const file = v.file.startsWith('~/') ? path.join(home, v.file.slice(2)) : v.file;
    let text = '';
    try { text = String(readFile(file, 'utf8')).replace(/\r?\n$/, ''); } catch (_) { /* reported below */ }
    if (text) values[name] = text; else errors.push(`${name}: ${v.file} is missing or empty`);
  }
  return { values, errors };
}
