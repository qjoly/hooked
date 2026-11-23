/*
 * The `WebFetch` tool of hooked's pi package, with Claude Code's schema (`url`, `prompt`).
 *
 * pi has no web tool, and pi-claude-bridge runs Claude Code with none of its own, so a bridged
 * Claude session could only reach the web through `curl` in bash. This fetches one page and
 * returns it as readable text. Unlike Claude Code's, it does not run a small model on the page:
 * the text goes back to the model as is, truncated past MAX_CHARS. It is not a safe tool: in the
 * normal mode the permission gate asks first, as Claude Code does.
 */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_CHARS = 60_000;
const TIMEOUT_MS = 30_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// HTML → readable text: no scripts, styles or markup; blocks on their own lines, links kept.
export function htmlToText(html) {
  let s = String(html || '');
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(s) || [])[1];
  s = s.replace(/<(script|style|noscript|svg|template|head|title)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, text) => {
      const t = text.replace(/<[^>]+>/g, '').trim();
      return t && !/^(javascript|mailto):/i.test(href) ? `${t} (${href})` : t;
    })
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n# ')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|nav|aside|ul|ol|table|tr|pre|blockquote|h[1-6]|dl|dt|dd|figure)\b[^>]*>/gi, '\n')
    .replace(/<(td|th)\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const t = title ? decodeEntities(title.replace(/\s+/g, ' ').trim()) : '';
  return t && !s.startsWith(t) ? `${t}\n\n${s}` : s;
}

export async function fetchPage(url, { signal } = {}) {
  let u;
  try { u = new URL(String(url)); } catch (_) { throw new Error(`not a URL: ${url}`); }
  if (u.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/.test(u.host)) u.protocol = 'https:';
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error(`unsupported protocol: ${u.protocol}`);
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetch(u, {
    redirect: 'follow',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'user-agent': 'Mozilla/5.0 (hooked pi package WebFetch)', accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5' },
  });
  const type = res.headers.get('content-type') || '';
  const reader = res.body ? res.body.getReader() : null;
  const chunks = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) { try { await reader.cancel(); } catch (_) {} break; }
      chunks.push(value);
    }
  }
  const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  if (!/^(text\/|application\/(json|xml|xhtml|javascript|x-yaml|yaml))/i.test(type) && type && !/html/i.test(type)) {
    return { url: res.url || u.href, status: res.status, type, text: `(${type} content, ${size} bytes, not shown)` };
  }
  const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body.trim();
  return { url: res.url || u.href, status: res.status, type, text };
}

export function registerWebFetch(pi) {
  pi.registerTool({
    name: 'WebFetch',
    label: 'Fetch a web page',
    description: 'Fetch a URL and return its content as readable text (HTML is converted, long pages are truncated). http URLs are upgraded to https. Use `prompt` to say what you are looking for in the page.',
    promptSnippet: 'Fetch a web page as text',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to fetch' },
        prompt: { type: 'string', description: 'What to look for in the page' },
      },
      required: ['url'],
    },
    async execute(_id, params, signal) {
      try {
        const r = await fetchPage(params.url, { signal });
        const cut = r.text.length > MAX_CHARS;
        const head = `${r.url} (HTTP ${r.status}${r.type ? `, ${r.type.split(';')[0]}` : ''})${params.prompt ? `\nLooking for: ${params.prompt}` : ''}`;
        const body = cut ? `${r.text.slice(0, MAX_CHARS)}\n\n[truncated: ${r.text.length - MAX_CHARS} more characters]` : r.text;
        return { content: [{ type: 'text', text: `${head}\n\n${body}` }], details: { url: r.url, status: r.status, chars: r.text.length, truncated: cut }, ...(r.status >= 400 ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: 'text', text: `WebFetch failed: ${(e && e.message) || e}` }], details: undefined, isError: true };
      }
    },
  });
}
