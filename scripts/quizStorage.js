import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const QUIZ_DIR = path.resolve(__dirname, '..', 'assets', 'quiz');
const QUIZ_STATE_PATH = path.join(DATA_DIR, 'quiz-state.json');
const QUIZ_GUILD_PATH = path.join(DATA_DIR, 'quiz-guilds.json');
const QUIZ_SETTINGS_PATH = path.join(QUIZ_DIR, 'settings.json');
const QUIZ_CATEGORIES_DIR = path.join(QUIZ_DIR, 'categories');
const QUIZ_REMOTE_SYNC_ENABLED = ['1', 'true', 'yes'].includes(
  String(process.env.QUIZ_REMOTE_SYNC_ENABLED || '').toLowerCase().trim(),
);
const QUIZ_REMOTE_SYNC_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.QUIZ_REMOTE_SYNC_INTERVAL_MS || 300_000),
);
const QUIZ_REMOTE_REPO = process.env.QUIZ_REMOTE_REPO || 'JustWastingTime/TazunaDiscordBot';
const QUIZ_REMOTE_BRANCH = process.env.QUIZ_REMOTE_BRANCH || 'main';
const QUIZ_REMOTE_TOKEN = String(process.env.QUIZ_REMOTE_TOKEN || '').trim();

let writeQueue = Promise.resolve();
let quizRemoteSyncInFlight = null;

function withLock(fn) {
  const run = () => fn();
  writeQueue = writeQueue.then(run, run);
  return writeQueue;
}

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDataDir();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function loadQuizState() {
  return readJson(QUIZ_STATE_PATH, {});
}

export function getActiveQuiz(guildId) {
  const state = loadQuizState();
  const quiz = state[String(guildId)];
  if (!quiz || quiz.status !== 'active') return null;
  return quiz;
}

export function updateQuizState(mutator) {
  return withLock(() => {
    const state = loadQuizState();
    const result = mutator(state);
    writeJson(QUIZ_STATE_PATH, state);
    return result;
  });
}

export function clearQuiz(guildId) {
  return updateQuizState((state) => {
    delete state[String(guildId)];
    return true;
  });
}

export function loadQuizGuildConfig(guildId) {
  const store = readJson(QUIZ_GUILD_PATH, {});
  return store[String(guildId)] ?? null;
}

export function saveQuizGuildConfig(guildId, config) {
  return withLock(() => {
    const store = readJson(QUIZ_GUILD_PATH, {});
    store[String(guildId)] = { ...config, guildId: String(guildId) };
    writeJson(QUIZ_GUILD_PATH, store);
    return store[String(guildId)];
  });
}

export function loadQuizSettings() {
  return readJson(QUIZ_SETTINGS_PATH, { enabledCategories: [] });
}

function buildGithubHeaders() {
  if (!QUIZ_REMOTE_TOKEN) return {};
  return {
    Authorization: `Bearer ${QUIZ_REMOTE_TOKEN}`,
  };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: buildGithubHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.json();
}

async function fetchText(url) {
  const res = await fetch(url, { headers: buildGithubHeaders() });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return await res.text();
}

async function syncRemoteQuizAssetsOnce() {
  if (!QUIZ_REMOTE_SYNC_ENABLED) return;
  if (quizRemoteSyncInFlight) return quizRemoteSyncInFlight;

  quizRemoteSyncInFlight = (async () => {
    const settingsRaw = await fetchText(
      `https://raw.githubusercontent.com/${QUIZ_REMOTE_REPO}/${QUIZ_REMOTE_BRANCH}/assets/quiz/settings.json`,
    );
    const settings = JSON.parse(settingsRaw);
    fs.mkdirSync(QUIZ_DIR, { recursive: true });
    fs.mkdirSync(QUIZ_CATEGORIES_DIR, { recursive: true });
    fs.writeFileSync(QUIZ_SETTINGS_PATH, settingsRaw.endsWith('\n') ? settingsRaw : `${settingsRaw}\n`, 'utf8');

    const categories = Array.isArray(settings?.enabledCategories)
      ? settings.enabledCategories.map((value) => String(value).trim()).filter(Boolean)
      : [];
    if (!categories.length) return;

    // Verify category files exist in the remote branch before downloading.
    const remoteFiles = await fetchJson(
      `https://api.github.com/repos/${QUIZ_REMOTE_REPO}/contents/assets/quiz/categories?ref=${encodeURIComponent(QUIZ_REMOTE_BRANCH)}`,
    );
    const available = new Set(
      Array.isArray(remoteFiles)
        ? remoteFiles
          .filter((entry) => entry?.type === 'file' && String(entry.name || '').endsWith('.json'))
          .map((entry) => String(entry.name).replace(/\.json$/, ''))
        : [],
    );

    for (const categoryId of categories) {
      if (!available.has(categoryId)) continue;
      const raw = await fetchText(
        `https://raw.githubusercontent.com/${QUIZ_REMOTE_REPO}/${QUIZ_REMOTE_BRANCH}/assets/quiz/categories/${categoryId}.json`,
      );
      const filePath = path.join(QUIZ_CATEGORIES_DIR, `${categoryId}.json`);
      fs.writeFileSync(filePath, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
    }
  })();

  try {
    await quizRemoteSyncInFlight;
  } catch (err) {
    console.warn(`[QuizRemoteSync] Sync failed: ${err.message}`);
  } finally {
    quizRemoteSyncInFlight = null;
  }
}

export function startQuizRemoteSync() {
  if (!QUIZ_REMOTE_SYNC_ENABLED) return;
  console.log(
    `[QuizRemoteSync] Enabled (${QUIZ_REMOTE_REPO}@${QUIZ_REMOTE_BRANCH}, interval=${QUIZ_REMOTE_SYNC_INTERVAL_MS}ms)`,
  );

  syncRemoteQuizAssetsOnce().catch((err) => {
    console.warn(`[QuizRemoteSync] Initial sync error: ${err.message}`);
  });

  setInterval(() => {
    syncRemoteQuizAssetsOnce().catch((err) => {
      console.warn(`[QuizRemoteSync] Scheduled sync error: ${err.message}`);
    });
  }, QUIZ_REMOTE_SYNC_INTERVAL_MS);
}

function listQuizCategoryIds() {
  try {
    return fs
      .readdirSync(QUIZ_CATEGORIES_DIR)
      .filter((file) => file.endsWith('.json'))
      .map((file) => file.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

const ENTRY_DIFFICULTIES = new Set(['easy', 'medium', 'hard', 'expert']);

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function isImageUrl(value) {
  return isUrl(value) && /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(value);
}

function mediaFromUrl(url) {
  if (isImageUrl(url)) return { imageUrl: url };
  return { audioUrl: url };
}

function parseEntryOverrides(...values) {
  const overrides = {};
  for (const value of values) {
    if (value == null) continue;
    const normalized = String(value).toLowerCase();
    if (ENTRY_DIFFICULTIES.has(normalized)) overrides.difficulty = normalized;
    if (normalized === 'silhouette') overrides.silhouette = true;
  }
  return overrides;
}

function normalizeCategoryEntry(entry) {
  if (Array.isArray(entry)) {
    const [first, answers, third, fourth] = entry;
    const overrides = parseEntryOverrides(third, fourth);
    if (isUrl(first)) return { ...mediaFromUrl(first), answers, ...overrides };
    return { subject: first, answers, ...overrides };
  }
  if (entry && typeof entry === 'object') {
    return {
      subject: entry.subject ?? entry.name ?? entry.key,
      prompt: entry.prompt,
      answers: entry.answers,
      audioUrl: entry.audioUrl,
      imageUrl: entry.imageUrl,
      silhouette: entry.silhouette === true,
      id: entry.id,
      difficulty: entry.difficulty,
      type: entry.type,
    };
  }
  return null;
}

function slugifyQuestionIdPart(value) {
  return String(value || 'item')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function templateHasPlaceholder(template) {
  return template.includes('{0}') || template.includes('{name}');
}

function buildEntryPrompt(template, value) {
  return template.replace(/\{0\}/g, value).replace(/\{name\}/g, value);
}

function buildEntryId(categoryId, normalized, index, groupPrefix = '') {
  const prefix = groupPrefix ? `${categoryId}-${groupPrefix}` : categoryId;
  if (normalized.id) return normalized.id;
  if (normalized.subject) {
    const idPart = slugifyQuestionIdPart(normalized.subject) || `item-${index + 1}`;
    return `${prefix}-${idPart}-${index + 1}`;
  }
  if (normalized.audioUrl) {
    const idPart = slugifyQuestionIdPart(normalized.audioUrl.split('/').pop()) || `item-${index + 1}`;
    return `${prefix}-${idPart}-${index + 1}`;
  }
  if (normalized.imageUrl) {
    const idPart = slugifyQuestionIdPart(normalized.imageUrl.split('/').pop()) || `item-${index + 1}`;
    return `${prefix}-${idPart}-${index + 1}`;
  }
  if (normalized.prompt) {
    const idPart = slugifyQuestionIdPart(normalized.prompt) || `item-${index + 1}`;
    return `${prefix}-${idPart}-${index + 1}`;
  }
  return `${prefix}-item-${index + 1}`;
}

function getCategoryDefaults(data) {
  return {
    type: data.type || 'mcq',
    difficulty: data.difficulty || 'easy',
  };
}

function isValidTemplateEntry(normalized, template) {
  if (!normalized || !Array.isArray(normalized.answers) || !normalized.answers.length) {
    return false;
  }
  if (normalized.prompt) return true;
  if (!template) return false;
  if (normalized.audioUrl || normalized.imageUrl) return true;
  if (templateHasPlaceholder(template)) {
    return Boolean(String(normalized.subject ?? '').trim());
  }
  return true;
}

function buildQuestionFromEntry(normalized, index, options) {
  const {
    categoryId,
    template,
    groupPrefix,
    defaultType,
    defaultDifficulty,
    defaultSilhouette,
  } = options;
  const subject = normalized.subject != null ? String(normalized.subject).trim() : '';
  const prompt = normalized.prompt
    ? String(normalized.prompt).trim()
    : buildEntryPrompt(template, subject);
  const question = {
    id: buildEntryId(categoryId, normalized, index, groupPrefix),
    type: normalized.type || defaultType,
    difficulty: normalized.difficulty || defaultDifficulty,
    promptTemplate: template,
    prompt,
    answers: normalized.answers.map((answer) => String(answer)),
  };
  if (normalized.audioUrl) question.audioUrl = normalized.audioUrl;
  if (normalized.imageUrl) question.imageUrl = normalized.imageUrl;
  if (normalized.silhouette || defaultSilhouette) question.silhouette = true;
  return question;
}

function expandEntryList(entries, options) {
  return entries
    .map((entry, index) => ({ normalized: normalizeCategoryEntry(entry), index }))
    .filter(({ normalized }) => isValidTemplateEntry(normalized, options.template))
    .map(({ normalized, index }) => buildQuestionFromEntry(normalized, index, options));
}

function expandTemplateGroup(group, categoryId, groupIndex, categoryDefaults) {
  const template = String(group.promptTemplate || group.prompt || '').trim();
  const entries = Array.isArray(group.entries) ? group.entries : [];
  if (!template || !entries.length) return [];

  return expandEntryList(entries, {
    categoryId,
    template,
    groupPrefix: `g${groupIndex}`,
    defaultType: group.type || categoryDefaults.type,
    defaultDifficulty: group.difficulty || categoryDefaults.difficulty,
    defaultSilhouette: group.silhouette === true,
  });
}

function normalizeStandaloneQuestion(item, categoryId, index, categoryDefaults) {
  const prompt = String(item.prompt).trim();
  const question = {
    id: item.id || buildEntryId(categoryId, { prompt: item.prompt }, index, `q${index}`),
    type: item.type || categoryDefaults.type,
    difficulty: item.difficulty || categoryDefaults.difficulty,
    promptTemplate: String(item.promptTemplate || item.prompt || '').trim() || prompt,
    prompt,
    answers: item.answers.map((answer) => String(answer)),
  };
  if (item.audioUrl) question.audioUrl = item.audioUrl;
  if (item.imageUrl) question.imageUrl = item.imageUrl;
  if (item.silhouette === true) question.silhouette = true;
  return question;
}

function isTemplateGroup(item) {
  return Boolean(item && Array.isArray(item.entries) && (item.promptTemplate || item.prompt));
}

function normalizeCategoryQuestions(data, categoryId) {
  const categoryDefaults = getCategoryDefaults(data);

  if (Array.isArray(data.questions)) {
    const questions = [];
    data.questions.forEach((item, groupIndex) => {
      if (isTemplateGroup(item)) {
        questions.push(...expandTemplateGroup(item, categoryId, groupIndex, categoryDefaults));
        return;
      }
      if (item?.prompt && Array.isArray(item.answers) && item.answers.length) {
        questions.push(normalizeStandaloneQuestion(item, categoryId, questions.length, categoryDefaults));
      }
    });
    return questions;
  }

  const template = String(data.promptTemplate || data.prompt || '').trim();
  const entries = Array.isArray(data.entries) ? data.entries : [];
  if (!entries.length) return [];

  return expandEntryList(entries, {
    categoryId,
    template,
    groupPrefix: '',
    defaultType: categoryDefaults.type,
    defaultDifficulty: categoryDefaults.difficulty,
    defaultSilhouette: data.silhouette === true,
  });
}

export function loadQuizCategory(categoryId) {
  const filePath = path.join(QUIZ_CATEGORIES_DIR, `${categoryId}.json`);
  const data = readJson(filePath, null);
  if (!data) return null;

  const questions = normalizeCategoryQuestions(data, categoryId);
  return {
    id: categoryId,
    name: data.name || categoryId,
    questions: questions.map((question) => ({
      ...question,
      category: categoryId,
      categoryName: data.name || categoryId,
    })),
  };
}

const ALWAYS_LOADABLE_CATEGORIES = new Set(['testquestions']);

export function loadQuizQuestions(categoryFilter) {
  const settings = loadQuizSettings();
  const enabled = settings.enabledCategories || [];
  const canLoad = (categoryId) =>
    enabled.includes(categoryId) || ALWAYS_LOADABLE_CATEGORIES.has(categoryId);
  const categories = Array.isArray(categoryFilter) && categoryFilter.length
    ? categoryFilter.filter(canLoad)
    : enabled;
  const questions = [];

  for (const categoryId of categories) {
    const category = loadQuizCategory(categoryId);
    if (!category) {
      console.warn(`Quiz category not found: ${categoryId}`);
      continue;
    }
    questions.push(...category.questions);
  }

  return questions;
}
