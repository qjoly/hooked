// Rendered view of a markdown diff (the Review lens's "rendered" toggle, GitHub's rich diff):
// both versions are cut into the blocks a reader sees, the two block lists are diffed, and every
// block keeps its own markdown so the caller renders it as is. No DOM, no HTML: pure data, so it
// stays testable like difflines.js.
import { diffArrays } from 'diff';
import { mdParse } from './format.js';

// Jekyll/GitHub front matter: a `---` fence on the very first line, closed by another one.
const FRONT_MATTER = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

// The blocks of one markdown document, in order: { key, text }.
//   key  — the block's source, what the diff compares;
//   text — what to render. Same as `key`, except for an ordered-list item, renumbered with its
//          ordinal: rendered alone, items all written `1.` would all read "1.".
// A top-level list is cut into its items, so that one changed bullet does not drag the whole list
// into the diff. Tables and blockquotes stay whole. A leading front matter is one block rendered
// as yaml: parsed as markdown, it would read as a rule followed by a heading.
export function mdBlocks(src) {
  let body = String(src ?? '').replace(/\r\n?/g, '\n');
  const blocks = [];
  const fm = FRONT_MATTER.exec(body);
  if (fm) {
    blocks.push({ key: fm[0].trimEnd(), text: '```yaml\n' + fm[1] + '\n```' });
    body = body.slice(fm[0].length);
  }
  const lines = body.split('\n');
  const source = (tok) => lines.slice(tok.map[0], tok.map[1]).join('\n').trimEnd();
  let ordinal = null; // number of the next item of the ordered list being walked
  for (const tok of mdParse(body)) {
    if (tok.nesting === -1 || !tok.map) continue;
    if (tok.level === 0 && tok.type === 'bullet_list_open') ordinal = null;
    else if (tok.level === 0 && tok.type === 'ordered_list_open') ordinal = Number(tok.attrGet('start') ?? 1);
    else if (tok.level === 0) blocks.push({ key: source(tok), text: source(tok) });
    else if (tok.level === 1 && tok.type === 'list_item_open') {
      const key = source(tok);
      blocks.push({ key, text: ordinal == null ? key : key.replace(/^( *)\d+/, `$1${ordinal++}`) });
    }
  }
  return blocks;
}

// [{ kind: 'ctx' | 'del' | 'add', text }]: the new version's blocks in order, each removed block
// placed just before what replaced it (the same del-then-add order as the line diff).
export function mdBlockDiff(oldStr, newStr) {
  const before = mdBlocks(oldStr), after = mdBlocks(newStr);
  const out = [];
  let i = 0, j = 0;
  for (const part of diffArrays(before.map((b) => b.key), after.map((b) => b.key))) {
    for (let n = 0; n < part.count; n++) {
      if (part.removed) out.push({ kind: 'del', text: before[i++].text });
      else if (part.added) out.push({ kind: 'add', text: after[j++].text });
      else { out.push({ kind: 'ctx', text: after[j++].text }); i++; }
    }
  }
  return out;
}
