/*
 * Auto-complétion « / » côté provider vibe (server/vibeCommands.js) :
 * prompts .vibe/prompts, skills user-invocables, built-in Vibe, liste live ACP.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vibeSlashCommands, vibeBuiltinCommands, vibePromptCommands, vibeSkillCommands } from '../server/index.js';
import { matchCommands } from '../server/index.js';

function makeCwd() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-cmd-'));
  fs.mkdirSync(path.join(dir, '.vibe', 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vibe', 'prompts', 'deploy.md'), '---\ndescription: Deploy the app\n---\n# Deploy\n');
  fs.mkdirSync(path.join(dir, '.vibe', 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vibe', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\nuser-invocable: true\n---\n');
  fs.mkdirSync(path.join(dir, '.vibe', 'skills', 'hidden'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.vibe', 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\ndescription: not invocable\nuser-invocable: false\n---\n');
  return dir;
}

describe('vibeCommands', () => {
  it('prompts du projet en group custom, skills user-invocables en group skill (hidden exclu)', () => {
    const dir = makeCwd();
    try {
      const prompts = vibePromptCommands(dir);
      expect(prompts).toEqual([{ name: 'deploy', description: 'Deploy the app', group: 'custom' }]);
      const skills = vibeSkillCommands(dir);
      expect(skills.map((s) => s.name)).toContain('demo');
      expect(skills.map((s) => s.name)).not.toContain('hidden');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('vibeSlashCommands fusionne custom + skills + builtin + live, sans doublon', () => {
    const dir = makeCwd();
    try {
      const all = vibeSlashCommands(dir, [{ name: 'model', description: 'live override' }, { name: 'loop', description: 'x' }]);
      const names = all.map((c) => c.name);
      expect(names).toContain('deploy');
      expect(names).toContain('help');
      expect(names).toContain('loop');
      expect(names.filter((n) => n === 'model')).toHaveLength(1); // pas de doublon builtin/live
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin Vibe couvre les commandes internes usuelles', () => {
    const names = vibeBuiltinCommands().map((c) => c.name);
    for (const n of ['help', 'model', 'thinking', 'resume', 'mcp', 'skills', 'compact', 'exit']) {
      expect(names).toContain(n);
    }
  });

  it('matchCommands filtre sur le nom', () => {
    const all = vibeSlashCommands(null, null);
    const hits = matchCommands(all, 'mod');
    expect(hits[0].name).toBe('model');
  });
});
