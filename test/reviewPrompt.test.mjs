/*
 * threadInstructions (src/lib/reviewPrompt.js) — the review-thread instructions embedded in the
 * prompts Ship/Branch send to a session. Guards the three availability precautions: full MCP tool
 * names (ToolSearch `select:`), literal session id (a session doesn't know its hooked id), and a
 * curl fallback on /api/review with the exact field names the endpoint expects.
 */
import { describe, it, expect } from 'vitest';
import { threadInstructions, reviewRequestPrompt } from '../src/lib/reviewPrompt.js';

describe('threadInstructions', () => {
  const text = threadInstructions('sess-42');

  it('names the reply tool by its full MCP name', () => {
    expect(text).toContain('mcp__hooked__reply_review_comment');
  });

  it('does NOT ask the session to close the thread', () => {
    // Le prompt demandait `resolve_review_comment` « once the code is fixed » : chaque réponse
    // fermait donc son propre thread et la diff se vidait avant qu'on ait rien lu. L'outil a été
    // retiré du serveur MCP ; l'instruction ne doit pas le ressusciter.
    expect(text).not.toContain('resolve_review_comment');
    expect(text).not.toContain('"action":"resolve"');
    expect(text).toContain("Do NOT close the thread");
  });

  it('embeds the literal session id, both for the tool and the fallback payloads', () => {
    expect(text).toContain('(id: "sess-42"');
    expect(text).toContain('"id":"sess-42","action":"reply"');
  });

  it('spells out a curl fallback matching the /api/review contract', () => {
    expect(text).toContain('/api/review');
    expect(text).toContain('"author":"claude"');
    // Outside a browser (no `location`) the fallback targets the default hooked port.
    expect(text).toContain('http://localhost:4123/api/review');
  });
});

// "Review with Claude": the prompt asking the session to review the diff on screen and to open its
// findings as inline threads itself.
describe('reviewRequestPrompt', () => {
  const text = reviewRequestPrompt('sess-42', {
    scope: 'the uncommitted changes in the working tree',
    files: ['/repo/a.js', '/repo/lib/b.js'],
    open: [{ file: '/repo/a.js', anchor: '+L3', text: 'Null check missing\non the second line' }],
  });

  it('reviews exactly the scope and the files on screen', () => {
    expect(text).toContain('Review the uncommitted changes in the working tree');
    expect(text).toContain('- /repo/a.js\n- /repo/lib/b.js');
  });

  it('asks for one thread per finding through the full MCP tool name, with the literal session id', () => {
    expect(text).toContain('mcp__hooked__add_review_comment');
    expect(text).toContain('(id: "sess-42"');
  });

  it('anchors on the lines of the file as it is on disk', () => {
    expect(text).toMatch(/1-based lines of the file as it is on disk/);
  });

  it('spells out a curl fallback matching the claude-comment contract of /api/review', () => {
    expect(text).toContain('http://localhost:4123/api/review');
    expect(text).toContain('"id":"sess-42","action":"claude-comment","file":"<path>","start":<line>,"end":<end_line>,"text":"<finding>"');
  });

  it('is a review, not a fix', () => {
    expect(text).toContain('Do NOT change any code');
  });

  it('lists the threads already open so they are not raised twice — first line only', () => {
    expect(text).toContain('- /repo/a.js (+L3): Null check missing');
    expect(text).not.toContain('on the second line');
  });

  it('says nothing about open or dismissed threads when there are none', () => {
    const bare = reviewRequestPrompt('s', { scope: 'your changes', files: ['/x.js'], open: [] });
    expect(bare).not.toContain('already open');
    expect(bare).not.toContain('dismissed');
  });

  it('lists the archived threads apart, so a finding the reviewer dismissed is not raised again', () => {
    const t = reviewRequestPrompt('s', {
      scope: 'your changes', files: ['/x.js'], open: [],
      dismissed: [{ file: '/x.js', anchor: '+L9', text: 'False positive about caching' }],
    });
    expect(t).toMatch(/dismissed by the reviewer[^\n]*do not raise them again:\n- \/x\.js \(\+L9\): False positive about caching/);
  });

  it('anchors on the revision the diff shows when it is not the disk (branch scope)', () => {
    const t = reviewRequestPrompt('s', { scope: 'the full diff of branch `feat`', rev: 'feat', files: ['/x.js'], open: [] });
    expect(t).toContain('1-based lines of the file at revision feat (git show feat:<path>)');
    expect(t).not.toContain('as it is on disk');
  });
});
