import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSkillMd, listSkills, readSkill } from '../server/skills.js';

describe('parseSkillMd', () => {
  it('reads quoted scalars and folded multi-line descriptions', () => {
    const { meta, body } = parseSkillMd('---\nname: "demo"\ndescription: >\n  First line\n  second line\n---\n# Body\n');
    expect(meta).toEqual({ name: 'demo', description: 'First line second line' });
    expect(body).toBe('# Body');
  });

  it('keeps a file without frontmatter as body', () => {
    expect(parseSkillMd('just text')).toEqual({ meta: {}, body: 'just text' });
  });
});

describe('project skills', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-skills-'));
  const dir = path.join(cwd, '.claude', 'skills', 'deploy');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nRun the script.');
  fs.writeFileSync(path.join(dir, 'scripts', 'go.sh'), 'echo go');
  fs.symlinkSync(dir, path.join(cwd, '.claude', 'skills', 'linked'));

  it('lists skills of the given projects, following symlinks', () => {
    const mine = listSkills([cwd]).filter((s) => s.project === cwd);
    expect(mine.map((s) => s.name).sort()).toEqual(['deploy', 'deploy']);
    expect(mine[0]).toMatchObject({ source: 'project', description: 'Ship it' });
  });

  it('reads a listed skill with its bundled files', () => {
    const d = readSkill(path.join(dir, 'SKILL.md'), [cwd]);
    expect(d.body).toBe('Run the script.');
    expect(d.files).toEqual([path.join('scripts', 'go.sh')]);
  });

  it('refuses an id that is not in the listing', () => {
    expect(readSkill('/etc/passwd', [cwd])).toBeNull();
  });
});

describe('home directory as a project', () => {
  it('keeps user skills once, as user skills', () => {
    const all = listSkills([os.homedir()]);
    expect(new Set(all.map((s) => s.id)).size).toBe(all.length);
    expect(all.some((s) => s.source === 'project' && s.project === os.homedir())).toBe(false);
  });
});
