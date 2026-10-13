/*
 * mdDiff (src/lib/mdDiff.js): the rendered view of a markdown diff in the Review lens. We check
 *   • mdBlocks: a document is cut into the blocks a reader sees, a list into its items, and an
 *     ordered item alone still reads its real number;
 *   • front matter stays one block, rendered as yaml rather than as a rule plus a heading;
 *   • mdBlockDiff: only the blocks that changed are tinted, removed ones before their replacement.
 */
import { describe, it, expect } from 'vitest';
import { mdBlocks, mdBlockDiff } from '../src/lib/mdDiff.js';
import { mdSegments } from '../src/lib/format.js';

describe('mdSegments breaks option', () => {
  const html = (src, opts) => mdSegments(src, opts)[0].parts[0].html;

  it('keeps the chat default: a single newline is a line break', () => {
    expect(html('one\ntwo')).toBe('one<br>\ntwo');
  });

  it('renders a hard-wrapped file paragraph as one line', () => {
    expect(html('one\ntwo', { breaks: false })).toBe('one\ntwo');
  });
});

const texts = (src) => mdBlocks(src).map((b) => b.text);

describe('mdBlocks', () => {
  it('cuts headings, paragraphs and code fences into separate blocks', () => {
    expect(texts('# Title\n\nSome text\non two lines.\n\n```js\nx()\n```\n')).toEqual([
      '# Title',
      'Some text\non two lines.',
      '```js\nx()\n```',
    ]);
  });

  it('cuts a list into its items, nested lists staying with their parent item', () => {
    expect(texts('- a\n- b\n  - b.1\n\n- c\n')).toEqual(['- a', '- b\n  - b.1', '- c']);
  });

  it('renumbers an ordered item with its ordinal, the diff key keeping the source', () => {
    const blocks = mdBlocks('1. one\n1. two\n1. three\n');
    expect(blocks.map((b) => b.text)).toEqual(['1. one', '2. two', '3. three']);
    expect(blocks.map((b) => b.key)).toEqual(['1. one', '1. two', '1. three']);
  });

  it('starts the numbering where the list starts', () => {
    expect(texts('3) c\n9) d\n')).toEqual(['3) c', '4) d']);
  });

  it('keeps a table and a blockquote whole', () => {
    expect(texts('| a | b |\n|---|---|\n| 1 | 2 |\n\n> - q1\n> - q2\n')).toEqual([
      '| a | b |\n|---|---|\n| 1 | 2 |',
      '> - q1\n> - q2',
    ]);
  });

  it('renders a leading front matter as one yaml block', () => {
    const blocks = mdBlocks('---\nname: x\ndescription: y\n---\n# Body\n');
    expect(blocks.map((b) => b.text)).toEqual(['```yaml\nname: x\ndescription: y\n```', '# Body']);
    expect(blocks[0].key).toBe('---\nname: x\ndescription: y\n---');
  });

  it('does not take a later rule for front matter', () => {
    expect(texts('text\n\n---\n\nmore\n')).toEqual(['text', '---', 'more']);
  });

  it('reads CRLF sources like LF ones', () => {
    expect(mdBlocks('# T\r\n\r\n- a\r\n- b\r\n')).toEqual(mdBlocks('# T\n\n- a\n- b\n'));
  });

  it('has no block for an empty document', () => {
    expect(mdBlocks('')).toEqual([]);
    expect(mdBlocks(null)).toEqual([]);
  });
});

describe('mdBlockDiff', () => {
  it('leaves an unchanged document untinted', () => {
    const doc = '# T\n\n- a\n- b\n';
    expect(mdBlockDiff(doc, doc).every((b) => b.kind === 'ctx')).toBe(true);
  });

  it('tints only the list item that changed, the removed one before its replacement', () => {
    expect(mdBlockDiff('# T\n\n- a\n- b\n- c\n', '# T\n\n- a\n- B\n- c\n')).toEqual([
      { kind: 'ctx', text: '# T' },
      { kind: 'ctx', text: '- a' },
      { kind: 'del', text: '- b' },
      { kind: 'add', text: '- B' },
      { kind: 'ctx', text: '- c' },
    ]);
  });

  it('shows a new file as all additions', () => {
    expect(mdBlockDiff('', '# T\n\ntext\n')).toEqual([
      { kind: 'add', text: '# T' },
      { kind: 'add', text: 'text' },
    ]);
  });

  it('renders each block with the ordinal of its own version', () => {
    // An item inserted at the top of a `1.`-style list: the source of the others is unchanged,
    // so they stay context, but they read their NEW number.
    expect(mdBlockDiff('1. b\n1. c\n', '1. a\n1. b\n1. c\n')).toEqual([
      { kind: 'add', text: '1. a' },
      { kind: 'ctx', text: '2. b' },
      { kind: 'ctx', text: '3. c' },
    ]);
  });
});
