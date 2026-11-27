/*
 * The server facade of extensions (docs/extensions.md): everything an extension gets from the core
 * comes through this object, never through an import, so an extension installed outside the checkout
 * resolves nothing from it. Its names are part of the contract (EXTENSION_API): removing or changing
 * one bumps the version, adding one does not. test/extensionPages.test.mjs pins them.
 *
 * Kept out of the server/index.js barrel on purpose: an ambiguous `export *` would silently drop a
 * name from it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOKED_DIR, LAUNCH_PERMISSION_MODES } from '../config.js';
import { readSettings } from '../settings.js';
import { launchSession, killSession, deliverReply, agentAlive, agentBusy, agentPendingAsk, err400 } from '../agent.js';
import { readTags, setTags } from '../tags.js';
import { json } from '@sveltejs/kit';
import { ok, fail, readJson, toPromise } from '../../src/lib/server/respond.js';

const EXTENSION_API = 1;

// `settings` reads the extension's declarative values; the registry owns that file.
function buildContext({ id, service, settings }) {
  const dataDir = path.join(HOOKED_DIR, 'extension-data', id);
  return Object.freeze({
    id,
    api: EXTENSION_API,
    service: !!service,
    hookedDir: HOOKED_DIR,
    get dataDir() {
      fs.mkdirSync(dataDir, { recursive: true });
      return dataDir;
    },
    settings,
    hookedSettings: readSettings,
    LAUNCH_PERMISSION_MODES,
    launchSession, killSession, deliverReply, agentAlive, agentBusy, agentPendingAsk, readTags, setTags,
    json, ok, fail, err400, readJson, toPromise,
    log: (...args) => console.log(`[hooked] extension ${id}:`, ...args),
  });
}

export { EXTENSION_API, buildContext };
