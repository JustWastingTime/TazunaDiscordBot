import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpError } from './adminAuth.js';
import { commitFiles, getFileAtHead } from './githubCommit.js';
import cache, { localFiles, replaceCacheEntry } from './githubCache.js';
import { applyEntryChange } from './jsonEntrySplice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.resolve(__dirname, '..', 'assets');
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const AUDIT_PATH = path.join(DATA_DIR, 'admin-audit.json');
const AUDIT_LIMIT = 500;

const ENTRY_DATASETS = {
  skills: {
    cacheKey: 'skills',
    keyField: 'skill_name',
    headerKeys: ['skill_name', 'description'],
    public: true,
    summary(entry) {
      return {
        key: entry.skill_name,
        skill_name: entry.skill_name,
        rarity: entry.rarity || '',
        category: entry.category || '',
        description: entry.description || '',
        gametora_id: entry.gametora_id || '',
        upcoming: entry.upcoming ? '1' : '',
      };
    },
  },
  supporters: {
    cacheKey: 'supporters',
    keyField: 'id',
    headerKeys: ['id', '_event'],
    public: true,
    summary(entry) {
      return {
        key: entry.id,
        id: entry.id,
        card_name: entry.card_name || '',
        character_name: entry.character_name || '',
        rarity: entry.rarity || '',
        category: entry.category || '',
        thumbnail: entry.thumbnail || '',
      };
    },
  },
  characters: {
    cacheKey: 'characters',
    keyField: 'id',
    headerKeys: ['id'],
    public: true,
    summary(entry) {
      return {
        key: entry.id,
        id: entry.id,
        character_name: entry.character_name || '',
        type: entry.type || '',
        costume: entry.costume || '',
        rarity: entry.rarity || '',
        thumbnail: entry.thumbnail || '',
      };
    },
  },
};

function datasetOf(name) {
  const spec = ENTRY_DATASETS[name];
  const file = localFiles[spec?.cacheKey || name];
  if (!spec || !file) return null;
  return { name, file, repoPath: `assets/${file}`, ...spec };
}

function rawDatasetOf(name) {
  if (ENTRY_DATASETS[name]) return null;
  const file = localFiles[name];
  if (!file) return null;
  return { name, cacheKey: name, file, repoPath: `assets/${file}`, mode: 'raw' };
}

export function listDatasets() {
  const entries = Object.keys(ENTRY_DATASETS).map((name) => {
    const spec = datasetOf(name);
    return {
      name,
      mode: 'entries',
      public: true,
      file: spec.file,
      count: Array.isArray(cache[spec.cacheKey]) ? cache[spec.cacheKey].length : 0,
    };
  });
  const raw = Object.keys(localFiles)
    .filter((key) => !Object.values(ENTRY_DATASETS).some((spec) => spec.cacheKey === key))
    .map((name) => ({
      name,
      mode: 'raw',
      public: false,
      file: localFiles[name],
      count: Array.isArray(cache[name]) ? cache[name].length : 0,
    }));
  return [...entries, ...raw];
}

export function publicDataset(name) {
  const spec = datasetOf(name);
  if (!spec?.public) return null;
  return spec;
}

function skillNameSet() {
  return new Set((cache.skills || []).map((skill) => skill.skill_name).filter(Boolean));
}

function unknownSkills(names, label, warnings, known) {
  for (const name of names || []) {
    const text = String(name || '').trim();
    if (!text || text === '-') continue;
    if (!known.has(text)) warnings.push(`${label}: no skill named "${text}".`);
  }
}

export function validateEntry(datasetName, entry, { previousKey = null } = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw httpError(400, 'Entry must be a JSON object.');
  }
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const key = String(entry[spec.keyField] || '').trim();
  if (!key) throw httpError(400, `${spec.keyField} is required.`);
  const warnings = [];
  const known = skillNameSet();

  if (datasetName === 'skills') {
    if (typeof entry.description !== 'string') throw httpError(400, 'description is required.');
    if (entry.effect != null && !Array.isArray(entry.effect)) throw httpError(400, 'effect must be an array.');
    if (previousKey && previousKey !== key) known.delete(previousKey);
    known.add(key);
  }

  if (datasetName === 'supporters') {
    if (!String(entry.card_name || '').trim()) throw httpError(400, 'card_name is required.');
    if (!String(entry.character_name || '').trim()) throw httpError(400, 'character_name is required.');
    unknownSkills(entry.support_skills, 'support_skills', warnings, known);
    unknownSkills(entry.event_skills, 'event_skills', warnings, known);
    if (entry.unique && entry.unique !== '-') unknownSkills([entry.unique], 'unique', warnings, known);
  }

  if (datasetName === 'characters') {
    if (!String(entry.character_name || '').trim()) throw httpError(400, 'character_name is required.');
    if (entry.unique) unknownSkills([entry.unique], 'unique', warnings, known);
    unknownSkills(entry.skills, 'skills', warnings, known);
    unknownSkills(entry.potential, 'potential', warnings, known);
    unknownSkills(entry.event_skills, 'event_skills', warnings, known);
  }

  return { key, warnings };
}

function summarizeList(spec, query) {
  const q = String(query || '').trim().toLowerCase();
  const rows = (cache[spec.cacheKey] || [])
    .filter((entry) => entry && entry[spec.keyField] != null)
    .map((entry) => spec.summary(entry));
  if (!q) return rows;
  return rows.filter((row) => JSON.stringify(row).toLowerCase().includes(q));
}

export function listCachedEntries(datasetName, query) {
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  return summarizeList(spec, query);
}

export function getCachedEntry(datasetName, key) {
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const entry = (cache[spec.cacheKey] || []).find((item) => String(item?.[spec.keyField] || '') === String(key));
  if (!entry) throw httpError(404, `No entry named "${key}".`);
  return entry;
}

async function writeLocal(repoPath, content) {
  const dest = path.resolve(__dirname, '..', repoPath);
  if (!dest.startsWith(ASSETS_DIR)) throw httpError(400, 'Refusing to write outside assets.');
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, dest);
}

async function invalidateSkillMaps(skillName) {
  const slug = String(skillName || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return;
  const dir = path.join(ASSETS_DIR, 'generated', 'skill-maps');
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  await Promise.all(names
    .filter((name) => name.toLowerCase().includes(slug) && name.endsWith('.png'))
    .map((name) => fs.unlink(path.join(dir, name)).catch(() => {})));
}

export async function recordAdminAudit(row) {
  return appendAudit(row);
}

async function appendAudit(row) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  let rows = [];
  try {
    rows = JSON.parse(await fs.readFile(AUDIT_PATH, 'utf8'));
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }
  rows.push(row);
  if (rows.length > AUDIT_LIMIT) rows = rows.slice(rows.length - AUDIT_LIMIT);
  const tmp = `${AUDIT_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, AUDIT_PATH);
}

async function publish({ repoPath, content, baseBlobSha, message, cacheKey, actor, summary }) {
  const commit = await commitFiles([{ path: repoPath, content, baseBlobSha }], message);
  await writeLocal(repoPath, content);
  replaceCacheEntry(cacheKey, JSON.parse(content));
  await appendAudit({
    at: new Date().toISOString(),
    actor: actor?.discordId || null,
    username: actor?.username || null,
    file: repoPath,
    summary,
    commitSha: commit.commitSha,
  });
  return { commitSha: commit.commitSha, blobSha: commit.blobShas[repoPath] };
}

export async function readDatasetHead(datasetName) {
  const spec = datasetOf(datasetName) || rawDatasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const file = await getFileAtHead(spec.repoPath);
  return { blobSha: file.blobSha, commitSha: file.commitSha, file: spec.file };
}

export async function readEntryFromGitHub(datasetName, key) {
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const file = await getFileAtHead(spec.repoPath);
  const parsed = JSON.parse(file.content);
  const entry = parsed.find((item) => String(item?.[spec.keyField] || '') === String(key));
  if (!entry) throw httpError(404, `No entry named "${key}".`);
  return { entry, blobSha: file.blobSha, commitSha: file.commitSha };
}

export async function saveEntry(datasetName, { key, entry, afterKey, message, baseBlobSha, actor, creating }) {
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const { key: nextKey, warnings } = validateEntry(datasetName, entry, { previousKey: creating ? null : key });
  const file = await getFileAtHead(spec.repoPath);
  if (baseBlobSha && baseBlobSha !== file.blobSha) {
    throw httpError(409, 'File changed on GitHub. Reload and try again.');
  }
  const content = applyEntryChange(file.content, {
    keyField: spec.keyField,
    headerKeys: spec.headerKeys,
    op: creating ? 'add' : 'edit',
    key: creating ? null : key,
    entry,
    afterKey: afterKey || null,
  });
  const defaultMessage = creating
    ? `admin: add ${datasetName} ${nextKey}`
    : `admin: update ${datasetName} ${nextKey}`;
  const published = await publish({
    repoPath: spec.repoPath,
    content,
    baseBlobSha: file.blobSha,
    message: message || defaultMessage,
    cacheKey: spec.cacheKey,
    actor,
    summary: `${creating ? 'add' : 'update'} ${nextKey}`,
  });
  if (datasetName === 'skills') await invalidateSkillMaps(key || nextKey);
  return { ...published, key: nextKey, warnings };
}

export async function deleteEntry(datasetName, { key, message, baseBlobSha, actor }) {
  const spec = datasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  if (!key) throw httpError(400, 'Missing entry key.');
  const file = await getFileAtHead(spec.repoPath);
  if (baseBlobSha && baseBlobSha !== file.blobSha) {
    throw httpError(409, 'File changed on GitHub. Reload and try again.');
  }
  const content = applyEntryChange(file.content, {
    keyField: spec.keyField,
    headerKeys: spec.headerKeys,
    op: 'delete',
    key,
  });
  const published = await publish({
    repoPath: spec.repoPath,
    content,
    baseBlobSha: file.blobSha,
    message: message || `admin: delete ${datasetName} ${key}`,
    cacheKey: spec.cacheKey,
    actor,
    summary: `delete ${key}`,
  });
  if (datasetName === 'skills') await invalidateSkillMaps(key);
  return published;
}

export async function readRawFromGitHub(datasetName) {
  const spec = rawDatasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  const file = await getFileAtHead(spec.repoPath);
  return { text: file.content, blobSha: file.blobSha, commitSha: file.commitSha, file: spec.file };
}

export async function saveRawFile(datasetName, { text, message, baseBlobSha, actor }) {
  const spec = rawDatasetOf(datasetName);
  if (!spec) throw httpError(404, 'Unknown dataset.');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw httpError(400, `Invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed)) throw httpError(400, 'This asset must stay a JSON array.');
  const file = await getFileAtHead(spec.repoPath);
  if (baseBlobSha && baseBlobSha !== file.blobSha) {
    throw httpError(409, 'File changed on GitHub. Reload and try again.');
  }
  const content = text.endsWith('\n') ? text : `${text}\n`;
  return publish({
    repoPath: spec.repoPath,
    content,
    baseBlobSha: file.blobSha,
    message: message || `admin: update ${spec.file}`,
    cacheKey: spec.cacheKey,
    actor,
    summary: `replace ${spec.file}`,
  });
}

export async function listAudit(limit = 200) {
  try {
    const rows = JSON.parse(await fs.readFile(AUDIT_PATH, 'utf8'));
    if (!Array.isArray(rows)) return [];
    return rows.slice(-Math.max(1, Math.min(500, Number(limit) || 200))).reverse();
  } catch {
    return [];
  }
}
