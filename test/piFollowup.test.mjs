/*
 * Follow-up suggestions of pi sessions (server/piFollowup.js): the next prompt predicted after a
 * turn, as Claude Code's prompt_suggestion is on the Claude path.
 */
import { describe, it, expect } from 'vitest';
import { followupPrompt, cleanSuggestion, suggestFollowup } from '../server/piFollowup.js';

const entry = (over = {}) => {
  const st = { _followupUser: 'Add a test for the parser', _followupReply: 'Added test/parser.test.mjs; it passes.', _followupSeq: 3, busy: false, pendingAsk: null, followup: null, emits: 0, ...over };
  st._emit = () => { st.emits++; };
  return st;
};

describe('pi follow-up suggestions', () => {
  it('asks for the next message from the last exchange', () => {
    const p = followupPrompt('Fix the login bug', 'Fixed in auth.js, tests pass.');
    expect(p).toContain('<request>\nFix the login bug\n</request>');
    expect(p).toContain('<reply>\nFixed in auth.js, tests pass.\n</reply>');
    expect(p).toMatch(/answer exactly NONE/);
    // a long reply keeps its end, where the conclusion is
    expect(followupPrompt('x', 'a'.repeat(5000) + 'END')).toContain('aEND\n</reply>');
  });

  it('keeps one short user message, and nothing for NONE', () => {
    expect(cleanSuggestion('"Commit and open a PR"')).toBe('Commit and open a PR');
    expect(cleanSuggestion('Next message: run the full test suite\nmore')).toBe('run the full test suite');
    expect(cleanSuggestion('NONE')).toBeNull();
    expect(cleanSuggestion('none.')).toBeNull();
    expect(cleanSuggestion('   ')).toBeNull();
    expect(cleanSuggestion('x'.repeat(201))).toBeNull();
    expect(cleanSuggestion(null)).toBeNull();
  });

  it('sets the suggestion and tells the dashboard', async () => {
    const st = entry();
    const asked = [];
    const got = await suggestFollowup(st, { run: async (prompt) => { asked.push(prompt); return 'Commit the change'; } });
    expect(got).toBe('Commit the change');
    expect(st.followup).toBe('Commit the change');
    expect(st.emits).toBe(1);
    expect(asked[0]).toContain('Add a test for the parser');
  });

  it('drops a stale suggestion: new prompt, busy again, or a card waiting', async () => {
    for (const change of [(st) => { st._followupSeq++; }, (st) => { st.busy = true; }, (st) => { st.pendingAsk = { kind: 'question' }; }]) {
      const st = entry();
      const got = await suggestFollowup(st, { run: async () => { change(st); return 'Something'; } });
      expect(got).toBeNull();
      expect(st.followup).toBeNull();
      expect(st.emits).toBe(0);
    }
  });

  it('asks nothing without both sides of the exchange, and survives a failed call', async () => {
    let calls = 0;
    const run = async () => { calls++; return 'x'; };
    expect(await suggestFollowup(entry({ _followupReply: null }), { run })).toBeNull();
    expect(calls).toBe(0);
    const st = entry();
    expect(await suggestFollowup(st, { run: async () => { throw new Error('boom'); } })).toBeNull();
    expect(st.followup).toBeNull();
  });
});
