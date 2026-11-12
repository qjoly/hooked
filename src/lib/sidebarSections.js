import { needsDecision } from './format.js';

export const SECTIONS = [
  { key: 'waiting', label: 'Waiting', icon: 'attention' },
  { key: 'working', label: 'Working', icon: 'working', folded: true },
  { key: 'idle', label: 'Idle', icon: 'idle', folded: true, window: 15 },
  { key: 'snoozed', label: 'Snoozed', icon: 'snooze', folded: true, docked: true },
  { key: 'archived', label: 'Archived', icon: 'archive', folded: true, docked: true, window: 25 },
];

const isBusy = (s) => s.state === 'working' || s.state === 'background';

export function sectionOf(members, { archived, snoozed }) {
  if (members.every(archived)) return 'archived';
  const live = members.filter((s) => !archived(s));
  if (live.every(snoozed)) return 'snoozed';
  const awake = live.filter((s) => !snoozed(s));
  if (awake.some(needsDecision)) return 'waiting';
  if (awake.some(isBusy)) return 'working';
  return 'idle';
}

const at = (base, days, hour) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

export function snoozePresets(now = Date.now()) {
  const day = new Date(now).getDay();
  const toMonday = ((8 - day) % 7) || 7;
  const out = [
    { label: '1 hour', until: now + 3600_000 },
    { label: '3 hours', until: now + 3 * 3600_000 },
  ];
  if (at(now, 0, 18) - now > 3 * 3600_000) out.push({ label: 'This evening', until: at(now, 0, 18) });
  out.push({ label: 'Tomorrow', until: at(now, 1, 9) });
  if (toMonday > 1) out.push({ label: 'Monday', until: at(now, toMonday, 9) });
  return out;
}

export const hm = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function wakeLabel(until, now = Date.now()) {
  const d = new Date(until);
  const days = Math.round((at(until, 0, 0) - at(now, 0, 0)) / 86400_000);
  if (days <= 0) return hm(d);
  if (days === 1) return 'tmrw ' + hm(d);
  if (days < 7) return WEEKDAYS[d.getDay()] + ' ' + hm(d);
  return `${d.getDate()}/${d.getMonth() + 1}`;
}
