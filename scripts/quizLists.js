import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LISTS_PATH = path.resolve(__dirname, '..', 'assets', 'quiz', 'lists.json');

let cachedLists = null;

function loadQuizLists() {
  if (!cachedLists) {
    try {
      cachedLists = JSON.parse(fs.readFileSync(LISTS_PATH, 'utf8'));
    } catch {
      cachedLists = {};
    }
  }
  return cachedLists;
}

function getQuizList(name) {
  const list = loadQuizLists()[name];
  return Array.isArray(list) ? list.map((item) => String(item)) : [];
}

function isListRef(value) {
  return typeof value === 'string' && value.startsWith('$') && value.length > 1;
}

function pickRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

export function resolveMcqAnswers(rawAnswers, { minWrong = 3, normalizeAnswer } = {}) {
  if (!rawAnswers?.length) return [];

  const usable = rawAnswers.filter((item) => isListRef(item) || String(item ?? '').trim());
  if (!usable.length) return [];

  const correct = String(usable[0]).trim();
  const exclude = new Set([normalizeAnswer(correct)]);
  const wrong = [];

  for (const item of usable.slice(1)) {
    if (isListRef(item)) continue;
    const value = String(item).trim();
    if (!value) continue;
    wrong.push(value);
    exclude.add(normalizeAnswer(value));
  }

  const listNames = usable.slice(1).filter(isListRef).map((ref) => ref.slice(1));
  const listPool = [...new Set(listNames.flatMap(getQuizList))].filter((name) => String(name).trim());
  const maxAttempts = Math.max(listPool.length, minWrong) * 2;
  let attempts = 0;

  while (wrong.length < minWrong && attempts < maxAttempts) {
    const available = listPool.filter(
      (name) => String(name).trim() && !exclude.has(normalizeAnswer(name)),
    );
    if (!available.length) break;
    const pick = pickRandomItem(available);
    wrong.push(pick);
    exclude.add(normalizeAnswer(pick));
    attempts += 1;
  }

  return [correct, ...wrong];
}
