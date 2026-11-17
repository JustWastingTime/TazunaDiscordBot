import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import { isBotOwner } from './adminRole.js';
import { httpError, requireSignedIn } from './adminAuth.js';
import { recordAdminAudit } from './assetStore.js';
import { jsonError } from './dashboardAuth.js';
import { commitFiles, fastForwardLocalCheckout, getFileAtHead } from './githubCommit.js';
import cache from './githubCache.js';
import { reloadQuizLists } from './quizLists.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUIZ_DIR = path.join(ROOT, 'assets', 'quiz');
const CATEGORIES_DIR = path.join(QUIZ_DIR, 'categories');
const DATA_DIR = path.join(ROOT, 'data');
const ACCESS_PATH = path.join(DATA_DIR, 'quiz-access.json');
const DRAFTS_PATH = path.join(DATA_DIR, 'quiz-drafts.json');

const SETTINGS_REPO_PATH = 'assets/quiz/settings.json';
const LISTS_REPO_PATH = 'assets/quiz/lists.json';
const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const ROLES = ['editor', 'reviewer'];
const ID_RE = /^[a-z0-9_-]{1,40}$/;
const LIST_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/i;
const MAX_DRAFTS_PER_USER = 20;

// ---------------------------------------------------------------------------
// Small local state files (data/ is gitignored and lives on the server only).

let stateQueue = Promise.resolve();
function locked(fn) {
  const run = () => fn();
  stateQueue = stateQueue.then(run, run);
  return stateQueue;
}

async function readState(file, fallback) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

async function writeState(file, rows) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Access: owner (BOT_OWNER_IDS), reviewer, editor.

export async function listQuizEditors() {
  return readState(ACCESS_PATH, []);
}

function accessFromRow(row) {
  return {
    role: row.role,
    categories: Array.isArray(row.categories) ? row.categories : [],
    canPublish: row.role === 'reviewer' || row.canPublish === true,
  };
}

export async function quizAccessFor(discordId) {
  if (!discordId) return null;
  if (isBotOwner(discordId)) return { role: 'owner', categories: ['*'], canPublish: true };
  const row = (await listQuizEditors()).find((item) => item.discordId === String(discordId));
  return row ? accessFromRow(row) : null;
}

function inScope(access, categoryId) {
  return Boolean(access && (access.categories.includes('*') || access.categories.includes(categoryId)));
}

function cleanEditor(raw, actor) {
  const discordId = String(raw?.discordId || '').trim();
  if (!/^\d{15,22}$/.test(discordId)) throw httpError(400, 'Discord user ID must be 15–22 digits.');
  if (isBotOwner(discordId)) throw httpError(400, 'That account is already the owner.');
  const role = String(raw?.role || 'editor');
  if (!ROLES.includes(role)) throw httpError(400, 'Role must be editor or reviewer.');
  const categories = Array.isArray(raw?.categories)
    ? [...new Set(raw.categories.map((id) => String(id).trim()).filter((id) => id === '*' || ID_RE.test(id)))]
    : [];
  if (!categories.length) throw httpError(400, 'Pick at least one category.');
  return {
    discordId,
    label: String(raw?.label || '').trim().slice(0, 60),
    role,
    categories: categories.includes('*') ? ['*'] : categories,
    canPublish: role === 'reviewer' || raw?.canPublish === true,
    addedBy: actor?.username || actor?.discordId || null,
    addedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Category files.

function categoryRepoPath(categoryId) {
  const id = String(categoryId || '');
  if (!ID_RE.test(id)) throw httpError(400, 'Category ids use lowercase letters, numbers, dash, and underscore.');
  return `assets/quiz/categories/${id}.json`;
}

async function readLocalJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function localCategoryIds() {
  try {
    return (await fs.readdir(CATEGORIES_DIR)).filter((name) => name.endsWith('.json')).map((name) => name.replace(/\.json$/, '')).sort();
  } catch {
    return [];
  }
}

async function readLocalSettings() {
  return readLocalJson(path.join(QUIZ_DIR, 'settings.json'), { enabledCategories: [], availableCategories: [] });
}

async function readLocalLists() {
  return readLocalJson(path.join(QUIZ_DIR, 'lists.json'), {});
}

function entryCount(data) {
  return (data?.questions || []).reduce((sum, q) => sum + (Array.isArray(q?.entries) ? q.entries.length : 1), 0);
}

function isUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function mediaKind(question) {
  const subjects = Array.isArray(question?.entries) ? question.entries.map((e) => (Array.isArray(e) ? e[0] : e?.imageUrl || e?.audioUrl)) : [];
  const url = subjects.find(isUrl);
  if (!url) return 'text';
  return /\.(png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(url) ? 'image' : 'audio';
}

function categoryStats(id, data, settings) {
  const difficulty = { easy: 0, medium: 0, hard: 0, expert: 0 };
  for (const q of data?.questions || []) {
    const d = DIFFICULTIES.includes(q?.difficulty) ? q.difficulty : (DIFFICULTIES.includes(data?.difficulty) ? data.difficulty : 'easy');
    difficulty[d] += 1;
  }
  return {
    id,
    name: data?.name || id,
    enabled: (settings.enabledCategories || []).includes(id),
    questions: (data?.questions || []).length,
    entries: entryCount(data),
    difficulty,
  };
}

// Strings are kept exactly as written so saving one question never rewrites the rest of the file.
function cleanAnswers(list, where) {
  if (!Array.isArray(list)) throw httpError(400, `${where}: answers must be a list.`);
  const out = list.map((answer) => String(answer ?? '')).filter((answer) => answer.trim());
  if (!out.length) throw httpError(400, `${where} needs a correct answer.`);
  if (out[0].trim().startsWith('$')) throw httpError(400, `${where}: the first answer is the correct one and cannot be a random token.`);
  return out;
}

function cleanEntry(entry, where) {
  if (Array.isArray(entry)) {
    const [subject, answers, ...rest] = entry;
    // Older rows with no answers list are skipped by the bot today; keep them untouched.
    if (!Array.isArray(answers)) return entry.map((value) => String(value ?? ''));
    const out = [String(subject ?? ''), cleanAnswers(answers, where)];
    for (const extra of rest) {
      if (extra == null || extra === '') continue;
      const value = String(extra).trim().toLowerCase();
      if (value !== 'silhouette' && !DIFFICULTIES.includes(value)) throw httpError(400, `${where}: unknown option "${extra}".`);
      out.push(String(extra));
    }
    return out;
  }
  if (entry && typeof entry === 'object') {
    cleanAnswers(entry.answers, where);
    return entry;
  }
  throw httpError(400, `${where} is not a valid entry.`);
}

function cleanQuestion(raw, index) {
  const where = `Question ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, `${where} is not an object.`);
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'entries' || key === 'answers' || value == null || value === '') continue;
    out[key] = value;
  }
  if (out.difficulty !== undefined) {
    const d = String(out.difficulty).toLowerCase();
    if (!DIFFICULTIES.includes(d)) throw httpError(400, `${where}: difficulty must be easy, medium, hard, or expert.`);
    out.difficulty = d;
  }
  if (Array.isArray(raw.entries)) {
    const template = String(raw.promptTemplate || raw.prompt || '').trim();
    if (!template) throw httpError(400, `${where} needs a prompt.`);
    if (!raw.entries.length) throw httpError(400, `${where} has no entries.`);
    out.entries = raw.entries.map((entry, j) => cleanEntry(entry, `${where}, entry ${j + 1}`));
    const usesSlot = template.includes('{0}') || template.includes('{name}');
    if (usesSlot) {
      const blank = out.entries.findIndex((entry) => Array.isArray(entry) && Array.isArray(entry[1]) && !String(entry[0]).trim());
      if (blank >= 0) throw httpError(400, `${where}, entry ${blank + 1} needs a subject for {0}.`);
    }
  } else {
    if (!String(raw.prompt || '').trim()) throw httpError(400, `${where} needs a prompt.`);
    out.answers = cleanAnswers(raw.answers, where);
  }
  return out;
}

function cleanCategory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw httpError(400, 'Missing category data.');
  const name = String(raw.name || '').trim();
  if (!name) throw httpError(400, 'Category needs a name.');
  if (!Array.isArray(raw.questions)) throw httpError(400, 'Category questions must be a list.');
  const out = { name };
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'name' || key === 'questions' || value == null) continue;
    out[key] = value;
  }
  out.questions = raw.questions.map(cleanQuestion);
  return out;
}

/** Keep the hand-edited layout: one entry per line, so GitHub diffs stay readable. */
export function formatCategory(data) {
  const lines = ['{'];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'questions') continue;
    lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(value)},`);
  }
  lines.push('  "questions": [');
  data.questions.forEach((question, i) => {
    const comma = i === data.questions.length - 1 ? '' : ',';
    const head = Object.entries(question)
      .filter(([key]) => key !== 'entries')
      .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(', ');
    if (Array.isArray(question.entries)) {
      lines.push(`    { ${head},`);
      lines.push('      "entries": [');
      question.entries.forEach((entry, j) => {
        lines.push(`        ${JSON.stringify(entry)}${j === question.entries.length - 1 ? '' : ','}`);
      });
      lines.push('      ]');
      lines.push(`    }${comma}`);
    } else {
      lines.push(`    { ${head} }${comma}`);
    }
  });
  lines.push('  ]', '}', '');
  return lines.join('\n');
}

function summarizeChange(before, after) {
  const prev = before?.questions || [];
  const next = after?.questions || [];
  let changed = 0;
  let first = null;
  for (let i = 0; i < Math.min(prev.length, next.length); i += 1) {
    if (JSON.stringify(prev[i]) !== JSON.stringify(next[i])) {
      changed += 1;
      if (first == null) first = i;
    }
  }
  if (first == null && next.length > prev.length) first = prev.length;
  const parts = [];
  const dq = next.length - prev.length;
  const de = entryCount(after) - entryCount(before);
  if (dq) parts.push(`${dq > 0 ? '+' : ''}${dq} question${Math.abs(dq) === 1 ? '' : 's'}`);
  if (de) parts.push(`${de > 0 ? '+' : ''}${de} entr${Math.abs(de) === 1 ? 'y' : 'ies'}`);
  if (changed) parts.push(`${changed} question${changed === 1 ? '' : 's'} edited`);
  if (before && before.name !== after.name) parts.push('renamed');
  return { questions: dq, entries: de, changed, first, text: parts.join(', ') || 'no changes' };
}

async function writeLocal(repoPath, content) {
  const dest = path.resolve(ROOT, repoPath);
  if (!dest.startsWith(`${QUIZ_DIR}${path.sep}`)) throw httpError(400, 'Refusing to write outside assets/quiz.');
  await fs.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, dest);
}

async function publishFiles(files, { message, actor, summary }) {
  const commit = await commitFiles(files.map((file) => ({ path: file.path, content: file.content, baseBlobSha: file.baseBlobSha || undefined })), message);
  const paths = files.map((file) => file.path);
  const sync = await fastForwardLocalCheckout(paths);
  if (!sync.synced) {
    console.warn(`Saved ${paths.join(', ')} on GitHub, but the local checkout was not fast-forwarded: ${sync.reason}`);
    for (const file of files) await writeLocal(file.path, file.content);
  }
  if (paths.includes(LISTS_REPO_PATH)) reloadQuizLists();
  await recordAdminAudit({
    at: new Date().toISOString(),
    actor: actor?.discordId || null,
    username: actor?.username || null,
    file: paths.join(', '),
    summary,
    commitSha: commit.commitSha,
  });
  return { commitSha: commit.commitSha, blobSha: commit.blobShas?.[paths[0]] || null };
}

async function headOrNull(repoPath) {
  try {
    return await getFileAtHead(repoPath);
  } catch (error) {
    if (error.statusCode === 404) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Coverage + generator. Built from the bot's cached data, so it stays in sync
// with the Umas, Support cards, and Skills editors.

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function baseName(value) {
  return String(value || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function cardNumber(value) {
  const match = String(value || '').match(/(\d{5,6})(?:\.png|\b)/);
  return match ? match[1] : null;
}

function cardImage(number) {
  return `https://media.gametora.com/umamusume/supports/full/small/${number}.png`;
}

const cap = (value) => String(value || '').charAt(0).toUpperCase() + String(value || '').slice(1);

async function datasets() {
  const lists = await readLocalLists();
  const characters = Array.isArray(cache.characters) ? cache.characters : [];
  const umaNames = [...new Set([...(lists.uma || []), ...characters.map((c) => c.character_name)].filter(Boolean).map(String))].sort();
  const cards = (Array.isArray(cache.supporters) ? cache.supporters : [])
    .map((card) => ({
      key: cardNumber(card.id) || String(card.id),
      label: `${card.card_name || '?'} · ${card.character_name || '?'}`,
      rarity: String(card.rarity || '').toUpperCase(),
      group: cap(card.category),
    }))
    .filter((card) => card.key);
  const skills = (Array.isArray(cache.skills) ? cache.skills : [])
    .filter((skill) => skill?.skill_name)
    .map((skill) => ({ key: String(skill.skill_name), label: String(skill.skill_name), group: String(skill.rarity || '') }));
  return {
    umas: umaNames.map((name) => ({ key: name, label: name })),
    cards,
    skills,
  };
}

export async function quizCoverage() {
  const data = await datasets();
  const sets = {
    umas: new Set(data.umas.map((item) => item.key)),
    cards: new Set(data.cards.map((item) => item.key)),
    skills: new Set(data.skills.map((item) => item.key)),
  };
  const settings = await readLocalSettings();
  const checks = [];
  for (const id of await localCategoryIds()) {
    const category = await readLocalJson(path.join(CATEGORIES_DIR, `${id}.json`), null);
    (category?.questions || []).forEach((question, index) => {
      const rows = Array.isArray(question?.entries)
        ? question.entries.filter(Array.isArray).map((entry) => [entry[0], Array.isArray(entry[1]) ? entry[1][0] : ''])
        : [['', Array.isArray(question?.answers) ? question.answers[0] : '']];
      const hits = { umas: new Set(), cards: new Set(), skills: new Set() };
      for (const [subject, correct] of rows) {
        for (const value of [subject, correct]) {
          const text = String(value || '');
          if (sets.umas.has(text)) hits.umas.add(text);
          if (sets.umas.has(baseName(text))) hits.umas.add(baseName(text));
          if (sets.skills.has(text)) hits.skills.add(text);
        }
        const number = isUrl(subject) ? cardNumber(subject) : null;
        if (number && sets.cards.has(number)) hits.cards.add(number);
      }
      for (const [dataset, covered] of Object.entries(hits)) {
        if (!covered.size) continue;
        checks.push({
          dataset,
          categoryId: id,
          categoryName: category.name || id,
          enabled: (settings.enabledCategories || []).includes(id),
          index,
          prompt: String(question.promptTemplate || question.prompt || ''),
          entries: rows.length,
          covered: [...covered],
        });
      }
    });
  }
  return { datasets: data, checks };
}

const APTITUDE_GRADES = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
const APTITUDES = ['Turf', 'Dirt', 'Sprint', 'Mile', 'Medium', 'Long', 'Front', 'Pace', 'Late', 'End'];
const CARD_TYPES = ['Speed', 'Stamina', 'Power', 'Guts', 'Wit'];

function charactersFor(key) {
  const all = Array.isArray(cache.characters) ? cache.characters : [];
  return all.filter((c) => c.character_name === key || c.unique === key);
}

function supporterFor(number) {
  return (Array.isArray(cache.supporters) ? cache.supporters : []).find((card) => cardNumber(card.id) === String(number)) || null;
}

function aptitudeOf(character, label) {
  for (const group of Array.isArray(character?.aptitudes) ? character.aptitudes : []) {
    if (group && group[label]) return String(group[label]).toUpperCase();
  }
  return null;
}

const RECIPES = [
  {
    id: 'unique-owner',
    label: 'Unique skill → owner',
    datasets: ['umas', 'skills'],
    promptTemplate: 'Which uma has the unique skill {0}?',
    build(key) {
      const rows = charactersFor(key).filter((c) => c.unique && c.unique !== '-');
      if (!rows.length) return { skip: 'No unique skill in Umas data.' };
      return { entries: rows.map((c) => [c.unique, [c.character_name, '$uma']]) };
    },
  },
  {
    id: 'owner-unique',
    label: 'Uma → unique skill name',
    datasets: ['umas'],
    promptTemplate: "{0}'s unique skill is called?",
    build(key) {
      const uniques = (Array.isArray(cache.characters) ? cache.characters : []).map((c) => c.unique).filter((u) => u && u !== '-');
      const rows = charactersFor(key).filter((c) => c.character_name === key && c.unique && c.unique !== '-');
      if (!rows.length) return { skip: 'No unique skill in Umas data.' };
      return {
        entries: rows.map((c) => [
          `${c.character_name} (${c.type || 'Original'})`,
          [c.unique, ...shuffle(uniques.filter((u) => u !== c.unique)).slice(0, 3)],
        ]),
      };
    },
  },
  ...APTITUDES.map((label) => ({
    id: `aptitude-${label.toLowerCase()}`,
    label: `Uma → ${label} aptitude`,
    datasets: ['umas'],
    promptTemplate: `What is {0}'s ${label} Aptitude?`,
    build(key) {
      const rows = charactersFor(key).filter((c) => c.character_name === key && aptitudeOf(c, label));
      if (!rows.length) return { skip: `No ${label} aptitude in Umas data.` };
      return {
        entries: rows.map((c) => {
          const grade = aptitudeOf(c, label);
          return [`${c.character_name} (${c.type || 'Original'})`, [grade, ...shuffle(APTITUDE_GRADES.filter((g) => g !== grade))]];
        }),
      };
    },
  })),
  {
    id: 'card-name',
    label: 'Card art → card name',
    datasets: ['cards'],
    promptTemplate: 'What is the name of this card?',
    build(key) {
      const card = supporterFor(key);
      if (!card?.card_name) return { skip: 'Card not found.' };
      const others = (cache.supporters || []).filter((c) => c.card_name && c.card_name !== card.card_name && c.rarity === card.rarity).map((c) => c.card_name);
      return { entries: [[cardImage(key), [card.card_name, ...shuffle([...new Set(others)]).slice(0, 4)]]] };
    },
  },
  {
    id: 'card-type',
    label: 'Card art → type',
    datasets: ['cards'],
    promptTemplate: 'What is the type of this card?',
    build(key) {
      const card = supporterFor(key);
      const type = cap(card?.category);
      if (!card || !type) return { skip: 'Card has no type.' };
      return { entries: [[cardImage(key), [type, ...shuffle(CARD_TYPES.filter((t) => t !== type))]]] };
    },
  },
  {
    id: 'card-gold-skill',
    label: 'Card art → gold skill',
    datasets: ['cards'],
    promptTemplate: 'Which gold skill does this card give?',
    build(key) {
      const card = supporterFor(key);
      if (!card) return { skip: 'Card not found.' };
      const gold = new Set((cache.skills || []).filter((s) => s.rarity === 'rare').map((s) => s.skill_name));
      const own = [...(card.support_skills || []), ...(card.event_skills || [])].filter((name) => gold.has(name));
      if (!own.length) return { skip: 'Card gives no gold skill.' };
      const wrong = shuffle([...gold].filter((name) => !own.includes(name))).slice(0, 5);
      return { entries: [[cardImage(key), [own[0], ...wrong]]] };
    },
  },
];

export function quizRecipes() {
  return RECIPES.map(({ id, label, datasets: sets, promptTemplate }) => ({ id, label, datasets: sets, promptTemplate }));
}

export function runRecipe(recipeId, keys) {
  const recipe = RECIPES.find((item) => item.id === recipeId);
  if (!recipe) throw httpError(404, 'Unknown recipe.');
  if (!Array.isArray(keys) || !keys.length) throw httpError(400, 'Pick at least one item.');
  if (keys.length > 500) throw httpError(400, 'Generate at most 500 items at once.');
  const entries = [];
  const skipped = [];
  for (const key of keys.map(String)) {
    const result = recipe.build(key);
    if (result.skip) skipped.push({ key, reason: result.skip });
    else entries.push(...result.entries);
  }
  return { recipe: recipe.id, promptTemplate: recipe.promptTemplate, entries, skipped };
}

// ---------------------------------------------------------------------------
// Drafts.

async function listDrafts() {
  return readState(DRAFTS_PATH, []);
}

function draftSummary(draft) {
  const { data: _data, ...rest } = draft;
  return rest;
}

async function publishCategory({ categoryId, data, baseBlobSha, message, actor, summary }) {
  const repoPath = categoryRepoPath(categoryId);
  return publishFiles([{ path: repoPath, content: formatCategory(data), baseBlobSha }], {
    message: message || `quiz: update ${categoryId} (${summary})`,
    actor,
    summary: `quiz ${categoryId}: ${summary}`,
  });
}

// ---------------------------------------------------------------------------
// Routes.

async function needAccess(req) {
  const access = await quizAccessFor(req.adminUser?.discordId);
  if (!access) throw httpError(403, 'You do not have quiz editor access.');
  return access;
}

async function needOwner(req) {
  const access = await needAccess(req);
  if (access.role !== 'owner') throw httpError(403, 'Owner only.');
  return access;
}

function wrap(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res);
    } catch (error) {
      next(error);
    }
  };
}

export function mountQuizAdmin(parent) {
  const router = express.Router();
  router.use(requireSignedIn);

  router.get('/access', wrap(async (req, res) => {
    res.json({ access: await needAccess(req) });
  }));

  router.get('/categories', wrap(async (req, res) => {
    const access = await needAccess(req);
    const settings = await readLocalSettings();
    const drafts = (await listDrafts()).filter((d) => d.status === 'pending');
    const categories = [];
    for (const id of await localCategoryIds()) {
      const data = await readLocalJson(path.join(CATEGORIES_DIR, `${id}.json`), null);
      if (!data) continue;
      categories.push({
        ...categoryStats(id, data, settings),
        canEdit: inScope(access, id),
        pendingDrafts: drafts.filter((d) => d.categoryId === id).length,
      });
    }
    const visible = drafts.filter((d) => (access.role === 'editor' ? d.authorId === req.adminUser.discordId : inScope(access, d.categoryId)));
    res.json({ categories, pendingDrafts: visible.length });
  }));

  router.get('/categories/:id', wrap(async (req, res) => {
    await needAccess(req);
    const file = await headOrNull(categoryRepoPath(req.params.id));
    if (!file) throw httpError(404, 'Category not found on GitHub.');
    const settings = await readLocalSettings();
    res.json({ data: JSON.parse(file.content), blobSha: file.blobSha, enabled: (settings.enabledCategories || []).includes(req.params.id) });
  }));

  router.post('/categories', wrap(async (req, res) => {
    await needOwner(req);
    const id = String(req.body?.id || '').trim().toLowerCase();
    const repoPath = categoryRepoPath(id);
    const name = String(req.body?.name || '').trim() || id;
    if (await headOrNull(repoPath)) throw httpError(409, 'That category already exists.');
    const settingsFile = await headOrNull(SETTINGS_REPO_PATH);
    const settings = settingsFile ? JSON.parse(settingsFile.content) : { enabledCategories: [], availableCategories: [] };
    settings.availableCategories = [...new Set([...(settings.availableCategories || []), id])];
    const result = await publishFiles([
      { path: repoPath, content: formatCategory({ name, questions: [] }) },
      { path: SETTINGS_REPO_PATH, content: `${JSON.stringify(settings, null, 2)}\n`, baseBlobSha: settingsFile?.blobSha },
    ], { message: `quiz: add category ${id}`, actor: req.adminUser, summary: `quiz: add category ${id}` });
    res.status(201).json({ id, ...result });
  }));

  router.put('/categories/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    const categoryId = String(req.params.id);
    categoryRepoPath(categoryId);
    if (!inScope(access, categoryId)) throw httpError(403, 'You cannot edit this category.');
    const data = cleanCategory(req.body?.data);
    const head = await headOrNull(categoryRepoPath(categoryId));
    if (!head) throw httpError(404, 'Category not found on GitHub.');
    const before = JSON.parse(head.content);
    const summary = summarizeChange(before, data);
    const baseBlobSha = String(req.body?.baseBlobSha || '');
    if (!baseBlobSha) throw httpError(400, 'Missing baseBlobSha. Reload the category.');
    const draftId = req.body?.draftId ? String(req.body.draftId) : null;

    if (access.canPublish) {
      const result = await publishCategory({ categoryId, data, baseBlobSha, message: req.body?.message, actor: req.adminUser, summary: summary.text });
      if (draftId) await locked(async () => writeState(DRAFTS_PATH, (await listDrafts()).filter((d) => d.id !== draftId)));
      return res.json({ published: true, summary, ...result });
    }

    const draft = await locked(async () => {
      const drafts = await listDrafts();
      const actor = req.adminUser;
      const existing = draftId ? drafts.find((d) => d.id === draftId) : null;
      if (existing && existing.authorId !== actor.discordId) throw httpError(403, 'That draft belongs to someone else.');
      if (!existing && drafts.filter((d) => d.authorId === actor.discordId && d.status === 'pending').length >= MAX_DRAFTS_PER_USER) {
        throw httpError(429, `You already have ${MAX_DRAFTS_PER_USER} drafts waiting. Wait for a review first.`);
      }
      const row = {
        id: existing?.id || crypto.randomUUID(),
        categoryId,
        categoryName: data.name,
        authorId: actor.discordId,
        authorName: actor.globalName || actor.username || actor.discordId,
        createdAt: existing?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        baseBlobSha,
        message: String(req.body?.message || '').trim().slice(0, 200),
        summary,
        status: 'pending',
        note: '',
        data,
      };
      await writeState(DRAFTS_PATH, [...drafts.filter((d) => d.id !== row.id), row]);
      return row;
    });
    await recordAdminAudit({
      at: new Date().toISOString(),
      actor: req.adminUser.discordId,
      username: req.adminUser.username || null,
      file: categoryRepoPath(categoryId),
      summary: `quiz draft ${categoryId}: ${summary.text}`,
      commitSha: '',
    });
    res.json({ published: false, draft: draftSummary(draft) });
  }));

  router.put('/settings', wrap(async (req, res) => {
    await needOwner(req);
    const id = String(req.body?.categoryId || '');
    categoryRepoPath(id);
    const enabled = req.body?.enabled === true;
    const file = await headOrNull(SETTINGS_REPO_PATH);
    if (!file) throw httpError(404, 'settings.json not found on GitHub.');
    const settings = JSON.parse(file.content);
    const current = new Set(settings.enabledCategories || []);
    if (enabled) current.add(id);
    else current.delete(id);
    settings.enabledCategories = [...current];
    settings.availableCategories = [...new Set([...(settings.availableCategories || []), id])];
    const result = await publishFiles([{ path: SETTINGS_REPO_PATH, content: `${JSON.stringify(settings, null, 2)}\n`, baseBlobSha: file.blobSha }], {
      message: `quiz: ${enabled ? 'enable' : 'disable'} ${id}`,
      actor: req.adminUser,
      summary: `quiz: ${enabled ? 'enable' : 'disable'} ${id}`,
    });
    res.json({ enabledCategories: settings.enabledCategories, ...result });
  }));

  router.get('/lists', wrap(async (req, res) => {
    await needAccess(req);
    res.json({ lists: await readLocalLists() });
  }));

  router.put('/lists/:name', wrap(async (req, res) => {
    await needOwner(req);
    const name = String(req.params.name);
    if (!LIST_NAME_RE.test(name)) throw httpError(400, 'Pool names use letters, numbers, and underscore.');
    const items = Array.isArray(req.body?.items) ? [...new Set(req.body.items.map((item) => String(item).trim()).filter(Boolean))] : null;
    if (!items) throw httpError(400, 'Items must be a list.');
    const file = await headOrNull(LISTS_REPO_PATH);
    const lists = file ? JSON.parse(file.content) : {};
    if (items.length) lists[name] = items;
    else delete lists[name];
    const result = await publishFiles([{ path: LISTS_REPO_PATH, content: `${JSON.stringify(lists, null, 2)}\n`, baseBlobSha: file?.blobSha }], {
      message: `quiz: ${items.length ? 'update' : 'remove'} $${name} pool`,
      actor: req.adminUser,
      summary: `quiz: $${name} pool (${items.length} items)`,
    });
    res.json({ lists, ...result });
  }));

  router.get('/coverage', wrap(async (req, res) => {
    await needAccess(req);
    res.json({ ...(await quizCoverage()), recipes: quizRecipes() });
  }));

  router.post('/generate', wrap(async (req, res) => {
    await needAccess(req);
    res.json(runRecipe(String(req.body?.recipe || ''), req.body?.keys));
  }));

  router.get('/drafts', wrap(async (req, res) => {
    const access = await needAccess(req);
    const me = req.adminUser.discordId;
    const drafts = (await listDrafts())
      .filter((d) => d.authorId === me || (access.role !== 'editor' && inScope(access, d.categoryId)))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(draftSummary);
    res.json({ drafts });
  }));

  router.get('/drafts/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    const draft = (await listDrafts()).find((d) => d.id === req.params.id);
    if (!draft) throw httpError(404, 'Draft not found.');
    const reviewer = access.role !== 'editor' && inScope(access, draft.categoryId);
    if (!reviewer && draft.authorId !== req.adminUser.discordId) throw httpError(403, 'Not your draft.');
    res.json({ draft });
  }));

  router.post('/drafts/:id/approve', wrap(async (req, res) => {
    const access = await needAccess(req);
    const draft = (await listDrafts()).find((d) => d.id === req.params.id);
    if (!draft) throw httpError(404, 'Draft not found.');
    if (access.role === 'editor' || !inScope(access, draft.categoryId)) throw httpError(403, 'Only reviewers and the owner can approve drafts.');
    let result;
    try {
      result = await publishCategory({
        categoryId: draft.categoryId,
        data: cleanCategory(draft.data),
        baseBlobSha: draft.baseBlobSha,
        message: `quiz: update ${draft.categoryId} by ${draft.authorName} (${draft.summary?.text || 'draft'})`,
        actor: req.adminUser,
        summary: `approved draft by ${draft.authorName}: ${draft.summary?.text || ''}`,
      });
    } catch (error) {
      if (error.statusCode === 409) throw httpError(409, 'The category changed after this draft was made. Open the draft in the editor and save it to merge.');
      throw error;
    }
    await locked(async () => writeState(DRAFTS_PATH, (await listDrafts()).filter((d) => d.id !== draft.id)));
    res.json({ ok: true, ...result });
  }));

  router.post('/drafts/:id/reject', wrap(async (req, res) => {
    const access = await needAccess(req);
    const note = String(req.body?.note || '').trim().slice(0, 500);
    const updated = await locked(async () => {
      const drafts = await listDrafts();
      const draft = drafts.find((d) => d.id === req.params.id);
      if (!draft) throw httpError(404, 'Draft not found.');
      if (access.role === 'editor' || !inScope(access, draft.categoryId)) throw httpError(403, 'Only reviewers and the owner can send drafts back.');
      draft.status = 'changes_requested';
      draft.note = note;
      draft.reviewedBy = req.adminUser.globalName || req.adminUser.username || req.adminUser.discordId;
      await writeState(DRAFTS_PATH, drafts);
      return draft;
    });
    res.json({ draft: draftSummary(updated) });
  }));

  router.delete('/drafts/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    await locked(async () => {
      const drafts = await listDrafts();
      const draft = drafts.find((d) => d.id === req.params.id);
      if (!draft) throw httpError(404, 'Draft not found.');
      if (draft.authorId !== req.adminUser.discordId && access.role !== 'owner') throw httpError(403, 'Not your draft.');
      await writeState(DRAFTS_PATH, drafts.filter((d) => d.id !== draft.id));
    });
    res.json({ ok: true });
  }));

  router.get('/editors', wrap(async (req, res) => {
    await needOwner(req);
    res.json({ editors: await listQuizEditors() });
  }));

  router.put('/editors', wrap(async (req, res) => {
    await needOwner(req);
    const row = cleanEditor(req.body?.editor, req.adminUser);
    const editors = await locked(async () => {
      const rows = await listQuizEditors();
      const prev = rows.find((item) => item.discordId === row.discordId);
      const next = [...rows.filter((item) => item.discordId !== row.discordId), prev ? { ...row, addedAt: prev.addedAt, addedBy: prev.addedBy } : row];
      await writeState(ACCESS_PATH, next);
      return next;
    });
    await recordAdminAudit({
      at: new Date().toISOString(),
      actor: req.adminUser.discordId,
      username: req.adminUser.username || null,
      file: 'data/quiz-access.json',
      summary: `quiz access: ${row.label || row.discordId} → ${row.role} (${row.categories.join(', ')})`,
      commitSha: '',
    });
    res.json({ editors });
  }));

  router.delete('/editors/:discordId', wrap(async (req, res) => {
    await needOwner(req);
    const id = String(req.params.discordId);
    const editors = await locked(async () => {
      const next = (await listQuizEditors()).filter((item) => item.discordId !== id);
      await writeState(ACCESS_PATH, next);
      return next;
    });
    await recordAdminAudit({
      at: new Date().toISOString(),
      actor: req.adminUser.discordId,
      username: req.adminUser.username || null,
      file: 'data/quiz-access.json',
      summary: `quiz access removed: ${id}`,
      commitSha: '',
    });
    res.json({ editors });
  }));

  router.use((error, _req, res, _next) => {
    jsonError(res, error);
  });

  parent.use('/quiz', router);
}
