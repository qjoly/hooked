/*
 * A subagent's report reaches its parent as a `<agent-message from="<agentId>">` (the CLI's
 * "Subagent hand-back"), on up to four carriers at once: queue-operation enqueue/remove,
 * attachment queued_command, and a user line with `origin.kind: "peer"`. The Agent tool_result
 * itself only says "launched" (background) or "delivered as a message" (foreground). Rendered
 * as-is, the report showed up as one or two "You" bubbles; it belongs in the Agent tool chip.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConversation } from '../server/conversation.js';

const FP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'subagent-handback.jsonl');
const msgs = buildConversation(FP);
const tool = (id) => msgs.flatMap((m) => m.tools || []).find((t) => t.id === id);

describe('subagent hand-back', () => {
  it('is never rendered as a user bubble', () => {
    const users = msgs.filter((m) => m.role === 'user');
    expect(users.some((m) => /agent-message|Subagent hand-back|early finding/.test(m.text))).toBe(false);
  });

  it('becomes the result of the background Agent call, unframed and in arrival order', () => {
    expect(tool('toolu_bg').result).toBe(
      'Part 1/2: early finding\n\n---\n\n## Auth report\n\nNo issue found.\n</agent-message>\nStill the report.',
    );
  });

  it('replaces the "delivered as a message" result of a foreground Agent call', () => {
    expect(tool('toolu_sync').result).toBe('Routes: /a, /b');
  });

  it('leaves the launch result of an agent that has not reported yet', () => {
    expect(tool('toolu_wip').result).toBe('Async agent launched successfully.\nagentId: a3333');
  });

  it('keeps the "finished" system line where the report came back', () => {
    expect(msgs.some((m) => m.role === 'system' && m.kind === 'bg' && m.text === 'Agent "Audit auth" finished')).toBe(true);
  });

  it('keeps a message from an agent with no Agent call in this transcript', () => {
    expect(msgs.filter((m) => m.role === 'user' && m.text.includes('Hello from an unknown agent')).length).toBeGreaterThan(0);
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.forkUuid)).toEqual(['u1', 'p4']);
  });
});
