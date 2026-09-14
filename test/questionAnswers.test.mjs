/*
 * questionAnswers (server/agent.js) — the pure part of answering an AskUserQuestion: the
 * `answers` map (question text → answer string) built from the per-question selections,
 * including the TUI-style "Other" write-in: a free-text answer, the whole answer on a
 * single-choice question, appended to the ticked labels on a multi-select.
 */
import { describe, it, expect } from 'vitest';
import { questionAnswers } from '../server/agent.js';

const q = (question, labels, multiSelect = false) =>
  ({ question, multiSelect, options: labels.map((l) => ({ label: l })) });

describe('questionAnswers', () => {
  it('maps picked indices to labels (single and multi)', () => {
    const questions = [q('Colour?', ['Red', 'Blue']), q('Toppings?', ['Ham', 'Egg', 'Chili'], true)];
    const out = questionAnswers(questions, [
      { multi: false, indices: [1] },
      { multi: true, indices: [2, 0] }, // unsorted on purpose: answered in option order
    ]);
    expect(out).toEqual({ 'Colour?': 'Blue', 'Toppings?': 'Ham, Chili' });
  });

  it('answers with the Other write-in alone', () => {
    const out = questionAnswers([q('Colour?', ['Red', 'Blue'])], [{ multi: false, indices: [], other: 'mauve' }]);
    expect(out).toEqual({ 'Colour?': 'mauve' });
  });

  it('joins the write-in with the ticked labels on a multi-select', () => {
    const out = questionAnswers([q('Toppings?', ['Ham', 'Egg'], true)], [{ multi: true, indices: [0], other: 'capers' }]);
    expect(out).toEqual({ 'Toppings?': 'Ham, capers' });
  });

  it('the write-in wins over a stale tick on a single-choice question', () => {
    const out = questionAnswers([q('Colour?', ['Red'])], [{ multi: false, indices: [0], other: 'mauve' }]);
    expect(out).toEqual({ 'Colour?': 'mauve' });
  });

  it('skips unanswered questions, out-of-range indices and blank write-ins', () => {
    const out = questionAnswers(
      [q('A?', ['x']), q('B?', ['y'])],
      [{ multi: false, indices: [4] }, { multi: false, indices: [], other: '   ' }],
    );
    expect(out).toEqual({});
  });
});
