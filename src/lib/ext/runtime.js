// The shared runtime of compiled extension pages (server/extensionPages.js): every import of
// `svelte`, `svelte/*` or `@hooked/ext/ui` in a page reads this object, so the page runs on the
// dashboard's own Svelte instance (one reactivity graph, one context tree).
import * as svelte from 'svelte';
import * as internalClient from 'svelte/internal/client';
import * as store from 'svelte/store';
import * as reactivity from 'svelte/reactivity';
import * as transition from 'svelte/transition';
import * as animate from 'svelte/animate';
import * as easing from 'svelte/easing';
import * as motion from 'svelte/motion';
import * as events from 'svelte/events';
import * as attachments from 'svelte/attachments';
import * as ui from './ui.js';

globalThis.__hookedExt = {
  svelte,
  'svelte/internal/client': internalClient,
  // Side-effect-only modules the compiler emits: the dashboard's own components already ran them.
  'svelte/internal/disclose-version': {},
  'svelte/internal/init-operations': {},
  'svelte/store': store,
  'svelte/reactivity': reactivity,
  'svelte/transition': transition,
  'svelte/animate': animate,
  'svelte/easing': easing,
  'svelte/motion': motion,
  'svelte/events': events,
  'svelte/attachments': attachments,
  '@hooked/ext/ui': ui,
};
