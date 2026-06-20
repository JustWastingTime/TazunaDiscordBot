import fs from 'fs';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

const SILHOUETTE_ALPHA_THRESHOLD = 24;
const SILHOUETTE_BG_COLOR_TOLERANCE = 48;
const SILHOUETTE_MAX_SIZE = 800;
const QUIZ_IMAGE_FETCH_TIMEOUT_MS = 20_000;

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors.
  }
}

const QUIZ_IMAGE_BASENAME = 'quiz-image';

function imageExtensionFromUrl(url) {
  const match = String(url).match(/\.(png|jpe?g|gif|webp|bmp)(?:[?#]|$)/i);
  if (!match) return null;
  return match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
}

function mimeFromExtension(ext) {
  const map = {
    png: 'image/png',
    jpg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    bmp: 'image/bmp',
  };
  return map[ext] || 'application/octet-stream';
}

function resolveImageMeta(url, contentType) {
  const fromUrl = imageExtensionFromUrl(url);
  if (fromUrl) {
    return {
      ext: fromUrl,
      mime: mimeFromExtension(fromUrl),
      filename: `${QUIZ_IMAGE_BASENAME}.${fromUrl}`,
    };
  }

  const mime = contentType?.split(';')[0]?.trim();
  if (mime?.startsWith('image/')) {
    const subtype = mime.split('/')[1];
    const ext = subtype === 'jpeg' ? 'jpg' : subtype;
    return { ext, mime, filename: `${QUIZ_IMAGE_BASENAME}.${ext}` };
  }

  return { ext: 'png', mime: 'image/png', filename: `${QUIZ_IMAGE_BASENAME}.png` };
}

async function downloadImageBuffer(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(QUIZ_IMAGE_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Failed to download image (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const meta = resolveImageMeta(url, response.headers.get('content-type'));
  return { buffer, ...meta };
}

async function downloadImage(url) {
  const { buffer } = await downloadImageBuffer(url);
  const inputPath = path.join(
    os.tmpdir(),
    `festa-quiz-img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.writeFileSync(inputPath, buffer);
  return inputPath;
}

export async function createQuizImageFile(imageUrl) {
  return downloadImageBuffer(imageUrl);
}

function colorDistance(r1, g1, b1, r2, g2, b2) {
  return Math.sqrt((r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2);
}

function sampleCornerBackgroundColor(data, width, height, channels) {
  const cornerSize = Math.max(4, Math.floor(Math.min(width, height) * 0.08));
  const corners = [
    [0, 0],
    [width - cornerSize, 0],
    [0, height - cornerSize],
    [width - cornerSize, height - cornerSize],
  ];

  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let count = 0;
  for (const [startX, startY] of corners) {
    for (let y = startY; y < startY + cornerSize; y += 1) {
      for (let x = startX; x < startX + cornerSize; x += 1) {
        const offset = (y * width + x) * channels;
        rSum += data[offset];
        gSum += data[offset + 1];
        bSum += data[offset + 2];
        count += 1;
      }
    }
  }

  return {
    r: Math.round(rSum / count),
    g: Math.round(gSum / count),
    b: Math.round(bSum / count),
  };
}

function hasTransparentPixels(data, channels) {
  if (channels < 4) return false;
  let transparent = 0;
  const pixelCount = data.length / channels;
  for (let i = 3; i < data.length; i += channels) {
    if (data[i] < SILHOUETTE_ALPHA_THRESHOLD) transparent += 1;
  }
  return transparent > pixelCount * 0.01;
}

function buildAlphaSilhouette(data, width, height, channels, output) {
  for (let i = 0; i < width * height; i += 1) {
    const srcOffset = i * channels;
    const a = channels === 4 ? data[srcOffset + 3] : 255;
    const isBackground = a < SILHOUETTE_ALPHA_THRESHOLD;
    const targetOffset = i * 3;
    const value = isBackground ? 255 : 0;
    output[targetOffset] = value;
    output[targetOffset + 1] = value;
    output[targetOffset + 2] = value;
  }
}

function isBackgroundPixel(r, g, b, a, background) {
  if (a < SILHOUETTE_ALPHA_THRESHOLD) return true;
  return colorDistance(r, g, b, background.r, background.g, background.b) <= SILHOUETTE_BG_COLOR_TOLERANCE;
}

function buildBackgroundMask(data, width, height, channels) {
  const background = sampleCornerBackgroundColor(data, width, height, channels);
  const isBackground = new Uint8Array(width * height);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height * 2);
  let head = 0;
  let tail = 0;

  function enqueue(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    queue[tail] = x;
    queue[tail + 1] = y;
    tail += 2;
  }

  for (let x = 0; x < width; x += 1) {
    enqueue(x, 0);
    enqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y += 1) {
    enqueue(0, y);
    enqueue(width - 1, y);
  }

  while (head < tail) {
    const x = queue[head];
    const y = queue[head + 1];
    head += 2;

    const index = y * width + x;
    if (visited[index]) continue;
    visited[index] = 1;

    const offset = index * channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const a = channels === 4 ? data[offset + 3] : 255;
    if (!isBackgroundPixel(r, g, b, a, background)) continue;

    isBackground[index] = 1;
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }

  return isBackground;
}

async function createSilhouetteBuffer(inputPath) {
  const { data, info } = await sharp(inputPath)
    .ensureAlpha()
    .resize(SILHOUETTE_MAX_SIZE, SILHOUETTE_MAX_SIZE, {
      fit: 'inside',
      withoutEnlargement: false,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const output = Buffer.alloc(width * height * 3);

  if (hasTransparentPixels(data, channels)) {
    buildAlphaSilhouette(data, width, height, channels, output);
  } else {
    const isBackground = buildBackgroundMask(data, width, height, channels);
    for (let i = 0; i < width * height; i += 1) {
      const targetOffset = i * 3;
      const value = isBackground[i] ? 255 : 0;
      output[targetOffset] = value;
      output[targetOffset + 1] = value;
      output[targetOffset + 2] = value;
    }
  }

  return sharp(output, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
}

export async function createSilhouetteFile(imageUrl) {
  let inputPath;
  try {
    inputPath = await downloadImage(imageUrl);
    const buffer = await createSilhouetteBuffer(inputPath);
    return { buffer, filename: 'quiz-silhouette.jpg', mime: 'image/jpeg' };
  } finally {
    if (inputPath) safeUnlink(inputPath);
  }
}
