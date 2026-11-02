import { describe, it, expect } from 'vitest';
import { fenceQuery, mdSegments } from '../src/lib/format.js';

describe('promql / logql fences', () => {
  it('reads the view options off the info-string', () => {
    const [seg] = mdSegments('```promql datasource=mimir-prod range=6h step=5m\nsum(up)\n```');
    expect(fenceQuery(seg.lang, seg.meta, seg.code)).toEqual({
      tool: 'prometheus', datasource: 'mimir-prod', query: 'sum(up)', range: '6h', step: '5m', refresh: 30,
    });
    expect(fenceQuery('logql', { ds: 'loki-prod', limit: '50' }, '{a="b"}')).toMatchObject({ tool: 'loki', datasource: 'loki-prod', range: '1h', limit: 50 });
  });

  it('has no view without a datasource or for another language', () => {
    expect(fenceQuery('promql', {}, 'up')).toBeNull();
    expect(fenceQuery('sql', { datasource: 'x' }, 'select 1')).toBeNull();
  });
});
