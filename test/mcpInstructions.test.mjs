/*
 * The hooked MCP server's `instructions` (initialize result), which the CLI adds to the system prompt
 * of every session that loads the server. They ask Claude to fence the commands it proposes as
 * `bash`, the language that gets CodeBlock's Run button.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';

const initialize = () => new Promise((resolve, reject) => {
  const child = execFile('node', ['mcp/server.cjs'], { timeout: 10_000 },
    (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout.split('\n')[0]).result)));
  child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
});

describe('MCP server instructions', () => {
  it('ask Claude to fence the commands it proposes as bash', async () => {
    const { instructions } = await initialize();
    expect(instructions).toContain('```bash');
  });
});
