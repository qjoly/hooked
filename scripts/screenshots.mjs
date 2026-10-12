#!/usr/bin/env node
// Regenerates docs/screenshots/*.jpg from a throwaway hooked instance fed with fictional data,
// so no real session ever ends up in the README. Needs Google Chrome installed (driven by
// playwright-core, no browser download).
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ROOT = path.join(import.meta.dirname, '..');
const DEMO = process.env.HOOKED_DEMO_DIR || path.join(os.tmpdir(), 'hooked-demo');
const PORT = process.env.SCREENSHOTS_PORT || '4199';
const BASE = `http://localhost:${PORT}`;
const OUT = path.join(ROOT, 'docs', 'screenshots');
const SESSION = '7f3a1c2e-0001-4a10-9c1e-aa0000000001'; // "Harden session token verification" in demo-data.cjs

execFileSync('node', [path.join(ROOT, 'scripts', 'demo-data.cjs')], { stdio: 'inherit', env: { ...process.env, HOOKED_DEMO_DIR: DEMO } });

// Every outbound or self-managing feature is switched off: this instance must only read the demo tree.
const vite = spawn('npx', ['vite', 'dev', '--port', PORT, '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
  detached: true,
  env: {
    ...process.env,
    HOOKED_PROJECTS_DIR: path.join(DEMO, 'projects'),
    HOOKED_DATA_DIR: path.join(DEMO, 'data'),
    HOOKED_CLAUDE_JSON: path.join(DEMO, 'claude.json'),
    HOOKED_SEARCH_DB: path.join(DEMO, 'data', 'search.db'),
    HOOKED_USAGE_FETCH: '0',
    HOOKED_OAUTH_TOKEN: 'demo',
    HOOKED_NO_RESUME: '1',
    HOOKED_GIT_SYNC_INTERVAL: '999999999',
    HOOKED_PR_REVIEW_INTERVAL: '999999999',
  },
});
const stopVite = () => { try { process.kill(-vite.pid); } catch {} };
process.on('exit', stopVite);

for (let i = 0; ; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch {}
  if (i > 60) throw new Error(`demo instance did not start on ${BASE}`);
  await new Promise((r) => setTimeout(r, 500));
}

const browser = await chromium.launch({ channel: 'chrome' });
// 1440 CSS px at 1.25x gives 1800 px wide images: sharp enough on GitHub, light enough for git.
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.25, locale: 'en-US' });
const page = await ctx.newPage();

async function shot(name, url, prep) {
  await page.goto(BASE + url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // The avatar shows the real account's initials, which have no place in the docs.
  await page.evaluate(() => {
    const a = document.querySelector('.tb-avatar');
    if (a) { a.firstChild.textContent = 'AC'; a.title = ''; }
  });
  if (prep) await prep();
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82 });
  console.log('captured', name);
}

await shot('deck', '/');
await shot('converse', `/session/${SESSION}`);
await shot('review', `/session/${SESSION}?lens=review`, () => page.waitForTimeout(1500));
await shot('stats', '/stats');
await shot('palette', '/', async () => { await page.keyboard.press('ControlOrMeta+p'); await page.waitForTimeout(500); });
await shot('new', '/new');

await browser.close();
stopVite();
