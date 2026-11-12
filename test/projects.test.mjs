import { describe, it, expect } from 'vitest';
import { knownProjects } from '../src/lib/projects.js';

describe('knownProjects', () => {
  it('folds linked worktrees into their main checkout', () => {
    const out = knownProjects([
      { project: '/r/hooked', projectName: 'hooked', lastActivity: '2026-01-01' },
      { project: '/h/worktrees/ea0a2be0', projectName: 'ea0a2be0', worktreeOf: '/r/hooked', lastActivity: '2026-02-01' },
    ]);
    expect(out).toEqual([['/r/hooked', 'hooked', false]]);
  });

  it('names a repo seen only through worktrees after its folder', () => {
    const out = knownProjects([{ project: '/h/worktrees/x', projectName: 'x', worktreeOf: '/r/radar' }]);
    expect(out).toEqual([['/r/radar', 'radar', false]]);
  });

  it('puts favorites first, then the most recent activity', () => {
    const out = knownProjects([
      { project: '/a', projectName: 'a', lastActivity: '2026-03-01' },
      { project: '/b', projectName: 'b', lastActivity: '2026-01-01' },
    ], ['/b', '/c']);
    expect(out.map(([cwd]) => cwd)).toEqual(['/b', '/c', '/a']);
  });
});
