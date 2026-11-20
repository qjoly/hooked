// Server half of the incremental session detail (see src/lib/detailDelta.js).
//
// A full detail of a long session weighs several MB (messages, plus the file-change list and the
// workflow runs), and the dashboard refetched all of it on every live tick. With `delta=1` the
// client says which prefix of `messages` it holds (`since` + a signature of that prefix) and which
// heavy lists it holds (`have`, content hashes); we answer with the tail and "unchanged".
//
// The signature is the safety net: tool results and agent reports are patched into EARLIER bubbles
// when they land, so a plain "messages after index N" would silently show stale chips. Hashing the
// prefix makes any such edit fall back to a full resend instead.
import crypto from 'node:crypto';
import { HEAVY_FIELDS } from '../src/lib/detailDelta.js';

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 20);

// `d`: the full detail. `opts`: { since, sig, have } parsed from the query (all optional).
// Mutates and returns `d`.
export function trimDetail(d, opts = {}) {
  const messages = Array.isArray(d.messages) ? d.messages : [];
  const total = messages.length;
  // The last bubble is the one still being written, so it is never part of the stable prefix.
  const stable = Math.max(0, total - 1);
  const since = Number.isInteger(opts.since) ? opts.since : 0;

  // One pass: signature of the first `since` messages (to validate the client's copy) and of the
  // first `stable` ones (to hand back for the next request).
  const h = crypto.createHash('sha1');
  let atSince = since === 0 ? '' : null;
  let atStable = '';
  for (let i = 0; i <= stable; i++) {
    if (i === since && since > 0) atSince = h.copy().digest('hex');
    if (i === stable) atStable = h.copy().digest('hex');
    else h.update(JSON.stringify(messages[i]) + '\n');
  }

  const fieldSigs = {};
  const have = opts.have || {};
  const unchanged = [];
  for (const k of HEAVY_FIELDS) {
    if (!(k in d)) continue;
    const sig = sha(JSON.stringify(d[k]));
    fieldSigs[k] = sig;
    if (have[k] === sig) { unchanged.push(k); delete d[k]; }
  }

  const usable = since > 0 && since <= total && opts.sig && atSince === opts.sig;
  d.messagesFrom = usable ? since : 0;
  if (usable) d.messages = messages.slice(since);
  d.stableCount = stable;
  d.prefixSig = atStable;
  d.fieldSigs = fieldSigs;
  if (unchanged.length) d.unchanged = unchanged;
  return d;
}

// Parses ?since=&sig=&have=changes.abc,workflows.def into trimDetail's options.
export function parseDeltaParams(params) {
  const since = parseInt(params.get('since') || '', 10);
  const have = {};
  for (const part of (params.get('have') || '').split(',')) {
    const dot = part.indexOf('.');
    if (dot > 0) have[part.slice(0, dot)] = part.slice(dot + 1);
  }
  return { since: since > 0 ? since : 0, sig: params.get('sig') || '', have };
}
