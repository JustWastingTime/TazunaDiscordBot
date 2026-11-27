import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import express from 'express';
import { isBotOwner } from './adminRole.js';
import { httpError, requireSignedIn } from './adminAuth.js';
import { recordAdminAudit } from './assetStore.js';
import { jsonError } from './dashboardAuth.js';
import { commitFiles, fastForwardLocalCheckout, getBlob, getFileAtHead } from './githubCommit.js';
import cache from './githubCache.js';
import { reloadQuizLists } from './quizLists.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUIZ_DIR = path.join(ROOT, 'assets', 'quiz');
const CATEGORIES_DIR = path.join(QUIZ_DIR, 'categories');
import { DATA_DIR } from './dataDir.js';
const ACCESS_PATH = path.join(DATA_DIR, 'quiz-access.json');

const SETTINGS_REPO_PATH = 'assets/quiz/settings.json';
const LISTS_REPO_PATH = 'assets/quiz/lists.json';
const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
const ROLES = ['editor', 'reviewer'];
const ID_RE = /^[a-z0-9_-]{1,40}$/;
const LIST_NAME_RE = /^[a-z][a-z0-9_]{0,30}$/i;
const MAX_PENDING_PER_USER = 30;
/** Drafts from the old review queue, before new questions went through Test. */
const OLD_DRAFTS_PATH = path.join(DATA_DIR, 'quiz-drafts.json');

/** New questions land here first, tagged with the category they are meant for. */
export const TEST_CATEGORY = 'testquestions';

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
  return Boolean(access && (access.categories.includes('*') || (categoryId && access.categories.includes(categoryId))));
}

/** Owner, reviewers, and editors allowed to publish can approve Test questions and edit live categories. */
function canPublishTo(access, categoryId) {
  return Boolean(access?.canPublish && inScope(access, categoryId));
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
// Test category submissions.

async function publishCategory({ categoryId, data, baseBlobSha, message, actor, summary }) {
  const repoPath = categoryRepoPath(categoryId);
  return publishFiles([{ path: repoPath, content: formatCategory(data), baseBlobSha }], {
    message: message || `quiz: update ${categoryId} (${summary})`,
    actor,
    summary: `quiz ${categoryId}: ${summary}`,
  });
}

/** Questions have no ids in the files, so address them by position plus a content hash. */
function questionId(question, index) {
  const hash = crypto.createHash('sha1').update(JSON.stringify(question)).digest('hex').slice(0, 10);
  return `${index}-${hash}`;
}

function findSubmission(data, id) {
  const index = Number(String(id || '').split('-')[0]);
  const question = Number.isInteger(index) ? data.questions?.[index] : null;
  if (!question || questionId(question, index) !== id) {
    const error = httpError(409, 'This Test question changed since you loaded it. Reload and try again.');
    error.noRetry = true;
    throw error;
  }
  return { index, question };
}

/**
 * Test changes re-read the files and only add, edit, or remove one question, so a commit that loses a race
 * (someone else saved, or GitHub served a slightly old head) is safe to replay on fresh data.
 */
async function withRetry(fn, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (error.statusCode !== 409 || error.noRetry || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

function submissionMeta(question) {
  return question?.submission && typeof question.submission === 'object' ? question.submission : null;
}

function submissionView(question, index) {
  const meta = submissionMeta(question);
  return {
    id: questionId(question, index),
    index,
    prompt: String(question.promptTemplate || question.prompt || ''),
    difficulty: question.difficulty || null,
    shape: Array.isArray(question.entries) ? 'template' : 'fixed',
    entries: Array.isArray(question.entries) ? question.entries.length : 1,
    target: meta?.target || null,
    note: meta?.note || '',
    by: meta?.by || null,
    byId: meta?.byId || null,
    at: meta?.at || null,
  };
}

async function readTest() {
  const file = await headOrNull(categoryRepoPath(TEST_CATEGORY));
  if (!file) throw httpError(404, 'The Test category file is missing on GitHub.');
  return { file, data: JSON.parse(file.content) };
}

async function checkTarget(access, target) {
  const id = String(target || '');
  categoryRepoPath(id);
  if (id === TEST_CATEGORY) throw httpError(400, 'Pick the category this question is meant for.');
  if (!(await localCategoryIds()).includes(id)) throw httpError(404, `No category named ${id}.`);
  if (!inScope(access, id)) throw httpError(403, 'You cannot add questions to that category.');
  return id;
}

/**
 * An old draft held a whole category file. Pull out what it actually changed:
 * new questions, entries added to an existing question, or an edited question.
 */
function draftQuestions(draft, base) {
  const before = base?.questions || [];
  const after = draft.data?.questions || [];
  const meta = { target: draft.categoryId, by: draft.authorName || null, byId: draft.authorId || null, at: draft.createdAt || new Date().toISOString() };
  const out = [];
  const strip = (q) => JSON.stringify({ ...q, entries: undefined });
  after.forEach((question, i) => {
    const prev = before[i];
    if (prev && JSON.stringify(prev) === JSON.stringify(question)) return;
    if (prev && Array.isArray(prev.entries) && Array.isArray(question.entries) && strip(prev) === strip(question)) {
      const had = new Set(prev.entries.map((e) => JSON.stringify(e)));
      const kept = prev.entries.every((e) => question.entries.some((x) => JSON.stringify(x) === JSON.stringify(e)));
      const added = question.entries.filter((e) => !had.has(JSON.stringify(e)));
      if (kept && added.length) {
        out.push({ ...question, entries: added, submission: { ...meta, note: `New entries for question ${i + 1}` } });
        return;
      }
    }
    out.push({ ...question, submission: { ...meta, note: prev ? `Edited version of question ${i + 1}` : '' } });
  });
  return out;
}

function cleanSubmission(raw, meta) {
  if (raw && typeof raw === 'object') delete raw.submission;
  const question = cleanQuestion(raw, 0);
  return { ...question, submission: meta };
}

function canChangeSubmission(access, question, discordId) {
  const meta = submissionMeta(question);
  return meta?.byId === discordId || canPublishTo(access, meta?.target || null);
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
    const categories = [];
    let test = null;
    for (const id of await localCategoryIds()) {
      const data = await readLocalJson(path.join(CATEGORIES_DIR, `${id}.json`), null);
      if (!data) continue;
      if (id === TEST_CATEGORY) {
        const views = (data.questions || []).map(submissionView);
        test = {
          id,
          name: data.name || id,
          total: views.length,
          waiting: views.filter((v) => v.target && canPublishTo(access, v.target)).length,
          mine: views.filter((v) => v.byId === req.adminUser.discordId).length,
        };
        continue;
      }
      categories.push({ ...categoryStats(id, data, settings), canEdit: canPublishTo(access, id), canSubmit: inScope(access, id) });
    }
    res.json({ categories, test });
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
    if (categoryId === TEST_CATEGORY) throw httpError(400, 'Edit Test questions from the Test board.');
    if (!canPublishTo(access, categoryId)) throw httpError(403, 'You cannot publish to this category. New questions go to Test.');
    const data = cleanCategory(req.body?.data);
    const head = await headOrNull(categoryRepoPath(categoryId));
    if (!head) throw httpError(404, 'Category not found on GitHub.');
    const summary = summarizeChange(JSON.parse(head.content), data);
    const baseBlobSha = String(req.body?.baseBlobSha || '');
    if (!baseBlobSha) throw httpError(400, 'Missing baseBlobSha. Reload the category.');
    const result = await publishCategory({ categoryId, data, baseBlobSha, message: req.body?.message, actor: req.adminUser, summary: summary.text });
    res.json({ summary, ...result });
  }));

  router.get('/test', wrap(async (req, res) => {
    const access = await needAccess(req);
    const { file, data } = await readTest();
    const me = req.adminUser.discordId;
    const oldDrafts = access.role === 'owner' ? (await readState(OLD_DRAFTS_PATH, [])).filter((d) => d?.data?.questions).length : 0;
    res.json({
      name: data.name || TEST_CATEGORY,
      blobSha: file.blobSha,
      oldDrafts,
      submissions: (data.questions || []).map((question, index) => {
        const view = submissionView(question, index);
        return { ...view, canApprove: Boolean(view.target) && canPublishTo(access, view.target), canEdit: canChangeSubmission(access, question, me) };
      }),
    });
  }));

  router.get('/test/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    const { data } = await readTest();
    const { index, question } = findSubmission(data, req.params.id);
    const view = submissionView(question, index);
    res.json({
      question,
      submission: { ...view, canApprove: Boolean(view.target) && canPublishTo(access, view.target), canEdit: canChangeSubmission(access, question, req.adminUser.discordId) },
    });
  }));

  router.post('/test', wrap(async (req, res) => {
    const access = await needAccess(req);
    const target = await checkTarget(access, req.body?.target);
    const actor = req.adminUser;
    const out = await withRetry(async () => {
    const { file, data } = await readTest();
    const mine = (data.questions || []).filter((q) => submissionMeta(q)?.byId === actor.discordId).length;
    if (!canPublishTo(access, target) && mine >= MAX_PENDING_PER_USER) {
      throw httpError(429, `You already have ${MAX_PENDING_PER_USER} questions in Test. Wait for some to be approved.`);
    }
    const question = cleanSubmission(req.body?.question, {
      target,
      by: actor.globalName || actor.username || actor.discordId,
      byId: actor.discordId,
      at: new Date().toISOString(),
    });
    data.questions = [...(data.questions || []), question];
    const index = data.questions.length - 1;
    const prompt = String(question.promptTemplate || question.prompt).slice(0, 60);
    const content = formatCategory(data);
    const written = JSON.parse(content).questions[index];
    const result = await publishFiles([{ path: categoryRepoPath(TEST_CATEGORY), content, baseBlobSha: file.blobSha }], {
      message: `quiz: submit "${prompt}" for ${target}`,
      actor,
      summary: `quiz test: submitted "${prompt}" for ${target}`,
    });
    return { id: questionId(written, index), ...result };
    });
    res.status(201).json(out);
  }));

  router.put('/test/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    const out = await withRetry(async () => {
    const { file, data } = await readTest();
    const { index, question: before } = findSubmission(data, req.params.id);
    if (!canChangeSubmission(access, before, req.adminUser.discordId)) throw httpError(403, 'Only the author or a reviewer can change this question.');
    const target = await checkTarget(access, req.body?.target);
    const meta = submissionMeta(before) || { by: null, byId: null, at: new Date().toISOString() };
    const question = cleanSubmission(req.body?.question, { ...meta, target });
    data.questions[index] = question;
    const prompt = String(question.promptTemplate || question.prompt).slice(0, 60);
    const content = formatCategory(data);
    const written = JSON.parse(content).questions[index];
    const result = await publishFiles([{ path: categoryRepoPath(TEST_CATEGORY), content, baseBlobSha: file.blobSha }], {
      message: req.body?.message || `quiz: edit test question "${prompt}"`,
      actor: req.adminUser,
      summary: `quiz test: edited "${prompt}"`,
    });
    return { id: questionId(written, index), ...result };
    });
    res.json(out);
  }));

  router.delete('/test/:id', wrap(async (req, res) => {
    const access = await needAccess(req);
    const out = await withRetry(async () => {
    const { file, data } = await readTest();
    const { index, question } = findSubmission(data, req.params.id);
    if (!canChangeSubmission(access, question, req.adminUser.discordId)) throw httpError(403, 'Only the author or a reviewer can remove this question.');
    data.questions.splice(index, 1);
    const prompt = String(question.promptTemplate || question.prompt || '').slice(0, 60);
    const result = await publishFiles([{ path: categoryRepoPath(TEST_CATEGORY), content: formatCategory(data), baseBlobSha: file.blobSha }], {
      message: `quiz: remove test question "${prompt}"`,
      actor: req.adminUser,
      summary: `quiz test: removed "${prompt}"`,
    });
    return { ok: true, ...result };
    });
    res.json(out);
  }));

  router.post('/test/:id/approve', wrap(async (req, res) => {
    const access = await needAccess(req);
    const target = await checkTarget(access, req.body?.target);
    if (!canPublishTo(access, target)) throw httpError(403, 'Only reviewers and the owner can approve into this category.');
    const keep = req.body?.keep === true;
    const mode = ['merge', 'replace'].includes(req.body?.mode) ? req.body.mode : 'new';
    const out = await withRetry(async () => {
    const { file: testFile, data: testData } = await readTest();
    const { index, question } = findSubmission(testData, req.params.id);
    const targetPath = categoryRepoPath(target);
    const targetFile = await headOrNull(targetPath);
    if (!targetFile) throw httpError(404, 'Target category not found on GitHub.');
    const targetData = JSON.parse(targetFile.content);
    const { submission: _meta, ...approved } = question;
    const live = cleanQuestion(approved, 0);
    let questionIndex;
    if (mode === 'merge') {
      questionIndex = Number(req.body?.questionIndex);
      const into = targetData.questions?.[questionIndex];
      if (!into || !Array.isArray(into.entries) || !Array.isArray(live.entries)) {
        throw httpError(400, 'Merging needs a template question on both sides. Add it as a new question instead.');
      }
      into.entries = [...into.entries, ...live.entries];
    } else if (mode === 'replace') {
      questionIndex = Number(req.body?.questionIndex);
      if (!targetData.questions?.[questionIndex]) throw httpError(400, 'That question no longer exists. Pick another one.');
      targetData.questions[questionIndex] = live;
    } else {
      targetData.questions = [...(targetData.questions || []), live];
      questionIndex = targetData.questions.length - 1;
    }
    const files = [{ path: targetPath, content: formatCategory(cleanCategory(targetData)), baseBlobSha: targetFile.blobSha }];
    if (!keep) {
      testData.questions.splice(index, 1);
      files.push({ path: categoryRepoPath(TEST_CATEGORY), content: formatCategory(testData), baseBlobSha: testFile.blobSha });
    }
    const prompt = String(live.promptTemplate || live.prompt || '').slice(0, 60);
    const by = submissionMeta(question)?.by;
    const what = mode === 'merge'
      ? `${live.entries.length} entries into question ${questionIndex + 1}`
      : mode === 'replace' ? `replacing question ${questionIndex + 1}` : `as question ${questionIndex + 1}`;
    const result = await publishFiles(files, {
      message: `quiz: approve "${prompt}"${by ? ` by ${by}` : ''} into ${target} (${what})`,
      actor: req.adminUser,
      summary: `quiz: approved "${prompt}"${by ? ` by ${by}` : ''} → ${target} ${what}`,
    });
    return { categoryId: target, questionIndex, ...result };
    });
    res.json(out);
  }));

  router.post('/test/import-drafts', wrap(async (req, res) => {
    await needOwner(req);
    const drafts = (await readState(OLD_DRAFTS_PATH, [])).filter((draft) => draft?.data?.questions);
    if (!drafts.length) return res.json({ imported: 0, skipped: [] });
    const questions = [];
    const skipped = [];
    for (const draft of drafts) {
      let base = null;
      try {
        base = JSON.parse(await getBlob(draft.baseBlobSha));
      } catch {
        // The old version is gone; compare against the file as it is now.
        base = await readLocalJson(path.join(CATEGORIES_DIR, `${draft.categoryId}.json`), null);
      }
      const found = draftQuestions(draft, base);
      if (!found.length) skipped.push({ id: draft.id, by: draft.authorName, reason: 'no new or changed questions' });
      questions.push(...found);
    }
    let result = null;
    if (questions.length) {
      result = await withRetry(async () => {
        const { file, data } = await readTest();
        data.questions = [...(data.questions || []), ...questions.map(({ submission, ...rest }) => cleanSubmission({ ...rest }, submission))];
        return publishFiles([{ path: categoryRepoPath(TEST_CATEGORY), content: formatCategory(data), baseBlobSha: file.blobSha }], {
          message: `quiz: move ${questions.length} old draft question${questions.length === 1 ? '' : 's'} into Test`,
          actor: req.adminUser,
          summary: `quiz test: imported ${questions.length} question(s) from ${drafts.length} old draft(s)`,
        });
      });
    }
    // Keep the old file as a backup instead of deleting it.
    await fs.rename(OLD_DRAFTS_PATH, `${OLD_DRAFTS_PATH.replace(/\.json$/, '')}.imported-${Date.now()}.json`).catch(() => {});
    res.json({ imported: questions.length, skipped, ...(result || {}) });
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
