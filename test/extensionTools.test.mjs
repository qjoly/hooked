/*
 * The prompt cache across the move to extensions: with every module and extension on, the tools a
 * new session gets (names, descriptions, schemas, order) are byte-identical to those captured on
 * origin/main before Cron became an extension (test/fixtures/extension-tools/), for the MCP server
 * (Claude, ACP) and for hooked's pi package.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hooked-ext-tools-'));
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_EXTENSIONS_DIR = path.join(TMP, 'installed');
delete process.env.HOOKED_BUNDLED_EXTENSIONS_DIR;

const require = createRequire(import.meta.url);
const FX = path.join(import.meta.dirname, 'fixtures', 'extension-tools');
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));
const ext = await import('../server/extensions.js');
const { registerHookedTools } = await import('../pi-package/extensions/tools.js');
const mcp = require('../mcp/server.cjs');

beforeAll(async () => { await ext.bootExtensions({ service: false }); }, 30000);

describe('tool invariance', () => {
  it('the bundled extensions loaded with no error', () => {
    const { extensions, rejected } = ext.listExtensions();
    expect(rejected).toEqual([]);
    expect(extensions.find((e) => e.id === 'cron')).toMatchObject({ active: true, errors: [] });
  });

  it('MCP: same tools, same order, same bytes', () => {
    const served = [...mcp.TOOLS, ...mcp.extensionTools(ext.sessionToolFiles('id').join(','))]
      .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    expect(JSON.stringify(served, null, 1) + '\n').toBe(fs.readFileSync(path.join(FX, 'mcp.json'), 'utf8'));
  });

  it('pi: same tools, same order, same bytes', () => {
    const registered = [];
    const pi = { registerTool: (t) => registered.push({ name: t.name, label: t.label, description: t.description, parameters: t.parameters }) };
    registerHookedTools(pi, mcp.TOOLS, mcp.resultFrom);
    registerHookedTools(pi, mcp.extensionTools(ext.sessionToolFiles('page').join(',')), mcp.resultFrom);
    expect(registered).toEqual(fixture('pi.json'));
  });

  it('an extension switched off drops its tools from new sessions only', () => {
    const off = { extensions: { cron: false } };
    const names = mcp.extensionTools(ext.sessionToolFiles('id', off).join(',')).map((t) => t.name);
    expect(names).not.toContain('list_cron_tasks');
    expect(names).toContain('flow_report');
  });
});
