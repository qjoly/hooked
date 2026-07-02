import { execFile } from 'node:child_process';
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();
const GH_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/(pull|issues)\/\d+/;
function run(args) {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: 6000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}
async function ghView(url) {
  const m = GH_URL.exec(String(url || ''));
  if (!m) return null;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  const kind = m[1] === 'pull' ? 'pr' : 'issue';
  const d = await run([kind, 'view', url, '--json', 'title,body,state,author,number']);
  const out = d ? { kind, number: d.number, title: d.title, state: d.state, author: d.author?.login || '', body: (d.body || '').slice(0, 4000) } : null;
  cache.set(url, { at: Date.now(), data: out });
  return out;
}
export { ghView };
