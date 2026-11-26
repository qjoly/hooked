// Vite config that hooked-launcher passes to `vite build --config <this> --configLoader native`
// for a branch whose vite.config.js predates HOOKED_BUILD_OUT. It loads the branch's own config
// and swaps only the adapter-node instance for one that writes to $HOOKED_BUILD_OUT, so the build
// lands beside the running service's `build/` instead of over it.
//
// Why this works: SvelteKit 3's setup plugin exposes its validated config as `api.options`, and
// `process_config` reads and mutates that very object in its `config` hook, which Vite only calls
// after this file returned. Replacing `api.options.adapter` here is what the build uses.
//
// The launcher embeds this file and writes it to node_modules/.hooked-launcher/ before the build,
// so bare imports resolve to the branch's own packages. Any surprise throws before the adapter
// runs: adapter-node's first act is to delete its `out`.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import adapter from '@sveltejs/adapter-node';

const out = process.env.HOOKED_BUILD_OUT;
if (!out || path.resolve(out) === path.resolve('build')) {
  throw new Error(`hooked-launcher: HOOKED_BUILD_OUT must name a folder other than build/ (got ${out})`);
}

async function flatten(list) {
  const flat = [];
  for (const item of list ?? []) {
    const p = await item;
    if (Array.isArray(p)) flat.push(...(await flatten(p)));
    else if (p) flat.push(p);
  }
  return flat;
}

export default async (env) => {
  const own = await import(pathToFileURL(path.resolve('vite.config.js')).href);
  const config = typeof own.default === 'function' ? await own.default(env) : own.default;
  const plugins = await flatten(config.plugins);
  const options = plugins.find((p) => p.name === 'vite-plugin-sveltekit-setup')?.api?.options;
  if (!options) {
    throw new Error('hooked-launcher: no SvelteKit setup plugin exposes its options in vite.config.js');
  }
  if (options.adapter?.name !== '@sveltejs/adapter-node') {
    throw new Error(`hooked-launcher: expected @sveltejs/adapter-node, found ${options.adapter?.name}`);
  }
  // The branch's adapter options are out of reach; hooked passes none besides `out`.
  options.adapter = adapter({ out });
  return { ...config, plugins };
};
