/**
 * Vertical screenshot stitching (inspired by receipt-style Uma scroll captures).
 * Heuristic overlap search on grayscale — not a port of lt900ed/receipt_factor OpenCV pipeline.
 */
import sharp from 'sharp';

const MAX_IMAGES = 8;
const MAX_PERMUTATIONS = 5040; // 7!
const COARSE_STEP = 6;
const BAD_MAE = 22;

function luminanceAt(data, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

/**
 * Trim near-black letterboxing (PC window borders / pillarboxing).
 */
async function trimLetterbox(buf) {
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const threshold = 12;

  let top = 0;
  while (top < h) {
    let dark = 0;
    for (let x = 0; x < w; x += 4) {
      if (luminanceAt(data, w, x, top) < threshold) dark++;
    }
    if (dark < w * 0.88) break;
    top++;
  }

  let bottom = h - 1;
  while (bottom > top) {
    let dark = 0;
    for (let x = 0; x < w; x += 4) {
      if (luminanceAt(data, w, x, bottom) < threshold) dark++;
    }
    if (dark < w * 0.88) break;
    bottom--;
  }

  let left = 0;
  while (left < w) {
    let dark = 0;
    for (let y = top; y <= bottom; y += 4) {
      if (luminanceAt(data, w, left, y) < threshold) dark++;
    }
    if (dark < (bottom - top) * 0.88) break;
    left++;
  }

  let right = w - 1;
  while (right > left) {
    let dark = 0;
    for (let y = top; y <= bottom; y += 4) {
      if (luminanceAt(data, w, right, y) < threshold) dark++;
    }
    if (dark < (bottom - top) * 0.88) break;
    right--;
  }

  const tw = right - left + 1;
  const th = bottom - top + 1;
  if (tw < w * 0.5 || th < h * 0.5) return buf;

  return sharp(buf).extract({ left, top, width: tw, height: th }).png().toBuffer();
}

async function toResizePng(buf, targetWidth) {
  return sharp(buf)
    .resize({ width: targetWidth, fit: 'fill' })
    .png()
    .toBuffer();
}

async function loadGray(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { gray: new Uint8Array(data), w: info.width, h: info.height };
}

/**
 * Best vertical overlap: bottom `overlap` rows of `top` vs top `overlap` rows of `bottom`.
 * Uses horizontal center band for robustness.
 */
function scoreOverlap(top, bot, overlap, x0, bandW) {
  const { gray: g0, w: w0, h: h0 } = top;
  const { gray: g1, w: w1, h: h1 } = bot;
  if (overlap > h0 || overlap > h1 || overlap < 8) return Number.POSITIVE_INFINITY;

  let sum = 0;
  const n = overlap * bandW;
  const y0 = h0 - overlap;
  for (let dy = 0; dy < overlap; dy++) {
    const row0 = (y0 + dy) * w0;
    const row1 = dy * w1;
    for (let dx = 0; dx < bandW; dx++) {
      const a = g0[row0 + x0 + dx];
      const b = g1[row1 + x0 + dx];
      sum += Math.abs(a - b);
    }
  }
  return sum / n;
}

function findBestOverlap(top, bot) {
  const w = Math.min(top.w, bot.w);
  const h0 = top.h;
  const h1 = bot.h;
  const bandW = Math.max(32, Math.floor(w * 0.65));
  const x0 = Math.floor((w - bandW) / 2);

  const maxO = Math.min(Math.floor(Math.min(h0, h1) * 0.62), 1400);
  const minO = Math.max(24, Math.floor(Math.min(h0, h1) * 0.06));

  let bestO = minO;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let o = minO; o <= maxO; o += COARSE_STEP) {
    const s = scoreOverlap(top, bot, o, x0, bandW);
    if (s < bestScore) {
      bestScore = s;
      bestO = o;
    }
  }

  const refineLo = Math.max(minO, bestO - COARSE_STEP);
  const refineHi = Math.min(maxO, bestO + COARSE_STEP);
  for (let o = refineLo; o <= refineHi; o++) {
    const s = scoreOverlap(top, bot, o, x0, bandW);
    if (s < bestScore) {
      bestScore = s;
      bestO = o;
    }
  }

  if (bestScore > BAD_MAE) {
    return { overlap: 0, mae: bestScore };
  }
  return { overlap: bestO, mae: bestScore };
}

function factorial(n) {
  let x = 1;
  for (let i = 2; i <= n; i++) x *= i;
  return x;
}

/** Brute-force best Hamiltonian path order (n ≤ 7 keeps cost bounded). */
function permuteOrder(n, pairCost) {
  if (n <= 1) return [0];
  if (factorial(n) > MAX_PERMUTATIONS) return null;

  const p = [...Array(n).keys()];
  let best = p.slice();
  let bestCost = Number.POSITIVE_INFINITY;

  function rec(start) {
    if (start === n) {
      let c = 0;
      for (let i = 0; i < n - 1; i++) c += pairCost[p[i]][p[i + 1]];
      if (c < bestCost) {
        bestCost = c;
        best = p.slice();
      }
      return;
    }
    for (let i = start; i < n; i++) {
      [p[start], p[i]] = [p[i], p[start]];
      rec(start + 1);
      [p[start], p[i]] = [p[i], p[start]];
    }
  }

  rec(0);
  return best;
}

/**
 * @param {string[]} urls - HTTPS image URLs (e.g. Discord CDN)
 * @param {{ autoOrder?: boolean, trimEdges?: boolean }} opts
 * @returns {Promise<{ buffer: Buffer, filename: string, mime: string, overlaps: number[], order: number[] }>}
 */
export async function stitchScreenshots(urls, opts = {}) {
  const autoOrder = opts.autoOrder !== false;
  const trimEdges = opts.trimEdges !== false;

  if (!urls?.length) {
    throw new Error('No images provided.');
  }
  if (urls.length > MAX_IMAGES) {
    throw new Error(`At most ${MAX_IMAGES} images.`);
  }

  const fetched = await Promise.all(
    urls.map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch image (${res.status})`);
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    })
  );

  let bufs = fetched;
  if (trimEdges) {
    bufs = await Promise.all(bufs.map((b) => trimLetterbox(b)));
  }

  const widths = await Promise.all(bufs.map((b) => sharp(b).metadata().then((m) => m.width || 0)));
  const targetW = Math.min(...widths);
  if (targetW < 120) {
    throw new Error('Images are too small after trimming.');
  }

  const pngs = await Promise.all(bufs.map((b) => toResizePng(b, targetW)));
  const grays = await Promise.all(pngs.map((p) => loadGray(p)));

  const n = pngs.length;
  let order = [...Array(n).keys()];

  if (autoOrder && n > 1) {
    const pairCost = Array.from({ length: n }, () => Array(n).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) {
          pairCost[i][j] = 0;
          continue;
        }
        const { overlap, mae } = findBestOverlap(grays[i], grays[j]);
        pairCost[i][j] = overlap === 0 ? 1e6 : mae * 1000;
      }
    }

    const perm = permuteOrder(n, pairCost);
    if (perm) {
      order = perm;
    }
  }

  const overlaps = [];
  for (let k = 0; k < n - 1; k++) {
    const a = grays[order[k]];
    const b = grays[order[k + 1]];
    const { overlap } = findBestOverlap(a, b);
    overlaps.push(overlap);
  }

  const metas = await Promise.all(pngs.map((p) => sharp(p).metadata()));
  const heights = order.map((i) => metas[i].height || 0);
  const totalH = heights[0] + overlaps.reduce((acc, o, k) => acc + heights[k + 1] - o, 0);

  const channels = 4;
  const out = Buffer.alloc(targetW * totalH * channels, 0);

  async function blitPngAt(pngBuf, dstY) {
    const { data, info } = await sharp(pngBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const sw = info.width;
    const sh = info.height;
    for (let y = 0; y < sh; y++) {
      const srcRow = y * sw * 4;
      const dstRow = (dstY + y) * targetW * 4;
      for (let x = 0; x < sw; x++) {
        const si = srcRow + x * 4;
        const di = dstRow + x * 4;
        out[di] = data[si];
        out[di + 1] = data[si + 1];
        out[di + 2] = data[si + 2];
        out[di + 3] = data[si + 3];
      }
    }
  }

  let y = 0;
  for (let k = 0; k < n; k++) {
    const idx = order[k];
    await blitPngAt(pngs[idx], y);
    if (k < n - 1) {
      y += heights[k] - overlaps[k];
    }
  }

  let buffer = await sharp(out, { raw: { width: targetW, height: totalH, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  let filename = 'uma_receipt.png';
  let mime = 'image/png';

  if (buffer.length > 7_500_000) {
    buffer = await sharp(out, { raw: { width: targetW, height: totalH, channels: 4 } })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();
    filename = 'uma_receipt.jpg';
    mime = 'image/jpeg';
  }

  return { buffer, filename, mime, overlaps, order };
}
