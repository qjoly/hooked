/*
 * A client for the incident.io desktop binary, which only speaks MCP over stdio (`incident mcp`).
 * The Node twin of the desktop app's desktop/src/incmcp.rs.
 *
 * One child process serves every call, one call at a time. A write is never sent twice: a call
 * that failed half-way is reported, not retried. A dead process is replaced before a request goes
 * out, never after.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const TIMEOUT_MS = 45_000;
const LOST = 'incident.io connection lost';

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };

// Where the incident.io desktop app installs its binary. HOOKED_INCIDENT_BIN overrides it (a fake
// server for tests), and set to an empty string it turns the integration off.
export function findIncidentBin(env = process.env) {
  if (env.HOOKED_INCIDENT_BIN !== undefined) return env.HOOKED_INCIDENT_BIN && isFile(env.HOOKED_INCIDENT_BIN) ? env.HOOKED_INCIDENT_BIN : null;
  return [
    path.join(os.homedir(), '.incidentio', 'incident'),
    '/Applications/incident.io.app/Contents/Resources/incident.app/Contents/MacOS/incident',
  ].find(isFile) || null;
}

// `{"type":…,"errors":[{"message":…}]}` as its messages, anything else as is.
function errorText(text) {
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) { /* plain text */ }
  const messages = Array.isArray(parsed?.errors) ? parsed.errors.map((e) => e && e.message).filter(Boolean) : [];
  if (messages.length) return messages.join('; ');
  return String(text || '').trim() || 'the incident.io tool failed';
}

// The payload of a `tools/call` result. On `isError` the structured content is an empty
// placeholder, so the text is what counts there.
export function toolResult(r) {
  const text = (Array.isArray(r?.content) ? r.content : []).map((c) => c && c.text).filter((t) => typeof t === 'string').join('\n');
  if (r?.isError === true) throw new Error(errorText(text));
  if (r?.structuredContent != null) return r.structuredContent;
  try { return JSON.parse(text); } catch (_) { return text; }
}

export class IncidentClient {
  constructor(bin) {
    this.bin = bin;
    this.conn = null;
    this.queue = Promise.resolve();
  }

  // One JSON-RPC request, after the ones already queued.
  call(method, params = {}) {
    const run = this.queue.then(() => this.#request(method, params));
    this.queue = run.catch(() => {});
    return run;
  }

  async tool(name, args = {}) {
    return toolResult(await this.call('tools/call', { name, arguments: args }));
  }

  async tools() {
    const out = [];
    let cursor = null;
    for (;;) {
      const page = await this.call('tools/list', cursor ? { cursor } : {});
      for (const t of page?.tools || []) if (t && t.name) out.push(t.name);
      if (!page?.nextCursor) return out;
      cursor = page.nextCursor;
    }
  }

  async resource(uri) {
    const r = await this.call('resources/read', { uri });
    const text = r?.contents?.[0]?.text;
    if (typeof text !== 'string') throw new Error(`${uri}: no text`);
    return text;
  }

  close() {
    const c = this.conn;
    this.conn = null;
    if (c) { c.dead = true; try { c.child.kill(); } catch (_) { /* gone */ } }
  }

  async #connection() {
    if (this.conn && !this.conn.dead) return this.conn;
    const child = spawn(this.bin, ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const conn = { child, nextId: 1, pending: new Map(), dead: false };
    const die = (why) => {
      conn.dead = true;
      for (const p of conn.pending.values()) p.reject(new Error(`${LOST}: ${why}`));
      conn.pending.clear();
    };
    child.on('error', (e) => die(`${this.bin}: ${e.message}`));
    child.on('exit', () => die('the incident.io process exited'));
    child.stdin.on('error', () => die('its input closed'));
    // Notifications and log lines share the stream with the answers.
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch (_) { return; }
      const p = msg && conn.pending.get(msg.id);
      if (!p) return;
      conn.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'request failed'));
      else p.resolve(msg.result);
    });
    this.conn = conn;
    await this.#send(conn, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'hooked', version: '2.0.0' },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return conn;
  }

  async #request(method, params) {
    const conn = await this.#connection();
    return this.#send(conn, method, params);
  }

  #send(conn, method, params) {
    if (conn.dead) return Promise.reject(new Error(`${LOST}: the incident.io process exited`));
    const id = conn.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        // An unanswered process is not trusted with the next request.
        if (this.conn === conn) this.close();
        reject(new Error(`${LOST}: no answer to ${method}`));
      }, TIMEOUT_MS);
      timer.unref?.();
      conn.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      conn.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
}
