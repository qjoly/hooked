/*
 * PORT / HOST are hooked's own HTTP server settings (adapter-node reads those names). They must
 * never reach the sessions hooked launches: a child dev server picks them up and ignores its own
 * flags — `ng serve --port 4201` prints `Environment variable "PORT" detected. Using port 4123`
 * and serves the dashboard's port instead.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-sessionenv-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;
process.env.HOOKED_PROJECTS_DIR = path.join(TMP, 'projects');
// Reproduce the service environment, which carries both (adapter-node reads those names).
process.env.PORT = '4123';
process.env.HOST = '127.0.0.1';

let agent;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(process.env.HOOKED_PROJECTS_DIR, { recursive: true });
  agent = await import('../server/agent.js');
});
afterAll(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

describe('withoutServerEnv', () => {
  it('drops PORT and HOST', () => {
    const out = agent.withoutServerEnv({ PORT: '4123', HOST: '127.0.0.1', PATH: '/usr/bin' });
    expect(out).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps the HOOKED_-prefixed settings, which sessions legitimately read', () => {
    const out = agent.withoutServerEnv({ HOOKED_PORT: '4123', HOOKED_MODE: 'prod' });
    expect(out).toEqual({ HOOKED_PORT: '4123', HOOKED_MODE: 'prod' });
  });

  it('does not mutate its input', () => {
    const src = { PORT: '4123' };
    agent.withoutServerEnv(src);
    expect(src.PORT).toBe('4123');
  });
});

describe('loginEnv', () => {
  it('hands sessions an environment free of PORT / HOST', async () => {
    const env = await agent.loginEnv();
    expect(env.PORT).toBeUndefined();
    expect(env.HOST).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  });
});
