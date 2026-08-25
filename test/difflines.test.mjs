/*
 * difflines (src/lib/difflines.js) : le modèle de diff par lignes de la lentille Ship. On vérifie
 *   • toSegments : coalescence des parts supprimées+ajoutées en UN segment 'change' ;
 *   • countStats : +N / −M par fichier ;
 *   • unifiedRows : numérotation old/new correcte, ordre del-puis-add ;
 *   • repliage : un long bloc inchangé au milieu se réduit à du contexte + un 'gap' ;
 *   • langFromName : extension → tag de coloration.
 * Ces invariants sont ce dont dépend l'affichage NET (original→final) de Ship.
 */
import { describe, it, expect } from 'vitest';
import { toSegments, countStats, unifiedRows, splitRows, langFromName, applyOp } from '../src/lib/difflines.js';

describe('toSegments', () => {
  it('pairs a removed block with the following added block into one change', () => {
    const segs = toSegments('a\nb\nc\n', 'a\nB\nc\n');
    expect(segs).toEqual([
      { type: 'equal', lines: ['a'] },
      { type: 'change', del: ['b'], add: ['B'] },
      { type: 'equal', lines: ['c'] },
    ]);
  });

  it('a pure addition has an empty del side', () => {
    const segs = toSegments('a\nc\n', 'a\nb\nc\n');
    const change = segs.find((s) => s.type === 'change');
    expect(change.del).toEqual([]);
    expect(change.add).toEqual(['b']);
  });

  it('identical content yields a single equal segment (no change)', () => {
    const segs = toSegments('x\ny\n', 'x\ny\n');
    expect(segs.every((s) => s.type === 'equal')).toBe(true);
  });
});

describe('countStats', () => {
  it('counts added and removed lines across changes', () => {
    const segs = toSegments('a\nb\nc\n', 'a\nB\nC\nd\n');
    expect(countStats(segs)).toEqual({ adds: 3, dels: 2 });
  });
});

describe('unifiedRows', () => {
  it('numbers old/new lines and emits del rows before add rows', () => {
    const rows = unifiedRows(toSegments('a\nb\nc\n', 'a\nB\nc\n'));
    expect(rows).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'a' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'b' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'B' },
      { kind: 'ctx', oldNo: 3, newNo: 3, text: 'c' },
    ]);
  });

  it('collapses a long unchanged middle run into context + a gap', () => {
    // change · long-equal · change → the equal run is neither first nor last, so it collapses to
    // 3 head + gap + 3 tail lines of context.
    const eq = Array.from({ length: 20 }, (_, i) => 'line' + i).join('\n');
    const rows = unifiedRows(toSegments('A_OLD\n' + eq + '\nB_OLD\n', 'A_NEW\n' + eq + '\nB_NEW\n'));
    const gap = rows.find((r) => r.kind === 'gap');
    expect(gap).toBeTruthy();
    expect(gap.count).toBe(14); // 20 equal − 3 head − 3 tail
    // the hidden lines are still counted → the trailing deletion lands on old line 22.
    const lastDel = rows.filter((r) => r.kind === 'del').at(-1);
    expect(lastDel.oldNo).toBe(22); // A_OLD(1) + 20 equal + B_OLD(22)
  });
});

describe('gap expansion (GitHub-style expand buttons)', () => {
  // change · 30 equal lines · change → collapses to 3 head + gap(24) + 3 tail.
  const eq = Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n');
  const segs = toSegments('A_OLD\n' + eq + '\nB_OLD\n', 'A_NEW\n' + eq + '\nB_NEW\n');
  const gapSeg = () => unifiedRows(segs).find((r) => r.kind === 'gap').seg;

  it('gap rows carry their segment index', () => {
    expect(typeof gapSeg()).toBe('number');
  });

  it('head expansion reveals lines below the upper context and shrinks the gap', () => {
    const rows = unifiedRows(segs, { [gapSeg()]: { head: 20 } });
    const gap = rows.find((r) => r.kind === 'gap');
    expect(gap.count).toBe(4); // 24 hidden − 20 revealed
    // line numbering stays correct: the trailing deletion is still old line 32.
    expect(rows.filter((r) => r.kind === 'del').at(-1).oldNo).toBe(32);
    // the first revealed line follows the 3 default head-context lines.
    const ctx = rows.filter((r) => r.kind === 'ctx');
    expect(ctx[3].text).toBe('line3');
  });

  it('tail expansion reveals lines above the lower context', () => {
    const rows = unifiedRows(segs, { [gapSeg()]: { tail: 20 } });
    expect(rows.find((r) => r.kind === 'gap').count).toBe(4);
    const ctx = rows.filter((r) => r.kind === 'ctx');
    expect(ctx.at(-1).text).toBe('line29'); // tail still ends at the default context
    expect(ctx.length).toBe(3 + 23); // 3 head + (20 revealed + 3 tail)
  });

  it('expanding past the hidden count removes the gap entirely', () => {
    const rows = unifiedRows(segs, { [gapSeg()]: { head: 20, tail: 20 } });
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    expect(rows.filter((r) => r.kind === 'ctx').length).toBe(30);
    expect(rows.filter((r) => r.kind === 'del').at(-1).oldNo).toBe(32);
  });

  it('all:true reveals the whole run', () => {
    const rows = unifiedRows(segs, { [gapSeg()]: { all: true } });
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    expect(rows.filter((r) => r.kind === 'ctx').length).toBe(30);
  });

  it('splitRows honours the same expansion contract', () => {
    const seg = splitRows(segs).find((r) => r.kind === 'gap').seg;
    const rows = splitRows(segs, { [seg]: { all: true } });
    expect(rows.some((r) => r.kind === 'gap')).toBe(false);
    expect(rows.filter((r) => r.kind === 'ctx').at(-1).left.no).toBe(31);
  });
});

describe('splitRows', () => {
  it('zips deletions and additions side by side', () => {
    const rows = splitRows(toSegments('a\nb\n', 'a\nB\n'));
    const change = rows.find((r) => r.kind === 'change');
    expect(change.left.text).toBe('b');
    expect(change.right.text).toBe('B');
  });
});

describe('applyOp (forward replay for the per-prompt filter)', () => {
  it('applies an edit (first occurrence)', () => {
    expect(applyOp('a foo b foo', { kind: 'edit', old: 'foo', new: 'X' })).toBe('a X b foo');
  });
  it('applies a replace_all edit', () => {
    expect(applyOp('foo foo', { kind: 'edit', old: 'foo', new: 'X', all: true })).toBe('X X');
  });
  it('a write replaces the whole file', () => {
    expect(applyOp('old stuff', { kind: 'write', content: 'brand new' })).toBe('brand new');
  });
  it('edit-from-empty creates the file', () => {
    expect(applyOp('', { kind: 'edit', old: '', new: 'hello' })).toBe('hello');
  });
  it('leaves text unchanged when the old string is absent (tolerant)', () => {
    expect(applyOp('abc', { kind: 'edit', old: 'zzz', new: 'X' })).toBe('abc');
  });
  it('replaying a turn sequence reproduces the final content', () => {
    const ops = [
      { kind: 'edit', old: 'a', new: 'A' },
      { kind: 'edit', old: 'b', new: 'B' },
    ];
    let text = 'a\nb\nc';
    for (const o of ops) text = applyOp(text, o);
    expect(text).toBe('A\nB\nc');
  });
});

describe('langFromName', () => {
  it('maps common extensions', () => {
    expect(langFromName('server/usage.js')).toBe('js');
    expect(langFromName('a.py')).toBe('py');
    expect(langFromName('X.svelte')).toBe('html');
    expect(langFromName('noext')).toBe('');
  });
});
