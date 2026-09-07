/*
 * Server-side session tags (server/tags.js) — round-trips through readTags / writeTags / setTags
 * on a throwaway HOOKED_DATA_DIR. Tags moved from per-browser localStorage to a shared server store.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'hooked-tags-test-' + process.pid);
process.env.HOOKED_DATA_DIR = TMP;

let readTags, writeTags, setTags;
beforeAll(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  ({ readTags, writeTags, setTags } = await import('../server/tags.js'));
});

describe('readTags', () => {
  it('defaults to an empty map when no file exists', () => {
    expect(readTags()).toEqual({});
  });
});

describe('setTags', () => {
  it('stores a session\'s tags and persists them', () => {
    const map = setTags('sess-1', ['review', 'urgent']);
    expect(map['sess-1']).toEqual(['review', 'urgent']);
    expect(readTags()['sess-1']).toEqual(['review', 'urgent']);
  });

  it('dedupes, trims, drops empties and caps length to 40 chars', () => {
    const long = 'x'.repeat(60);
    const map = setTags('sess-2', ['  a  ', 'a', '', '   ', long]);
    expect(map['sess-2']).toEqual(['a', 'x'.repeat(40)]);
  });

  it('removes the entry when the list is empty', () => {
    setTags('sess-3', ['tmp']);
    expect(readTags()['sess-3']).toEqual(['tmp']);
    const map = setTags('sess-3', []);
    expect(map['sess-3']).toBeUndefined();
    expect(readTags()['sess-3']).toBeUndefined();
  });

  it('rejects a non-string id', () => {
    expect(() => setTags(42, ['a'])).toThrow();
  });
});

describe('writeTags', () => {
  it('sanitizes the whole map and drops empty entries', () => {
    const map = writeTags({ a: ['x', 'x'], b: [], c: [123, 'ok'] });
    expect(map).toEqual({ a: ['x'], c: ['ok'] });
    expect(readTags()).toEqual({ a: ['x'], c: ['ok'] });
  });

  it('ignores non-object input', () => {
    expect(writeTags(null)).toEqual({});
    expect(writeTags('nope')).toEqual({});
  });
});
