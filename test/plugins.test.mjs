import { describe, it, expect } from 'vitest';
import { pluginArgs } from '../server/plugins.js';

describe('pluginArgs', () => {
  it('builds argv with scope and an options terminator', () => {
    expect(pluginArgs('install', { id: 'drawio@drawio', scope: 'project' }))
      .toEqual(['plugin', 'install', '--scope', 'project', '--', 'drawio@drawio']);
    expect(pluginArgs('marketplace-update', {})).toEqual(['plugin', 'marketplace', 'update']);
    expect(pluginArgs('marketplace-add', { source: ' anthropics/skills ' }))
      .toEqual(['plugin', 'marketplace', 'add', '--', 'anthropics/skills']);
  });

  it('rejects what the dashboard has no business sending', () => {
    expect(() => pluginArgs('install', { id: '--help' })).toThrow('invalid plugin id');
    expect(() => pluginArgs('install', { id: 'a b' })).toThrow('invalid plugin id');
    expect(() => pluginArgs('enable', { id: 'x', scope: 'managed' })).toThrow('invalid scope');
    expect(() => pluginArgs('eval', { id: 'x' })).toThrow('unknown action');
    expect(() => pluginArgs('marketplace-add', { source: '' })).toThrow('invalid marketplace source');
  });
});
