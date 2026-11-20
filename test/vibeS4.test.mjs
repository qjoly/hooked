/*
 * S4 (PLAN_migration_mistral.md) : pages écosystème provider-aware.
 * - skills vibe (listSkills provider 'vibe'/'all', racines .vibe/skills + .agents/skills)
 * - cron : champ provider sur la tâche, passé à launchSession
 * - vibeCli : parse du stdout `vibe -p --output json` (fixture réelle capturée)
 * - settings defaultProvider ('claude' défaut, 'vibe' accepté)
 * - agentToolCatalog : guard vibe (plus de 500 via st.q)
 * - digests/autoTags/prWatch… : scanAllSessions (les sessions vibe entrent dans l'agrégation)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSkills, readSkill } from '../server/skills.js';
import { saveCronTask, readCronTasks, CRON_FILE } from '../server/cron.js';
import { vibeAssistantText, vibeModelJson } from '../server/vibeCli.js';
import { readSettings, writeSettings, SETTINGS_DEFAULTS } from '../server/settings.js';
import { scanAllSessions } from '../server/sessions.js';

const FIX = path.join(import.meta.dirname, 'fixtures');

describe('S4 — skills vibe', () => {
  let tmp;
  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s4-skills-'));
    const skillDir = path.join(tmp, '.vibe', 'skills', 'mon-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: mon-skill\ndescription: Test skill vibe\n---\n\nCorps du skill.\n');
    const agentsDir = path.join(tmp, '.agents', 'skills', 'agents-skill');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'SKILL.md'), '---\nname: agents-skill\ndescription: Skill .agents\n---\n');
  });
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it("listSkills(cwds, 'vibe') liste les skills .vibe/skills et .agents/skills du projet, provider=vibe", () => {
    const all = listSkills([tmp], 'vibe');
    const mine = all.find((s) => s.name === 'mon-skill');
    expect(mine).toBeTruthy();
    expect(mine.provider).toBe('vibe');
    expect(mine.source).toBe('project');
    expect(mine.project).toBe(tmp);
    expect(all.find((s) => s.name === 'agents-skill')).toBeTruthy();
  });
  it("listSkills(cwds, 'all') = claude + vibe ; défaut = claude seul (non-régression)", () => {
    const both = listSkills([tmp], 'all');
    expect(both.some((s) => s.provider === 'vibe' && s.name === 'mon-skill')).toBe(true);
    const def = listSkills([tmp]);
    expect(def.some((s) => s.provider === 'vibe')).toBe(false);
    expect(def.every((s) => s.provider === 'claude' || s.provider === undefined)).toBe(true);
  });
  it("readSkill retrouve le skill vibe par id avec son body", () => {
    const all = listSkills([tmp], 'vibe');
    const s = all.find((x) => x.name === 'mon-skill');
    const d = readSkill(s.id, [tmp], 'vibe');
    expect(d).toBeTruthy();
    expect(d.body).toContain('Corps du skill');
    expect(d.meta.description).toBe('Test skill vibe');
  });
});

describe('S4 — cron provider', () => {
  beforeAll(() => {
    process.env.HOOKED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-s4-cron-'));
  });
  afterAll(() => { delete process.env.HOOKED_DATA_DIR; });

  it('cleanTask garde provider vibe, défaut claude', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-s4-cwd-'));
    try {
      const t1 = saveCronTask({ name: 't1', schedule: '0 9 * * *', cwd: dir, prompt: 'hello', provider: 'vibe' });
      expect(t1.provider).toBe('vibe');
      const t2 = saveCronTask({ name: 't2', schedule: '0 9 * * *', cwd: dir, prompt: 'hello' });
      expect(t2.provider).toBe('claude'); // non-régression
      const stored = readCronTasks();
      expect(stored.find((t) => t.id === t1.id).provider).toBe('vibe');
      expect(stored.find((t) => t.id === t2.id).provider).toBe('claude');
      // update partiel : le provider est conservé
      const t3 = saveCronTask({ id: t1.id, name: 't1-renamed' });
      expect(t3.provider).toBe('vibe');
      expect(t3.name).toBe('t1-renamed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('S4 — vibeCli parse du headless (fixture réelle)', () => {
  it('vibeAssistantText extrait le dernier message assistant', () => {
    const stdout = fs.readFileSync(path.join(FIX, 'vibe-headless-output.json'), 'utf8');
    const text = vibeAssistantText(stdout);
    expect(text).toContain('{"ok": true}');
  });
  it('vibeModelJson parse le JSON produit par le modèle', () => {
    const stdout = fs.readFileSync(path.join(FIX, 'vibe-headless-output.json'), 'utf8');
    expect(vibeModelJson(stdout)).toEqual({ ok: true });
    expect(vibeAssistantText('pas du json')).toBe('pas du json');
    expect(vibeAssistantText('')).toBe('');
  });
});

describe('S4 — settings defaultProvider', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-s4-settings-'));
    process.env.HOOKED_DATA_DIR = dir;
  });
  afterAll(() => { delete process.env.HOOKED_DATA_DIR; });

  it("défaut 'claude', 'vibe' persisté, le reste retombe sur 'claude'", () => {
    expect(SETTINGS_DEFAULTS.defaultProvider).toBe('claude');
    expect(readSettings().defaultProvider).toBe('claude'); // settings vierges du tmp
    writeSettings({ ...readSettings(), defaultProvider: 'vibe' });
    expect(readSettings().defaultProvider).toBe('vibe');
    writeSettings({ ...readSettings(), defaultProvider: 'nope' });
    expect(readSettings().defaultProvider).toBe('claude');
  });
});

describe('S4 — agrégation scanAllSessions (digests/tags/watch incluent vibe)', () => {
  it('scanAllSessions inclut les sessions vibe des fixtures', () => {
    const all = scanAllSessions(path.join(FIX, 'projects'), path.join(FIX, 'vibe-session'));
    expect(all.some((s) => s.provider === 'vibe' && s.id === 'sess-abc123')).toBe(true);
    expect(all.some((s) => s.id === 'sess-alpha')).toBe(true);
  });
});
