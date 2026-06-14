/**
 * Regenerates stand-image entries in assets/quiz/categories/umaguesser.json.
 *
 * Uses assets/quiz/stand-filenames.json when present (exact filename lists).
 * Otherwise probes the Fujikiseki CDN for uma base × costume variant combinations.
 *
 * Usage: node scripts/generate-umaguesser-stands.js
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LISTS_PATH = path.join(ROOT, 'assets', 'quiz', 'lists.json');
const UMAS_PATH = path.join(ROOT, 'assets', 'quiz', 'categories', 'umas.json');
const STAND_FILENAMES_PATH = path.join(ROOT, 'assets', 'quiz', 'stand-filenames.json');
const UMAGUESSER_PATH = path.join(ROOT, 'assets', 'quiz', 'categories', 'umaguesser.json');

const CDN_BASE = 'https://cdn.fujikiseki.xyz/uma-assets';
const PROMPT = "Who's that uma? It's ...";
const MCQ_ANSWERS = ['$uma', '$uma', '$uma', '$uma', '$uma'];

const BASE_SLUG_OVERRIDES = {
  'TM Opera O': 't_m_opera_o',
  'Mr. C.B.': 'mr_c_b',
  'K.S. Miracle': 'k_s_miracle',
};

const SLUG_TO_BASE_OVERRIDES = Object.fromEntries(
  Object.entries(BASE_SLUG_OVERRIDES).map(([name, slug]) => [slug, name]),
);

const VARIANT_SLUG_OVERRIDES = {
  Original: 'original',
  'New Year': 'new_years',
  'Full Armor': 'full_armor',
  'Anime Collab': 'alt',
};

const VARIANT_SUFFIXES = [
  'new_years',
  'full_armor',
  'original',
  'christmas',
  'summer',
  'alt',
  'halloween',
  'wedding',
  'ballroom',
  'cheerleader',
  'festival',
  'fantasy',
  'warfare',
  'parade',
  'valentines',
  'camping',
  'autumn',
];

const VARIANT_LABELS = {
  original: 'Original',
  christmas: 'Christmas',
  summer: 'Summer',
  alt: 'Alt',
  halloween: 'Halloween',
  wedding: 'Wedding',
  ballroom: 'Ballroom',
  cheerleader: 'Cheerleader',
  festival: 'Festival',
  fantasy: 'Fantasy',
  warfare: 'Warfare',
  parade: 'Parade',
  valentines: 'Valentines',
  camping: 'Camping',
  autumn: 'Autumn',
  new_years: 'New Year',
  full_armor: 'Full Armor',
};

const EXTRA_BASE_NAMES = [
  'Admire Groove',
  'Air Messiah',
  'Almond Eye',
  'Believe',
  'Bitter Glasse',
  'Blast Onepiece',
  'Bubble Gum Fellow',
  'Buena Vista',
  'Byerley Turk',
  'Calstone Light O',
  'Casino Drive',
  'Cheval Grand',
  'Chrono Genesis',
  'Curren Bouquetd\'Or',
  'Dantsu Flame',
  'Daring Heart',
  'Daring Tact',
  'Darley Arabian',
  'Dream Journey',
  'Duramente',
  'Durandal',
  'Espoir City',
  'Fenomeno',
  'Forever Young',
  'Furioso',
  'Fusaichi Pandora',
  'Gentildonna',
  'Godolphin Barb',
  'Gran Alegria',
  'Happy Meek',
  'Haiseiko',
  'Kiseki',
  'Kiyoko Hoshina',
  'K.S. Miracle',
  'Little Cocon',
  'Lucky Lilac',
  'Marche Lorraine',
  'Mei Satake',
  'No Reason',
  'North Flight',
  'Red Desire',
  'Rhein Kraft',
  'Rigantona',
  'Rose Kingdom',
  'Royce and Royce',
  'Rulership',
  'Ryoka Tsurugi',
  'Saint Lite',
  'Sirius Symboli',
  'Sounds of Earth',
  'Speed Symboli',
  'Still in Love',
  'Transcend',
  'Tsurumaru Tsuyoshi',
  'Tucker Bryne',
  'Venus Paques',
  'Verxina',
  'Victoire Pisa',
  'Vivlos',
  'Win Variation',
];

const EXTRA_FILENAME_SUBJECTS = {
  curren_bouquetd_39_or_original: "Curren Bouquetd'Or (Original)",
};

const SKIP_FILENAME_PREFIXES = ['npc_'];

const STAND_TIERS = [
  { folder: 'stand-silhouette', difficulty: 'easy' },
  { folder: 'stand-medium', difficulty: 'hard' },
  { folder: 'stand-hard', difficulty: 'expert' },
];

function slugifyPart(value) {
  return String(value)
    .replace(/\./g, '')
    .replace(/'/g, '')
    .replace(/\s+/g, '_')
    .toLowerCase();
}

function baseNameToSlug(baseName) {
  return BASE_SLUG_OVERRIDES[baseName] || slugifyPart(baseName);
}

function subjectToFilenameStem(subject) {
  const match = String(subject).match(/^(.+?)\s*\((.+)\)$/);
  const baseName = match ? match[1].trim() : String(subject).trim();
  const variant = match ? match[2].trim() : 'Original';
  const baseSlug = baseNameToSlug(baseName);
  const variantSlug = VARIANT_SLUG_OVERRIDES[variant] || slugifyPart(variant);
  return `${baseSlug}_${variantSlug}`;
}

function titleCaseWords(value) {
  return String(value)
    .split(' ')
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(' ');
}

function slugToBaseName(slug) {
  if (SLUG_TO_BASE_OVERRIDES[slug]) return SLUG_TO_BASE_OVERRIDES[slug];
  return titleCaseWords(slug.replace(/_/g, ' '));
}

function parseFilenameStem(stem) {
  if (EXTRA_FILENAME_SUBJECTS[stem]) return EXTRA_FILENAME_SUBJECTS[stem];

  for (const suffix of VARIANT_SUFFIXES) {
    const needle = `_${suffix}`;
    if (!stem.endsWith(needle)) continue;
    const baseSlug = stem.slice(0, -needle.length);
    const baseName = slugToBaseName(baseSlug);
    const variantLabel = VARIANT_LABELS[suffix] || titleCaseWords(suffix.replace(/_/g, ' '));
    return `${baseName} (${variantLabel})`;
  }

  return slugToBaseName(stem.replace(/_original$/, ''));
}

function collectUmaSubjects(umasData) {
  const subjects = new Set();
  const walk = (entries) => {
    for (const entry of entries || []) {
      if (!Array.isArray(entry)) continue;
      const first = entry[0];
      if (typeof first === 'string' && !/^https?:/i.test(first)) {
        subjects.add(first.trim());
      }
    }
  };
  for (const group of umasData.questions || []) {
    walk(group.entries);
  }
  return [...subjects];
}

function buildCandidateMap(subjects, listBases) {
  const map = new Map();
  for (const subject of subjects) {
    map.set(subjectToFilenameStem(subject), subject);
  }
  for (const baseName of listBases) {
    for (const suffix of VARIANT_SUFFIXES) {
      const stem = `${baseNameToSlug(baseName)}_${suffix}`;
      if (!map.has(stem)) map.set(stem, `${baseName} (${VARIANT_LABELS[suffix]})`);
    }
  }
  for (const [stem, subject] of Object.entries(EXTRA_FILENAME_SUBJECTS)) {
    if (!map.has(stem)) map.set(stem, subject);
  }
  return map;
}

function shouldSkipFilename(filename) {
  const stem = filename.replace(/\.png$/i, '');
  return SKIP_FILENAME_PREFIXES.some((prefix) => stem.startsWith(prefix));
}

async function urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

async function resolveTierItems(folder, filenames, candidateMap, { verify = true } = {}) {
  const found = [];
  const entries = filenames
    .filter((filename) => !shouldSkipFilename(filename))
    .map((filename) => {
      const stem = filename.replace(/\.png$/i, '');
      const subject = candidateMap.get(stem) || parseFilenameStem(stem);
      return { stem, subject, url: `${CDN_BASE}/${folder}/${filename}` };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject));

  if (!verify) return entries;

  const batchSize = 25;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (entry) => ((await urlExists(entry.url)) ? entry : null)),
    );
    for (const item of results) {
      if (item) found.push(item);
    }
  }

  return found;
}

async function probeTier(folder, candidateMap) {
  const stems = [...candidateMap.keys()];
  const filenames = stems.map((stem) => `${stem}.png`);
  return resolveTierItems(folder, filenames, candidateMap);
}

function escapeJson(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatEntryLine(url, answers) {
  const answersStr = answers.map((answer) => `"${escapeJson(answer)}"`).join(', ');
  return `        ["${escapeJson(url)}",\n        [${answersStr}]]`;
}

function formatQuestionGroup(group) {
  const prompt = escapeJson(group.promptTemplate);
  const header = group.version
    ? `    { "promptTemplate": "${prompt}", "version": "${escapeJson(group.version)}",`
    : `    { "promptTemplate": "${prompt}",`;
  const entries = (group.entries || []).map((entry, index, list) => {
    const suffix = index < list.length - 1 ? ',' : '';
    return `${formatEntryLine(entry[0], entry[1])}${suffix}`;
  });
  return [
    header,
    `      "difficulty": "${escapeJson(group.difficulty)}",`,
    '      "entries": [',
    ...entries,
    '      ]',
    '    }',
  ].join('\n');
}

function buildStandGroup(difficulty, items) {
  return {
    promptTemplate: PROMPT,
    difficulty,
    entries: items.map(({ url, subject }) => [url, [subject, ...MCQ_ANSWERS]]),
  };
}

function extractPreservedGroups(umaguesser) {
  return (umaguesser.questions || []).filter((group) => {
    const prompt = String(group.promptTemplate || group.prompt || '');
    return !prompt.startsWith("Who's that uma?");
  });
}

async function main() {
  const umasData = JSON.parse(fs.readFileSync(UMAS_PATH, 'utf8'));
  const umaguesser = JSON.parse(fs.readFileSync(UMAGUESSER_PATH, 'utf8'));
  const lists = JSON.parse(fs.readFileSync(LISTS_PATH, 'utf8'));
  const listBases = [...new Set([...(lists.uma || []), ...EXTRA_BASE_NAMES])];
  const candidateMap = buildCandidateMap(collectUmaSubjects(umasData), listBases);

  const standFilenameData = fs.existsSync(STAND_FILENAMES_PATH)
    ? JSON.parse(fs.readFileSync(STAND_FILENAMES_PATH, 'utf8'))
    : null;

  const standGroups = [];
  for (const tier of STAND_TIERS) {
    const filenames = standFilenameData?.[tier.folder];
    const items = filenames
      ? await resolveTierItems(tier.folder, filenames, candidateMap, { verify: false })
      : await probeTier(tier.folder, candidateMap);
    console.log(`${tier.folder}: ${items.length} images`);
    standGroups.push(buildStandGroup(tier.difficulty, items));
  }

  const preserved = extractPreservedGroups(umaguesser);
  const groupsJson = [...standGroups, ...preserved].map(formatQuestionGroup).join(',\n');
  const output = `{
  "name": "${escapeJson(umaguesser.name || 'Umaguesser')}",
  "questions": [
${groupsJson}
  ]
}
`;

  fs.writeFileSync(UMAGUESSER_PATH, output, 'utf8');
  console.log(`Updated ${UMAGUESSER_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
