import { describe, it, expect } from 'vitest';
import { parseSwitchPrompt, isComposerReady } from '../server/tmux.js';

// Regression: changing effort/model on a LIVE session mid-conversation makes Claude Code pop a
// confirmation dialog ("Change effort level?" / "Switch model?" — the prompt cache is bound to the
// current setting, so switching re-reads the whole history next turn). setModelEffort only submitted
// `/effort …` / `/model …` + Enter, leaving that dialog open and unconfirmed → the switch never took
// effect (the user just saw a menu asking about re-reading the prompt). parseSwitchPrompt detects the
// dialog so confirmModelEffortSwitch can accept "Yes, switch to …". Captured on v2.1.206.
const EFFORT_DIALOG = `
❯ /effort ultracode

▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Change effort level?
   Your next response will be slower and use more tokens

   This conversation is cached for the current effort level. Switching to xhigh means the full history gets re-read on your next message.

 ❯ 1. Yes, switch to xhigh
   2. No, go back
`;

const MODEL_DIALOG = `
❯ /model sonnet

▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Switch model?
   Your next response will be slower and use more tokens

   This conversation is cached for the current model. Switching to Sonnet 5 means the full history gets re-read on your next message.

 ❯ 1. Yes, switch to Sonnet 5
   2. No, go back
`;

// Applied directly (no change needed / empty transcript): no dialog, just the result line.
const APPLIED_SCREEN = `
❯ /effort ultracode
  ⎿  Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration
────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────
`;

// The ExitPlanMode approval menu is also a numbered menu — must NOT be mistaken for a switch dialog.
const PLAN_MENU = `
 Ready to code?

 Would you like to proceed?

 ❯ 1. Yes, auto-accept edits
   2. Yes, manually approve edits
   3. Tell Claude what to change
`;

// Trust dialog — another numbered menu that must not match.
const TRUST_MENU = `
 Quick safety check: Is this a project you created or one you trust?

 ❯ 1. Yes, I trust this folder
   2. No, exit
`;

describe('effort/model switch-confirmation dialog', () => {
  it('parses the effort dialog and finds "Yes, switch to …" as option 1', () => {
    const opts = parseSwitchPrompt(EFFORT_DIALOG);
    expect(opts).not.toBeNull();
    expect(opts.length).toBe(2);
    const yes = opts.find((o) => /^yes,\s*switch to/i.test(o.label));
    expect(yes).toBeTruthy();
    expect(yes.num).toBe(1);
    expect(yes.cursor).toBe(true); // cursor defaults to the confirm option
    expect(opts.find((o) => /no, go back/i.test(o.label))).toBeTruthy();
  });

  it('parses the model dialog too (Switch model?)', () => {
    const opts = parseSwitchPrompt(MODEL_DIALOG);
    expect(opts).not.toBeNull();
    expect(opts.find((o) => /^yes,\s*switch to sonnet 5/i.test(o.label))).toBeTruthy();
  });

  it('returns null when the switch dialog is absent', () => {
    expect(parseSwitchPrompt(APPLIED_SCREEN)).toBeNull();
    expect(parseSwitchPrompt('')).toBeNull();
    expect(parseSwitchPrompt(null)).toBeNull();
  });

  it('does not match the plan or trust menus (guarded by the header)', () => {
    expect(parseSwitchPrompt(PLAN_MENU)).toBeNull();
    expect(parseSwitchPrompt(TRUST_MENU)).toBeNull();
  });

  it('isComposerReady is false while the switch dialog is up (so the no-dialog exit cannot fire)', () => {
    expect(isComposerReady(EFFORT_DIALOG)).toBe(false);
    expect(isComposerReady(MODEL_DIALOG)).toBe(false);
    expect(isComposerReady(APPLIED_SCREEN)).toBe(true);
  });
});
