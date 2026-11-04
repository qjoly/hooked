// Rendered view of a markdown diff (the Review lens's "rendered" toggle, GitHub's rich diff):
// both versions are cut into the blocks a reader sees, the two block lists are diffed, and every
// block keeps its own markdown so the caller renders it as is. No DOM, no HTML: pure data, so it
// stays testable like difflines.js.
import { diffArrays } from 'diff';
import { mdParse } from './format.js';

// Jekyll/GitHub front matter: a `---` fence on the very first line, closed by another one.
const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

// The blocks of one markdown document, in order: { key, text, lines }.
//   key   — the block's source, what the diff compares;
//   text  — what to render. Same as `key`, except for an ordered-list item, renumbered with its
//           ordinal: rendered alone, items all written `1.` would all read "1.";
//   lines — [first, last] source lines of `key`, 1-based like the line diff's numbers, so the
//           block can be laid level with them.
// A top-level list is cut into its items, so that one changed bullet does not drag the whole list
// into the diff. Tables and blockquotes stay whole. A leading front matter is one block rendered
// as yaml: parsed as markdown, it would read as a rule followed by a heading.
export function mdBlocks(src) {
  let body = String(src ?? '').replace(/\r\n?/g, '\n');
  const blocks = [];
  const spanOf = (key, first) => [first, first + key.split('\n').length - 1];
  const fm = FRONT_MATTER.exec(body);
  let offset = 0; // lines the front matter takes before the parsed body
  if (fm) {
    const key = fm[0].trimEnd();
    blocks.push({ key, text: '```yaml\n' + fm[1] + '\n```', lines: spanOf(key, 1) });
    body = body.slice(fm[0].length);
    offset = fm[0].split('\n').length - 1;
  }
  const lines = body.split('\n');
  const block = (tok, text = null) => {
    const key = lines.slice(tok.map[0], tok.map[1]).join('\n').trimEnd();
    return { key, text: text ? text(key) : key, lines: spanOf(key, offset + tok.map[0] + 1) };
  };
  let ordinal = null; // number of the next item of the ordered list being walked
  for (const tok of mdParse(body)) {
    if (tok.nesting === -1 || !tok.map) continue;
    if (tok.level === 0 && tok.type === 'bullet_list_open') ordinal = null;
    else if (tok.level === 0 && tok.type === 'ordered_list_open') ordinal = Number(tok.attrGet('start') ?? 1);
    else if (tok.level === 0) blocks.push(block(tok));
    else if (tok.level === 1 && tok.type === 'list_item_open') {
      blocks.push(block(tok, ordinal == null ? null : (key) => key.replace(/^( *)\d+/, `$1${ordinal++}`)));
    }
  }
  return blocks;
}

// [{ kind: 'ctx' | 'del' | 'add', text, old, new }]: the new version's blocks in order, each
// removed block placed just before what replaced it (the same del-then-add order as the line
// diff). `old` / `new` are the block's source lines in that version, null where it is absent.
export function mdBlockDiff(oldStr, newStr) {
  const before = mdBlocks(oldStr), after = mdBlocks(newStr);
  const out = [];
  let i = 0, j = 0;
  for (const part of diffArrays(before.map((b) => b.key), after.map((b) => b.key))) {
    for (let n = 0; n < part.count; n++) {
      if (part.removed) { const b = before[i++]; out.push({ kind: 'del', text: b.text, old: b.lines, new: null }); }
      else if (part.added) { const b = after[j++]; out.push({ kind: 'add', text: b.text, old: null, new: b.lines }); }
      else { const b = after[j++]; out.push({ kind: 'ctx', text: b.text, old: before[i++].lines, new: b.lines }); }
    }
  }
  return out;
}
