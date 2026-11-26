// hooked's Flows module for pi: the module's tools (../tools.cjs) as native `hooked_*` tools.
import { createRequire } from 'node:module';
import { registerHookedTools } from '../../../pi-package/extensions/tools.js';

const require = createRequire(import.meta.url);
const { tools } = require('../tools.cjs');
const { resultFrom } = require('../../../mcp/http.cjs');

export default function flowsModule(pi) {
  registerHookedTools(pi, tools, resultFrom);
}
