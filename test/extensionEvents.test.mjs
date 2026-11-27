/*
 * Core events (server/extensionEvents.js): delivered later, never awaited, and a listener that
 * throws neither reaches the emitter nor stops the other extensions' listeners.
 */
import { describe, it, expect, vi } from 'vitest';
import { subscribeExtension, unsubscribeExtension, emitExtensionEvent } from '../server/extensionEvents.js';

const nextTick = () => new Promise((r) => setImmediate(r));

describe('core events', () => {
  it('delivers on a later tick, isolates a throwing listener, ignores unknown events', async () => {
    const got = [];
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    subscribeExtension('a', { 'turn:end': () => { throw new Error('boom'); } });
    subscribeExtension('b', { 'turn:end': (e) => got.push(e.sessionId), 'not:an-event': () => got.push('bad') });
    emitExtensionEvent('turn:end', { sessionId: 's1' });
    expect(got).toEqual([]);
    await nextTick();
    expect(got).toEqual(['s1']);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('extension a: turn:end listener: boom'));
    emitExtensionEvent('not:an-event', {});
    unsubscribeExtension('b');
    emitExtensionEvent('turn:end', { sessionId: 's2' });
    await nextTick();
    expect(got).toEqual(['s1']);
    unsubscribeExtension('a');
    log.mockRestore();
  });
});
