/*
 * Pasted image uploads: the pure sizing helpers the composer runs before upload
 * (src/lib/imageResize.js) and the error the route returns when the body limit bites.
 */
import { describe, it, expect } from 'vitest';
import { fitWithin, needsShrink, dataUrlBytes, MAX_EDGE, KEEP_BYTES } from '../src/lib/imageResize.js';
import { POST } from '../src/routes/api/upload-image/+server.js';

describe('fitWithin', () => {
  it('leaves images that already fit untouched', () => {
    expect(fitWithin(1200, 800)).toEqual({ width: 1200, height: 800, scaled: false });
    expect(fitWithin(MAX_EDGE, 100)).toEqual({ width: MAX_EDGE, height: 100, scaled: false });
  });
  it('caps the long edge and keeps the aspect ratio', () => {
    // 5K Retina screenshot
    expect(fitWithin(5120, 2880)).toEqual({ width: 2560, height: 1440, scaled: true });
    // portrait
    expect(fitWithin(3000, 6000)).toEqual({ width: 1280, height: 2560, scaled: true });
  });
  it('never returns a zero dimension', () => {
    expect(fitWithin(100000, 10)).toEqual({ width: 2560, height: 1, scaled: true });
  });
});

describe('needsShrink', () => {
  it('re-encodes oversized pixels or bytes, keeps small images and GIFs', () => {
    expect(needsShrink({ type: 'image/png', size: 200_000, width: 800, height: 600 })).toBe(false);
    expect(needsShrink({ type: 'image/png', size: 200_000, width: 3024, height: 1964 })).toBe(true);
    expect(needsShrink({ type: 'image/png', size: KEEP_BYTES + 1, width: 800, height: 600 })).toBe(true);
    expect(needsShrink({ type: 'image/gif', size: 9e6, width: 4000, height: 3000 })).toBe(false);
  });
});

describe('dataUrlBytes', () => {
  it('computes the decoded size of a base64 data-URL', () => {
    for (const n of [0, 1, 2, 3, 100, 1001]) {
      const url = 'data:image/png;base64,' + Buffer.alloc(n, 7).toString('base64');
      expect(dataUrlBytes(url)).toBe(n);
    }
  });
});

describe('POST /api/upload-image', () => {
  const req = (json) => ({ json });
  it('names the body limit when adapter-node rejects the payload', async () => {
    const e = Object.assign(new Error('request body size exceeded BODY_SIZE_LIMIT'), { status: 413 });
    const res = await POST({ request: req(() => Promise.reject(e)) });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toMatch(/too large.*BODY_SIZE_LIMIT/);
  });
  it('rejects a malformed body and a missing image', async () => {
    expect((await POST({ request: req(() => Promise.reject(new SyntaxError('bad'))) })).status).toBe(400);
    const res = await POST({ request: req(() => Promise.resolve({})) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid image');
  });
});
