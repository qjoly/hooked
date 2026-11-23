/*
 * Incremental session detail: the server trims what the client already holds (tail of `messages`,
 * unchanged heavy lists) and the client rebuilds the full detail. The signature of the stable
 * prefix is what keeps a patched-in tool result from being served stale.
 */
import { describe, it, expect } from 'vitest';
import { trimDetail, parseDeltaParams } from '../server/detailDelta.js';
import { deltaQuery, mergeDetail } from '../src/lib/detailDelta.js';

const msg = (i, extra = {}) => ({ role: i % 2 ? 'assistant' : 'user', text: 'm' + i, ...extra });
const detail = (n, extra = {}) => ({
  id: 's1', messages: Array.from({ length: n }, (_, i) => msg(i)),
  changes: [{ file: 'a.js', ops: 3 }], workflows: [], ...extra,
});
// What the browser does: build the query from the copy it holds, send it, merge the answer.
const roundTrip = (prev, fresh) => {
  const params = new URLSearchParams(deltaQuery(prev, 's1'));
  const wire = JSON.parse(JSON.stringify(trimDetail(fresh, parseDeltaParams(params))));
  return { wire, merged: mergeDetail(prev, wire) };
};

describe('detail delta', () => {
  it('sends everything on the first request', () => {
    const { wire, merged } = roundTrip(null, detail(5));
    expect(wire.messagesFrom).toBe(0);
    expect(wire.messages).toHaveLength(5);
    expect(wire.unchanged).toBeUndefined();
    expect(merged.messages).toHaveLength(5);
    expect(wire.stableCount).toBe(4);
  });

  it('sends only the tail when new messages appeared', () => {
    const first = roundTrip(null, detail(5)).merged;
    const { wire, merged } = roundTrip(first, detail(8));
    expect(wire.messagesFrom).toBe(4);
    expect(wire.messages).toHaveLength(4);
    expect(merged.messages).toEqual(detail(8).messages);
  });

  it('resends only the last bubble when it grew', () => {
    const first = roundTrip(null, detail(5)).merged;
    const grown = detail(5);
    grown.messages[4].text += ' and more';
    const { wire, merged } = roundTrip(first, grown);
    expect(wire.messages).toHaveLength(1);
    expect(merged.messages[4].text).toBe('m4 and more');
  });

  it('falls back to a full resend when an earlier bubble was patched', () => {
    const first = roundTrip(null, detail(6)).merged;
    const patched = detail(6);
    patched.messages[1].tool = { result: 'late tool result' };
    const { wire, merged } = roundTrip(first, patched);
    expect(wire.messagesFrom).toBe(0);
    expect(merged.messages[1].tool).toEqual({ result: 'late tool result' });
  });

  it('falls back to a full resend when the conversation shrank (compaction)', () => {
    const first = roundTrip(null, detail(9)).merged;
    const { wire, merged } = roundTrip(first, detail(3));
    expect(wire.messagesFrom).toBe(0);
    expect(merged.messages).toHaveLength(3);
  });

  it('skips heavy lists that did not change and ships the ones that did', () => {
    const first = roundTrip(null, detail(4)).merged;
    const same = roundTrip(first, detail(4));
    expect(same.wire.unchanged).toEqual(expect.arrayContaining(['changes', 'workflows']));
    expect(same.wire.changes).toBeUndefined();
    expect(same.merged.changes).toEqual(first.changes);

    const edited = roundTrip(same.merged, detail(4, { changes: [{ file: 'b.js', ops: 1 }] }));
    expect(edited.wire.unchanged).toEqual(['workflows']);
    expect(edited.merged.changes).toEqual([{ file: 'b.js', ops: 1 }]);
  });

  it('never reuses a copy that belongs to another session', () => {
    const first = roundTrip(null, detail(5)).merged;
    const q = new URLSearchParams(deltaQuery(first, 'other'));
    expect(q.get('since')).toBeNull();
    expect(q.get('have')).toBeNull();
  });

  it('asks for a full refetch when a partial answer cannot be completed', () => {
    const wire = { id: 's1', messages: [msg(9)], messagesFrom: 4 };
    expect(mergeDetail(null, wire)).toBeNull();
    expect(mergeDetail({ messages: [msg(0)] }, wire)).toBeNull();
    expect(mergeDetail(null, { id: 's1', messages: [], messagesFrom: 0, unchanged: ['changes'] })).toBeNull();
  });

  it('handles an empty conversation', () => {
    const { wire } = roundTrip(null, detail(0));
    expect(wire.messages).toEqual([]);
    expect(wire.stableCount).toBe(0);
  });
});
