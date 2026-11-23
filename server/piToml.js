/*
 * A small TOML parser for pi's OLD MCP format (~/.pi/config.toml, ignored by pi >= 1.6,
 * which reads ~/.pi/agent/mcp.json + .pi/mcp.json):
 *
 *   [mcp]
 *   [[mcp.servers]]
 *   name = "hooked"
 *   command = "node"
 *   args = ["mcp/server.cjs"]
 *   env = { HOOKED_MCP_URL = "http://localhost:4123" }   # inline table, may span several lines
 *   url = "https://…" / type = "http" / headers = { … }
 *
 * It is NOT a general TOML parser: basic strings ("…" with the usual escapes), arrays of
 * strings, inline tables of strings, # comments. Everything else is ignored. Its only purpose is
 * to read these entries to migrate them to mcp.json, not generic parsing.
 */

// Skips spaces, newlines and "# …" comments (up to the \n).
function skipWs(s, i) {
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] === '#') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl + 1;
      continue;
    }
    return i;
  }
}

// Parses a TOML value at i: returns { value, next }, or null when it is not a value.
function parseValue(s, i) {
  i = skipWs(s, i);
  const c = s[i];
  if (c === '"' || c === "'") {
    const quote = c;
    let out = '';
    i++;
    while (i < s.length && s[i] !== quote) {
      if (quote === '"' && s[i] === '\\' && i + 1 < s.length) {
        const e = s[i + 1];
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        i += 2;
      } else {
        out += s[i];
        i++;
      }
    }
    return { value: out, next: i + 1 };
  }
  if (c === '[') {
    const arr = [];
    i++;
    for (;;) {
      i = skipWs(s, i);
      while (i < s.length && s[i] === ',') i = skipWs(s, i + 1);
      if (i >= s.length) return null;
      if (s[i] === ']') return { value: arr, next: i + 1 };
      const v = parseValue(s, i);
      if (!v) return null;
      arr.push(v.value);
      i = skipWs(s, v.next);
      if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
      if (s[i] === ']') return { value: arr, next: i + 1 };
      return null;
    }
  }
  if (c === '{') {
    const obj = {};
    i++;
    for (;;) {
      i = skipWs(s, i);
      while (i < s.length && s[i] === ',') i = skipWs(s, i + 1);
      if (i >= s.length) return null;
      if (s[i] === '}') return { value: obj, next: i + 1 };
      // key: bare or quoted
      let key = '';
      if (s[i] === '"' || s[i] === "'") {
        const q = s[i];
        i++;
        while (i < s.length && s[i] !== q) { key += s[i]; i++; }
        i++;
      } else {
        while (i < s.length && /[A-Za-z0-9_-]/.test(s[i])) { key += s[i]; i++; }
      }
      while (i < s.length && /\s/.test(s[i])) i++;
      if (s[i] !== '=') return null;
      i++;
      const v = parseValue(s, i);
      if (!v) return null;
      obj[key] = v.value;
      i = skipWs(s, v.next);
      if (s[i] === ',') { i = skipWs(s, i + 1); continue; }
      if (s[i] === '}') return { value: obj, next: i + 1 };
      return null;
    }
  }
  // bare: true / false / number, kept as strings except the useful booleans (enabled)
  let bare = '';
  while (i < s.length && !/[\s,\]\}\n#]/.test(s[i])) { bare += s[i]; i++; }
  if (bare === 'true') return { value: true, next: i };
  if (bare === 'false') return { value: false, next: i };
  if (bare === '') return null;
  return { value: bare, next: i };
}

// Extracts the [[mcp.servers]] of a config.toml → [{ name, command?, args?, env?, url?, type?, headers?, enabled? }]
export function parseMcpServersToml(text) {
  const servers = [];
  let cur = null;
  let i = 0;
  const s = String(text || '');
  while (i < s.length) {
    // start of a line (outside a comment)
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '#' || s[j] === '\n' || s[j] === '\r') { i = s.indexOf('\n', i); if (i < 0) break; i++; continue; }
    // header de table : [section] ou [[array-of-tables]]
    if (s[j] === '[') {
      const isArray = s[j + 1] === '[';
      const close = isArray ? s.indexOf(']]', j) : s.indexOf(']', j);
      if (close < 0) break;
      const hdr = s.slice(j + (isArray ? 2 : 1), close).trim();
      if (hdr === 'mcp.servers' && isArray) {
        cur = {};
        servers.push(cur);
      } else {
        cur = null; // any other section closes the current servers block
      }
      i = close + (isArray ? 2 : 1);
      continue;
    }
    // key = value (in the current block; ignored outside a block)
    let k = j;
    while (k < s.length && /[A-Za-z0-9_-]/.test(s[k])) k++;
    const key = s.slice(j, k);
    let m = k;
    while (m < s.length && /\s/.test(s[m])) m++;
    if (s[m] !== '=') { i = s.indexOf('\n', i); if (i < 0) break; i++; continue; }
    const v = parseValue(s, m + 1);
    if (!v) { i = s.indexOf('\n', i); if (i < 0) break; i++; continue; }
    if (cur && key) cur[key] = v.value;
    i = v.next;
  }
  // Keeps only the blocks with a name; normalises the types.
  return servers
    .filter((x) => typeof x.name === 'string' && x.name)
    .map((x) => ({
      name: x.name,
      command: typeof x.command === 'string' ? x.command : undefined,
      args: Array.isArray(x.args) ? x.args.map(String) : undefined,
      env: x.env && typeof x.env === 'object' ? Object.fromEntries(Object.entries(x.env).map(([k, v]) => [k, String(v)])) : undefined,
      url: typeof x.url === 'string' ? x.url : undefined,
      type: typeof x.type === 'string' ? x.type : undefined,
      headers: x.headers && typeof x.headers === 'object' ? Object.fromEntries(Object.entries(x.headers).map(([k, v]) => [k, String(v)])) : undefined,
      enabled: x.enabled === false ? false : undefined,
    }));
}
