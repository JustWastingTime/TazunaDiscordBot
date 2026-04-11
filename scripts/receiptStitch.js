/**
 * Vertical screenshot stitching (inspired by receipt-style Uma scroll captures).
 * Heuristic overlap search on grayscale — not a port of lt900ed/receipt_factor OpenCV pipeline.
 */
import sharp from 'sharp';

const MAX_IMAGES = 8;
const MAX_PERMUTATIONS = 5040; // 7!
/** Above this mean abs diff (0–255) on grayscale band, treat match as failed. */
const BAD_MAE = 38;

/**
 * PC / Steam landscape shots: details modal on the left, blurred menu on the right.
 * Crop to the high-detail column so overlap is not driven by identical blur + so output matches receipt-style strip.
 */
async function cropUmaDetailsStrip(buf) {
  const meta = await sharp(buf).metadata();
  const W = meta.width || 0;
  const H = meta.height || 0;
  if (W < 500 || H < 400) return buf;

  const isLandscape = W > H * 0.95;
  if (!isLandscape) return buf;

  const scanW = Math.min(960, W);
  const { data, info } = await sharp(buf)
    .resize({ width: scanW })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width;
  const h = info.height;
  const g = new Uint8Array(data);
  const skipTop = Math.min(90, Math.floor(h * 0.055));

  const colVar = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let sum2 = 0;
    let n = 0;
    for (let y = skipTop; y < h; y += 3) {
      const v = g[y * w + x];
      sum += v;
      sum2 += v * v;
      n++;
    }
    const mean = sum / n;
    colVar[x] = sum2 / n - mean * mean;
  }

  let refMax = 0;
  const refL = Math.floor(w * 0.06);
  const refR = Math.floor(w * 0.34);
  for (let x = refL; x < refR; x++) {
    refMax = Math.max(refMax, colVar[x]);
  }

  if (refMax < 220) {
    const cw = Math.min(W, Math.floor(W * 0.47));
    return sharp(buf).extract({ left: 0, top: 0, width: cw, height: H }).png().toBuffer();
  }

  const threshold = Math.max(110, refMax * 0.2);
  const runNeed = Math.max(18, Math.floor(w * 0.022));
  let rightScan = Math.floor(w * 0.46);
  let run = 0;
  for (let x = Math.floor(w * 0.28); x < Math.floor(w * 0.58); x++) {
    if (colVar[x] < threshold) {
      run++;
      if (run >= runNeed) {
        rightScan = x - runNeed + 1;
        break;
      }
    } else {
      run = 0;
    }
  }

  const minPanelOrig = Math.floor(W * 0.24);
  const maxPanelOrig = Math.floor(W * 0.56);
  let cropW = Math.round((rightScan * W) / scanW);
  cropW = Math.min(maxPanelOrig, Math.max(minPanelOrig, cropW));
  cropW = Math.min(W, cropW);

  if (cropW < minPanelOrig) {
    cropW = Math.min(W, Math.floor(W * 0.47));
  }

  return sharp(buf).extract({ left: 0, top: 0, width: cropW, height: H }).png().toBuffer();
}

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
    .resize({ width: targetWidth })
    .png()
    .toBuffer();
}

async function loadGray(buf) {
  const { data, info } = await sharp(buf).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { gray: new Uint8Array(data), w: info.width, h: info.height };
}

/**
 * Best vertical overlap: bottom `overlap` rows of `top` vs top `overlap` rows of `bottom`.
 * Uses a wide center band; `hShift` nudges horizontally for slight crop misalignment.
 */
function scoreOverlap(top, bot, overlap, x0, bandW, hShift) {
  const { gray: g0, w: w0, h: h0 } = top;
  const { gray: g1, w: w1, h: h1 } = bot;
  if (overlap > h0 || overlap > h1 || overlap < 4) return Number.POSITIVE_INFINITY;

  const xT = Math.max(0, Math.min(w0 - bandW, x0 + hShift));
  const xB = Math.max(0, Math.min(w1 - bandW, x0 + hShift));

  let sum = 0;
  const n = overlap * bandW;
  const y0 = h0 - overlap;
  for (let dy = 0; dy < overlap; dy++) {
    const row0 = (y0 + dy) * w0;
    const row1 = dy * w1;
    for (let dx = 0; dx < bandW; dx++) {
      const a = g0[row0 + xT + dx];
      const b = g1[row1 + xB + dx];
      sum += Math.abs(a - b);
    }
  }
  return sum / n;
}

/** Minimum MAE over small horizontal shifts (px). */
function scoreOverlapBestShift(top, bot, overlap, x0, bandW) {
  let best = Number.POSITIVE_INFINITY;
  for (let hShift = -36; hShift <= 36; hShift += 2) {
    const s = scoreOverlap(top, bot, overlap, x0, bandW, hShift);
    if (s < best) best = s;
  }
  return best;
}

function findBestOverlap(top, bot) {
  const w = Math.min(top.w, bot.w);
  const h0 = top.h;
  const h1 = bot.h;
  const hMin = Math.min(h0, h1);
  const bandW = Math.max(64, Math.floor(w * 0.94));
  const x0 = Math.floor((w - bandW) / 2);

  const maxO = Math.min(Math.floor(hMin * 0.78), 2600);
  const minO = Math.max(6, Math.floor(hMin * 0.008));

  const coarseStep = Math.max(3, Math.floor((maxO - minO) / 48));

  let bestO = minO;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let o = minO; o <= maxO; o += coarseStep) {
    const s = scoreOverlapBestShift(top, bot, o, x0, bandW);
    if (s < bestScore) {
      bestScore = s;
      bestO = o;
    }
  }

  const refineRadius = Math.min(120, Math.max(36, coarseStep * 4));
  const refineLo = Math.max(minO, bestO - refineRadius);
  const refineHi = Math.min(maxO, bestO + refineRadius);
  for (let o = refineLo; o <= refineHi; o++) {
    const s = scoreOverlapBestShift(top, bot, o, x0, bandW);
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
 * @param {{ autoOrder?: boolean, trimEdges?: boolean, cropDetailsPanel?: boolean }} opts — `cropDetailsPanel` (default true): on landscape shots, crop to the left details column like receipt output.
 * @returns {Promise<{ buffer: Buffer, filename: string, mime: string, overlaps: number[], order: number[] }>}
 */
export async function stitchScreenshots(urls, opts = {}) {
  const autoOrder = opts.autoOrder !== false;
  /** Default off: per-image trim shifts content differently and breaks overlap alignment. */
  const trimEdges = opts.trimEdges === true;
  const cropDetailsPanel = opts.cropDetailsPanel !== false;

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
  if (cropDetailsPanel) {
    bufs = await Promise.all(bufs.map((b) => cropUmaDetailsStrip(b)));
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
