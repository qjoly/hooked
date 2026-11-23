/*
 * pi's model catalog (`pi --list-models`), parsed and cached per pi profile.
 *
 * The catalog is the source of truth for what a pi-based provider can run: model ids, the
 * provider each belongs to, context window, thinking support. It replaces the Mistral-only
 * tables the pi integration started with (context windows by model family, `--list-models
 * mistral`, `mistral/` prefixes): any provider pi is signed in to shows up on its own.
 *
 * Output format (pi 1.6):
 *   provider  model                     context  max-out  thinking  images
 *   mistral   devstral-medium-latest    262.1K   262.1K   no        no
 */
import { spawn } from 'node:child_process';

const TTL_MS = 5 * 60_000;
const cache = new Map(); // key -> { at, models, promise }

// "262.1K" / "1.0M" / "8192" → tokens (null when unreadable).
function parseTokens(v) {
  const m = String(v || '').trim().match(/^([\d.]+)\s*([KkMm]?)$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const mult = /k/i.test(m[2]) ? 1000 : (/m/i.test(m[2]) ? 1_000_000 : 1);
  return Math.round(n * mult);
}

// Text of `pi --list-models` → [{ provider, id, ref, contextWindow, maxOutput, thinking, images }].
function parseCatalog(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    // No column holds a space (ids, sizes, yes/no): any run of whitespace separates them, however
    // wide pi pads a column.
    const cols = line.trim().split(/\s+/);
    // A model row has the six columns, a token count and yes/no flags: anything else (header,
    // warnings, a "No models matching" line) is skipped.
    if (cols.length < 6 || parseTokens(cols[2]) == null || !/^(yes|no)$/i.test(cols[4])) continue;
    const [provider, id] = cols;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider) || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/.test(id)) continue;
    out.push({
      provider,
      id,
      ref: `${provider}/${id}`,
      contextWindow: parseTokens(cols[2]),
      maxOutput: parseTokens(cols[3]),
      thinking: /^yes$/i.test(String(cols[4] || '').trim()),
      images: /^yes$/i.test(String(cols[5] || '').trim()),
    });
  }
  return out;
}

function runListModels(bin, env, extraArgs = []) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, ['--list-models', ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { return resolve(''); }
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, 20_000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// Catalog of one pi profile. `key` identifies the profile (binary + agent dir) so two pi-based
// providers with different agent dirs keep separate catalogs. Async, cached TTL_MS.
function piCatalog(key, bin, env, extraArgs = []) {
  const c = cache.get(key);
  if (c && c.models && Date.now() - c.at < TTL_MS) return Promise.resolve(c.models);
  if (c && c.promise) return c.promise;
  const promise = runListModels(bin, env, extraArgs).then((text) => {
    const models = parseCatalog(text);
    cache.set(key, { at: Date.now(), models, promise: null });
    return models;
  });
  cache.set(key, { ...(c || {}), promise });
  return promise;
}

// Last known catalog of a profile, synchronously (null before the first listing). The scan uses
// it for context windows without ever spawning pi.
function cachedPiCatalog(key) {
  const c = cache.get(key);
  return c && c.models ? c.models : null;
}

// Every cached model, across profiles (context-window lookups by ref).
function anyCachedModel(ref) {
  if (!ref) return null;
  const bare = ref.includes('/') ? ref.slice(ref.indexOf('/') + 1) : ref;
  for (const c of cache.values()) {
    for (const m of c.models || []) if (m.ref === ref || (!ref.includes('/') && m.id === bare)) return m;
  }
  return null;
}

function clearPiCatalog() { cache.clear(); }

export { parseCatalog, parseTokens, piCatalog, cachedPiCatalog, anyCachedModel, clearPiCatalog };
