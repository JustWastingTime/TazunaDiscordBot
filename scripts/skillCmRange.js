import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const RANGE_PATH = path.join(DATA_DIR, 'skill-cm-range.json');

const DEFAULT_MIN = Number(process.env.SKILL_MAP_MIN_CM_NUMBER ?? 18);
const DEFAULT_MAX = Number(process.env.SKILL_MAP_MAX_CM_NUMBER ?? 19);

/** @type {{ min: number, max: number } | null} */
let cachedRange = null;

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function normalizeRange(min, max) {
  const start = Number(min);
  const end = Number(max);
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new Error('CM numbers must be integers.');
  }
  if (start > end) {
    throw new Error('start must be less than or equal to end.');
  }
  return { min: start, max: end };
}

function loadRangeFromDisk() {
  try {
    const parsed = JSON.parse(fs.readFileSync(RANGE_PATH, 'utf8'));
    return normalizeRange(parsed.min ?? parsed.start, parsed.max ?? parsed.end);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    console.warn('[skillCmRange] Failed to load saved range:', err.message);
    return null;
  }
}

function defaultRange() {
  try {
    return normalizeRange(DEFAULT_MIN, DEFAULT_MAX);
  } catch {
    return { min: 18, max: 19 };
  }
}

/** Available CM numbers from champsmeet cache/JSON, sorted ascending. */
export function getAvailableCmNumbers(champsmeets) {
  if (!Array.isArray(champsmeets)) return [];
  const nums = champsmeets
    .map((cm) => Number(cm?.number))
    .filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(nums)].sort((a, b) => a - b);
}

export function getSkillCmRange() {
  if (!cachedRange) {
    cachedRange = loadRangeFromDisk() ?? defaultRange();
  }
  return { ...cachedRange };
}

/**
 * Persist and apply the CM range used by `/skill` map dropdowns.
 * @param {number} start
 * @param {number} end
 * @param {number[]} availableNumbers
 */
export function setSkillCmRange(start, end, availableNumbers) {
  const range = normalizeRange(start, end);
  const available = new Set(
    (availableNumbers ?? []).map(Number).filter((n) => Number.isInteger(n)),
  );

  if (available.size === 0) {
    throw new Error('No Champions Meet entries are loaded.');
  }
  if (!available.has(range.min)) {
    throw new Error(`start CM ${range.min} is not in champsmeet.json.`);
  }
  if (!available.has(range.max)) {
    throw new Error(`end CM ${range.max} is not in champsmeet.json.`);
  }

  ensureDataDir();
  fs.writeFileSync(
    RANGE_PATH,
    `${JSON.stringify({ min: range.min, max: range.max }, null, 2)}\n`,
    'utf8',
  );
  cachedRange = range;
  return { ...range };
}
