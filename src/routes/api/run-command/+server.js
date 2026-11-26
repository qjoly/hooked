import { agentAlive, deliverReply } from '#lib/server/core.js';
import { fail, readJson } from '#lib/server/respond.js';

// Run on a shell block Claude proposed. Same path as a `!command` sent through /api/reply with
// `respond`, except that the output streams back while the command runs, so the block can show a
// live log. The body is NDJSON: `{ output }` lines, then one `{ done: true, ok, ... }` line carrying
// what /api/reply would have answered.
//
// Output is batched every FLUSH_MS and only the tail of a batch is kept: a command that floods
// (`yes`, a verbose build) must not pile megabytes into the response faster than the page reads it.
// What Claude receives is unaffected; it comes from the capture in runLocalCommand.
const FLUSH_MS = 100;
const MAX_BATCH_CHARS = 16000;

export async function POST({ request }) {
  const body = await readJson(request);
  if (!body) return fail(400, 'invalid request');
  const id = body.id;
  const command = typeof body.command === 'string' ? body.command.trim() : '';
  if (!id) return fail(400, 'id required');
  if (!command) return fail(400, 'command required');
  if (!agentAlive(id)) return fail(409, 'this session is not driven by hooked (ended, or started outside hooked)');

  const enc = new TextEncoder();
  let closed = false;   // the page went away: the command keeps running, its output still reaches Claude
  let batch = '';
  let timer = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (obj) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(JSON.stringify(obj) + '\n')); } catch (_) { closed = true; }
      };
      const flush = () => {
        timer = null;
        if (batch) send({ output: batch });
        batch = '';
      };
      const onOutput = (text) => {
        if (closed) return;
        batch = (batch + text).slice(-MAX_BATCH_CHARS);
        timer ||= setTimeout(flush, FLUSH_MS);
      };
      deliverReply(id, '!' + command, (err, info) => {
        clearTimeout(timer);
        flush();
        send(err ? { done: true, ok: false, error: err.message || String(err) } : { done: true, ok: true, ...info });
        if (!closed) { closed = true; controller.close(); }
      }, { respond: true, onOutput });
    },
    cancel() {
      closed = true;
      clearTimeout(timer);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',   // a buffering proxy would hold the log until the end
    },
  });
}
