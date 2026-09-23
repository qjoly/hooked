/*
 * A compaction in the transcript. The fixture reproduces, verbatim in shape, what a `/compact` sent
 * through the SDK input writes (captured live): the boundary, the summary turn, the command echo
 * and its stdout. The conversation must show ONE system line for it — the summary and the bare
 * `/compact` would otherwise read as messages the user typed (auto-compact sends it for them) —
 * and the session summary must stop claiming the pre-compaction size is what a resume costs.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversation } from '../server/conversation.js';
import { parseTranscript } from '../server/transcript.js';

const FP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'compact.jsonl');

describe('compaction in the conversation', () => {
  const msgs = buildConversation(FP);

  it('renders one system line with the CLI before/after sizes, and no bubble for the summary or the echo', () => {
    expect(msgs.map((m) => `${m.role}${m.kind ? '/' + m.kind : ''}: ${m.text}`)).toEqual([
      'user: Explain HTTP caching headers.',
      'assistant: HTTP caching lets clients avoid re-fetching unchanged resources.',
      'system/compact: Conversation compacted',
    ]);
    expect(msgs[2]).toMatchObject({ preTokens: 33305, postTokens: 6180, ts: '2026-09-23T10:08:00Z' });
  });
});

describe('compaction in the session summary', () => {
  it('drops the last usage: after a compaction a resume re-sends the summary, not the thread', () => {
    expect(parseTranscript(FP, 'compact').lastUsage).toBe(null);
  });
});
