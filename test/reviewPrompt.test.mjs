/*
 * threadInstructions (src/lib/reviewPrompt.js) — the review-thread instructions embedded in the
 * prompts Ship/Branch send to a session. Guards the three availability precautions: full MCP tool
 * names (ToolSearch `select:`), literal session id (a session doesn't know its hooked id), and a
 * curl fallback on /api/review with the exact field names the endpoint expects.
 */
import { describe, it, expect } from 'vitest';
import { threadInstructions } from '../src/lib/reviewPrompt.js';

describe('threadInstructions', () => {
  const text = threadInstructions('sess-42');

  it('names the tools by their full MCP name', () => {
    expect(text).toContain('mcp__hooked__reply_review_comment');
    expect(text).toContain('mcp__hooked__resolve_review_comment');
  });

  it('embeds the literal session id, both for the tool and the fallback payloads', () => {
    expect(text).toContain('(id: "sess-42"');
    expect(text).toContain('"id":"sess-42","action":"reply"');
    expect(text).toContain('"id":"sess-42","action":"resolve"');
  });

  it('spells out a curl fallback matching the /api/review contract', () => {
    expect(text).toContain('/api/review');
    expect(text).toContain('"author":"claude"');
    expect(text).toContain('"resolved":true');
    // Outside a browser (no `location`) the fallback targets the default hooked port.
    expect(text).toContain('http://localhost:4123/api/review');
  });
});
