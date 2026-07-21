import { describe, it, expect } from 'vitest';
import { isTrustPrompt, isComposerReady } from '../server/tmux.js';

// Regression: a fresh/never-trusted cwd shows Claude Code's trust dialog on first launch. Its
// `❯ 1. Yes, I trust this folder` cursor matches the generic REPL prompt, so a plain readiness
// check reported "ready" and the seed prompt was typed into the dialog (accepting it) instead of
// the composer — folder trusted, conversation empty. isTrustPrompt/isComposerReady drive
// waitForComposerReady so the dialog is accepted BEFORE seeding and we only type into the real box.
const TRUST_SCREEN = `
 Accessing workspace:

 /private/tmp/hooked-trust-xxxx

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

const COMPOSER_SCREEN = `
╭─── Claude Code v2.1.177 ──────────────────────────────────────────╮
│                 Welcome back Louis!                                │
╰───────────────────────────────────────────────────────────────────╯

                                                       ● high · /effort
────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

// The AskUserQuestion / plan menus also render `❯ 1. …`; the composer check must reject them too.
const QUESTION_SCREEN = `
 What's your favorite color?

 ❯ 1. Red
   2. Blue
`;

describe('trust dialog detection', () => {
  it('isTrustPrompt matches the trust dialog', () => {
    expect(isTrustPrompt(TRUST_SCREEN)).toBe(true);
  });
  it('isTrustPrompt does not match the composer or a question menu', () => {
    expect(isTrustPrompt(COMPOSER_SCREEN)).toBe(false);
    expect(isTrustPrompt(QUESTION_SCREEN)).toBe(false);
  });
  it('isComposerReady is false on the trust dialog (would seed into it)', () => {
    expect(isComposerReady(TRUST_SCREEN)).toBe(false);
  });
  it('isComposerReady is false on a numbered question menu', () => {
    expect(isComposerReady(QUESTION_SCREEN)).toBe(false);
  });
  it('isComposerReady is true only on the real composer', () => {
    expect(isComposerReady(COMPOSER_SCREEN)).toBe(true);
  });
});
