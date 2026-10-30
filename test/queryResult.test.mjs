import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseQueryResult, readQueryResult } from '../server/queryResult.js';

const matrix = { status: 'success', data: { resultType: 'matrix', result: [
  { metric: { cluster: 'eu1', queue: 'active' }, values: [[100, '1'], [130, 'NaN']] },
  { metric: { cluster: 'eu1', queue: 'deferred' }, values: [[100, '2.5']] },
] } };

describe('grafana query results', () => {
  it('turns a matrix into series, without the labels every series shares', () => {
    expect(parseQueryResult(matrix)).toEqual({ kind: 'series', series: [
      { label: '{queue="active"}', points: [[100000, 1], [130000, NaN]] },
      { label: '{queue="deferred"}', points: [[100000, 2.5]] },
    ] });
  });

  it('turns a vector into rows and Loki streams into newest-first lines', () => {
    expect(parseQueryResult({ data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'a' }, value: [1, '3'] }] } }))
      .toEqual({ kind: 'table', rows: [{ label: 'up{job="a"}', value: 3 }] });
    const logs = parseQueryResult({ data: { resultType: 'streams', result: [{ stream: { detected_level: 'error' }, values: [['1000000000', 'a'], ['3000000000', 'b']] }] } });
    expect(logs.lines.map((l) => [l.t, l.level, l.line])).toEqual([[3000, 'error', 'b'], [1000, 'error', 'a']]);
  });

  it('reports the gateway error', () => {
    expect(parseQueryResult({ error: 'grafana returned HTTP 400', tool: 'grafana_query_loki' })).toEqual({ kind: 'error', error: 'grafana returned HTTP 400' });
  });

  it('reads a result the CLI saved to a file, and only for a Grafana query', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-q-'));
    const proj = path.join(root, '-p');
    fs.mkdirSync(path.join(proj, 's1', 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(proj, 's1', 'tool-results', 'big.txt'), JSON.stringify(matrix));
    const line = (content) => JSON.stringify({ message: { content } });
    fs.writeFileSync(path.join(proj, 's1.jsonl'), [
      line([{ type: 'tool_use', id: 'toolu_q', name: 'mcp__mcp-gateway__grafana_query_prometheus', input: { query: 'up', datasource: 'mimir' } }]),
      line([{ type: 'tool_result', tool_use_id: 'toolu_q', content: [{ type: 'text', text: 'Error: too big. Output has been saved to /elsewhere/tool-results/big.txt.' }] }]),
      line([{ type: 'tool_use', id: 'toolu_b', name: 'Bash', input: {} }]),
    ].join('\n'));
    const r = readQueryResult('s1', '', 'toolu_q', root);
    expect(r.tool).toBe('prometheus');
    expect(r.input.datasource).toBe('mimir');
    expect(r.data.series).toHaveLength(2);
    expect(readQueryResult('s1', '', 'toolu_b', root)).toBeNull();

    // The other saved format: the content blocks, as JSON, under the tool_use id.
    fs.writeFileSync(path.join(proj, 's1', 'tool-results', 'toolu_q2.json'), JSON.stringify([{ type: 'text', text: JSON.stringify(matrix) }]));
    fs.appendFileSync(path.join(proj, 's1.jsonl'), '\n' + [
      line([{ type: 'tool_use', id: 'toolu_q2', name: 'mcp__mcp-gateway__grafana_query_prometheus', input: {} }]),
      line([{ type: 'tool_result', tool_use_id: 'toolu_q2', content: '<persisted-output>\nFull output saved to: /x/tool-results/toolu_q2.json\n\nPreview (first 2KB):\n[' }]),
    ].join('\n'));
    expect(readQueryResult('s1', '', 'toolu_q2', root).data.series).toHaveLength(2);
  });
});
