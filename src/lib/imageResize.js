// Client-side shrinking of pasted / dropped images before upload.
//
// A full-resolution Retina screenshot easily weighs 5-10 MB as PNG, which becomes 7-14 MB once
// base64-encoded in the JSON body. Claude downsizes anything past ~1568 px on the long edge
// anyway, so sending more pixels only costs upload time and disk. We cap the long edge at
// MAX_EDGE and re-encode as WebP (JPEG where the browser can't encode WebP), while small images
// that already fit go through untouched (a crisp PNG of a small UI crop stays a PNG).

export const MAX_EDGE = 2560;
// Below this size, an image that already fits MAX_EDGE is sent as is.
export const KEEP_BYTES = 1.5 * 1024 * 1024;
// Hard ceiling on the decoded upload, mirrored by server/images.js.
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const QUALITIES = [0.9, 0.8, 0.65];

// Pure: target dimensions keeping the aspect ratio, long edge capped at `maxEdge`.
export function fitWithin(width, height, maxEdge = MAX_EDGE) {
  const w = Math.max(1, Math.round(width || 0));
  const h = Math.max(1, Math.round(height || 0));
  const long = Math.max(w, h);
  if (long <= maxEdge) return { width: w, height: h, scaled: false };
  const k = maxEdge / long;
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true };
}

// Pure: should this image be re-encoded? GIFs are kept (re-encoding would drop the animation).
export function needsShrink({ type, size, width, height }, maxEdge = MAX_EDGE, keepBytes = KEEP_BYTES) {
  if (type === 'image/gif') return false;
  return Math.max(width, height) > maxEdge || size > keepBytes;
}

// Pure: decoded byte size of a base64 data-URL (what the server checks against 15 MB).
export function dataUrlBytes(dataUrl) {
  const i = String(dataUrl).indexOf(',');
  if (i < 0) return 0;
  const b64 = dataUrl.length - i - 1;
  const pad = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64 * 3) / 4) - pad);
}

export const formatBytes = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

function readAsDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('cannot read image'));
    r.readAsDataURL(blob);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cannot decode image'));
    img.src = src;
  });
}

// Browser-only: File/Blob → { dataUrl, bytes, resized }. Throws with a readable message when the
// result still exceeds MAX_UPLOAD_BYTES.
export async function prepareImage(file) {
  const original = await readAsDataUrl(file);
  let img = null;
  try { img = await loadImage(original); } catch (_) { /* undecodable: let the server judge it */ }
  const w = img ? img.naturalWidth : 0;
  const h = img ? img.naturalHeight : 0;
  let best = { dataUrl: original, bytes: file.size || dataUrlBytes(original), resized: false };

  if (img && needsShrink({ type: file.type, size: best.bytes, width: w, height: h })) {
    const dim = fitWithin(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = dim.width;
    canvas.height = dim.height;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, dim.width, dim.height);
    // Safari < 17 silently returns PNG for image/webp: detect it and fall back to JPEG
    // (JPEG has no alpha, so paint white under transparent pixels first).
    let type = canvas.toDataURL('image/webp', 0.9).startsWith('data:image/webp') ? 'image/webp' : 'image/jpeg';
    if (type === 'image/jpeg') {
      ctx.globalCompositeOperation = 'destination-over';
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, dim.width, dim.height);
    }
    for (const q of QUALITIES) {
      const dataUrl = canvas.toDataURL(type, q);
      const bytes = dataUrlBytes(dataUrl);
      // keep the re-encode only when it actually helps (or the pixel cap forced it)
      if (dim.scaled || bytes < best.bytes) best = { dataUrl, bytes, resized: true };
      if (bytes <= KEEP_BYTES) break;
    }
  }

  if (best.bytes > MAX_UPLOAD_BYTES) {
    throw new Error(`image too large (${formatBytes(best.bytes)}, max ${formatBytes(MAX_UPLOAD_BYTES)})`);
  }
  return best;
}
