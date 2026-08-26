/*
 * composerSettleKey — the normalization behind waitForComposerSettled (server/tmux.js), which gates
 * deliverReply so a message is never typed into a still-repainting composer. Typing during the
 * repaint just after an interrupt dropped the first character (REPRO_MSG_ZZZ arrived as
 * EPRO_MSG_ZZZ) or left the message queued-but-unsent.
 *
 * The key must (a) strip the volatile footer lines that animate every frame while Claude works
 * (spinner, its timer/token counter, the rotating Tip hint) so a working/steered pane can still be
 * recognised as "settled", yet (b) still change when the actual conversation body changes, so we
 * don't falsely settle mid-stream.
 */
import { describe, it, expect } from 'vitest';
import { composerSettleKey } from '../server/tmux.js';

// Two consecutive animation frames of the SAME working pane: spinner glyph, elapsed time, token
// count and the Tip line all differ; the composer and footer are identical.
const workingFrameA = [
  '⏺ Lancé en background (bsvnav8hw), je serai notifié quand ça finit.',
  '',
  '✳ Perambulating… (3s · ↓ 113 tokens)',
  '  ⎿  Tip: Did you know you can drag and drop image files into your terminal?',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on · 1 shell · ← 1 agent',
].join('\n');

const workingFrameB = [
  '⏺ Lancé en background (bsvnav8hw), je serai notifié quand ça finit.',
  '',
  '✽ Perambulating… (4s · ↓ 140 tokens)',
  '  ⎿  Tip: Hit shift+tab to cycle between manual mode, auto-accept edit mode, and plan mode',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on · 1 shell · ← 1 agent',
].join('\n');

// A later frame where the conversation BODY grew (Claude streamed a new line): genuinely different.
const workingFrameStreamed = [
  '⏺ Lancé en background (bsvnav8hw), je serai notifié quand ça finit.',
  '⏺ Le job est fini (exit 0). Output : FINISHED_SLEEP.',
  '',
  '✳ Perambulating… (5s · ↓ 160 tokens)',
  '  ⎿  Tip: Did you know you can drag and drop image files into your terminal?',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on · 1 shell · ← 1 agent',
].join('\n');

const idleComposer = [
  '⏺ Done.',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
].join('\n');

describe('composerSettleKey — volatile footer lines stripped', () => {
  it('drops the spinner activity line', () => {
    expect(composerSettleKey(workingFrameA)).not.toContain('Perambulating');
  });
  it('drops the elapsed-time / token counter tail', () => {
    expect(composerSettleKey(workingFrameA)).not.toContain('113 tokens');
  });
  it('drops the rotating Tip hint', () => {
    expect(composerSettleKey(workingFrameA)).not.toContain('Tip:');
  });
  it('keeps the composer prompt and footer', () => {
    const key = composerSettleKey(workingFrameA);
    expect(key).toContain('❯');
    expect(key).toContain('auto mode on');
  });
});

describe('composerSettleKey — settle decision', () => {
  it('treats two animation frames of the same working pane as settled (equal keys)', () => {
    expect(composerSettleKey(workingFrameA)).toBe(composerSettleKey(workingFrameB));
  });
  it('does NOT settle while the conversation body is still streaming (keys differ)', () => {
    expect(composerSettleKey(workingFrameA)).not.toBe(composerSettleKey(workingFrameStreamed));
  });
  it('is stable for an idle composer', () => {
    expect(composerSettleKey(idleComposer)).toBe(composerSettleKey(idleComposer));
  });
});
