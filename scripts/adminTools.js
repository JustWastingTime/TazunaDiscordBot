import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildActivationMapForSkill } from './generateActivationMaps.js';

const CONDITIONS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'conditions.json');

let RULES = null;
let FIELD_RANK = new Map();

function rules() {
  if (!RULES) {
    RULES = JSON.parse(fs.readFileSync(CONDITIONS_PATH, 'utf8'));
    FIELD_RANK = new Map((RULES.fieldOrder || []).map((name, index) => [name, index]));
  }
  return RULES;
}

const OP_RE = /(>=|<=|==|!=|>|<)/;
const CM_FIELD = 9;
const TT_FIELD = 12;

function normalizeOps(text) {
  return String(text || '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/\r/g, '');
}

function splitTopLevel(expr, joinerChars) {
  const parts = [];
  let buf = '';
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && joinerChars.includes(ch)) {
      if (buf.trim()) parts.push({ text: buf.trim(), joiner: ch });
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) parts.push({ text: buf.trim(), joiner: null });
  return parts;
}

function stripParens(s) {
  let t = s.trim();
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < t.length; i += 1) {
      if (t[i] === '(') depth += 1;
      if (t[i] === ')') depth -= 1;
      if (depth === 0 && i < t.length - 1) {
        balanced = false;
        break;
      }
    }
    if (!balanced || depth !== 0) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function fieldRank(field) {
  if (!field) return 9000;
  if (FIELD_RANK.has(field)) return FIELD_RANK.get(field);
  return 8000;
}

function phaseLabel(value) {
  return rules().fields.phase.values[String(value)] || `phase ${value}`;
}

function ordinal(n) {
  const num = Number(n);
  const v = num % 100;
  if (v >= 11 && v <= 13) return `${num}th`;
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

function positionRange(op, value, fieldSize) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  let start;
  let end;
  if (op === '>=') { start = n; end = fieldSize; }
  else if (op === '>') { start = n + 1; end = fieldSize; }
  else if (op === '<=') { start = 1; end = n; }
  else if (op === '<') { start = 1; end = n - 1; }
  else if (op === '==') return ordinal(n);
  else return null;
  start = Math.max(1, Math.min(fieldSize, start));
  end = Math.max(1, Math.min(fieldSize, end));
  if (start > end) return null;
  if (start === end) return ordinal(start);
  return `${ordinal(start)} to ${ordinal(end)}`;
}

function applyPlacementBound(bounds, op, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  if (op === '>=') bounds.start = Math.max(bounds.start, n);
  else if (op === '>') bounds.start = Math.max(bounds.start, n + 1);
  else if (op === '<=') bounds.end = Math.min(bounds.end, n);
  else if (op === '<') bounds.end = Math.min(bounds.end, n - 1);
  else if (op === '==') { bounds.start = n; bounds.end = n; }
}

function mergePlacementConstraints(constraints) {
  if (!constraints?.length) return null;
  const cm = { start: 1, end: CM_FIELD };
  const tt = { start: 1, end: TT_FIELD };
  let hasCm = false;
  let hasTt = false;
  for (const c of constraints) {
    if (c.side === 'cm') { applyPlacementBound(cm, c.op, c.value); hasCm = true; }
    else if (c.side === 'tt') { applyPlacementBound(tt, c.op, c.value); hasTt = true; }
  }
  if (!hasCm && !hasTt) return null;
  return { cm: hasCm ? cm : null, tt: hasTt ? tt : null };
}

function extractPlacementHints(raw) {
  const text = normalizeOps(raw);
  const constraints = [];
  const patterns = [
    {
      re: /\(\s*CM\s*(>=|<=|==|!=|>|<)\s*(-?\d+)\s*\|\s*(?:LoH|LOH|TT)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)\s*\)/gi,
      map: (cmOp, cmVal, ttOp, ttVal) => {
        constraints.push({ side: 'cm', op: cmOp, value: Number(cmVal) });
        constraints.push({ side: 'tt', op: ttOp, value: Number(ttVal) });
      },
    },
    {
      re: /\(\s*(?:LoH|LOH|TT)\s*(>=|<=|==|!=|>|<)\s*(-?\d+)\s*\|\s*CM\s*(>=|<=|==|!=|>|<)\s*(-?\d+)\s*\)/gi,
      map: (ttOp, ttVal, cmOp, cmVal) => {
        constraints.push({ side: 'tt', op: ttOp, value: Number(ttVal) });
        constraints.push({ side: 'cm', op: cmOp, value: Number(cmVal) });
      },
    },
  ];
  let cleaned = text;
  for (const { re, map } of patterns) {
    cleaned = cleaned.replace(re, (...args) => {
      map(args[1], args[2], args[3], args[4]);
      return '';
    });
  }
  return { hints: mergePlacementConstraints(constraints), cleaned };
}

function formatBoundsRange(bounds, fieldSize) {
  if (!bounds) return null;
  const start = Math.max(1, Math.min(fieldSize, bounds.start));
  const end = Math.max(1, Math.min(fieldSize, bounds.end));
  if (start > end) return null;
  if (start === end) return ordinal(start);
  return `${ordinal(start)} to ${ordinal(end)}`;
}

function formatPlacementHint(hints) {
  if (!hints) return null;
  if (hints.cm?.op != null || hints.tt?.op != null) {
    const cm = hints.cm ? positionRange(hints.cm.op, hints.cm.value, CM_FIELD) : null;
    const tt = hints.tt ? positionRange(hints.tt.op, hints.tt.value, TT_FIELD) : null;
    if (!cm || !tt) return null;
    return `${cm} (CM), ${tt} (TT)`;
  }
  const cm = formatBoundsRange(hints.cm, CM_FIELD);
  const tt = formatBoundsRange(hints.tt, TT_FIELD);
  if (!cm || !tt) return null;
  return `${cm} (CM), ${tt} (TT)`;
}

function formatField(field, op, value, placementHints) {
  const def = rules().fields[field];
  if (!def) return `${field} ${op} ${value}`;
  if (def.special === 'order_rate' || field === 'order') {
    if (placementHints) {
      const fromHint = formatPlacementHint(placementHints);
      if (fromHint) return fromHint;
    }
    if (def.special === 'order_rate') {
      const note = rules().order_rate_notes?.[op]?.[String(value)];
      if (note) return note;
      const rate = Number(value);
      if (Number.isFinite(rate)) {
        const derived = formatPlacementHint({
          cm: { op, value: Math.max(1, Math.ceil((rate / 100) * CM_FIELD)) },
          tt: { op, value: Math.max(1, Math.ceil((rate / 100) * TT_FIELD)) },
        });
        if (derived) return derived;
      }
      return `Order rate ${op} ${value}`;
    }
  }
  if (def.ops && typeof def.ops[op] === 'object' && def.ops[op][String(value)] != null) {
    return def.ops[op][String(value)];
  }
  if (field === 'phase') {
    if (op === '>=') return `${phaseLabel(value)} and beyond`;
    if (op === '<=' && String(value) === '1') return 'Early race or mid race';
    if (op === '<=') return `Up to ${phaseLabel(value)}`;
    if (op === '==') return phaseLabel(value);
    if (op === '!=') return `Not ${phaseLabel(value)}`;
  }
  if (def.ops && typeof def.ops[op] === 'string') {
    return def.ops[op]
      .replaceAll('{value}', value)
      .replaceAll('{op}', op)
      .replaceAll('{prev}', String(Number(value) - 1))
      .replaceAll('{inv}', String(100 - Number(value)));
  }
  if (def.values && def.values[String(value)] != null && (op === '==' || op == null)) return def.values[String(value)];
  if (def.values && def.values[String(value)] != null && op === '!=') return `Not ${def.values[String(value)]}`;
  if (def.label) {
    return def.label
      .replaceAll('{value}', value)
      .replaceAll('{op}', op)
      .replaceAll('{prev}', String(Number(value) - 1))
      .replaceAll('{inv}', String(100 - Number(value)));
  }
  if (def.bare && (value == null || value === '' || value === '1')) return def.bare;
  return `${field} ${op} ${value}`;
}

function parseAtomRaw(raw) {
  const text = stripParens(raw);
  if (!text) return null;
  if (!OP_RE.test(text) && rules().fields[text]) return { field: text, op: null, value: null, raw: text };
  const match = text.match(/^([a-zA-Z0-9_]+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return { field: null, op: null, value: null, raw: text };
  return { field: match[1], op: match[2], value: match[3], raw: text };
}

function entryFromAtom(raw, placementHints) {
  const parsed = parseAtomRaw(raw);
  if (!parsed) return null;
  const text = parsed.field != null ? formatField(parsed.field, parsed.op, parsed.value, placementHints) : parsed.raw;
  if (!text) return null;
  return { field: parsed.field, text, rank: fieldRank(parsed.field) };
}

function tryCompounds(atoms) {
  for (const compound of rules().compounds || []) {
    const needed = compound.match.map((item) => item.replace(/\s+/g, ''));
    const normalized = atoms.map((item) => item.replace(/\s+/g, ''));
    if (needed.every((item) => normalized.includes(item))) return compound;
  }
  return null;
}

function translateExpr(expr, placementHints) {
  const cleaned = stripParens(normalizeOps(expr).replace(/\n+/g, '&').replace(/\s+/g, '').replace(/&+/g, '&'));
  if (!cleaned) return [];
  const andParts = splitTopLevel(cleaned, ['&']);
  const flatAtoms = andParts.map((part) => stripParens(part.text));
  const hasOr = flatAtoms.some((atom) => atom.includes('@') || atom.includes('|') || atom.includes('('));
  if (!hasOr) {
    const compound = tryCompounds(flatAtoms);
    if (compound && flatAtoms.length === 2) {
      return [{ field: 'is_finalcorner', text: compound.text, rank: fieldRank('is_finalcorner') }];
    }
  }
  const entries = [];
  let orderRateEmitted = false;
  const placementText = formatPlacementHint(placementHints);
  for (const part of andParts) {
    const chunk = stripParens(part.text);
    if (chunk.includes('@') || chunk.includes('|') || (chunk.includes('(') && chunk.includes(')'))) {
      const orParts = splitTopLevel(chunk, ['@', '|']);
      if (orParts.length > 1) {
        const parsed = orParts.map((item) => entryFromAtom(item.text, placementHints)).filter(Boolean);
        if (!parsed.length) continue;
        entries.push({
          field: parsed[0].field,
          text: parsed.map((item) => item.text).join(' OR '),
          rank: Math.min(...parsed.map((item) => item.rank)),
        });
        continue;
      }
    }
    const parsed = parseAtomRaw(chunk);
    if (parsed?.field === 'order_rate' || parsed?.field === 'order') {
      if (orderRateEmitted) continue;
      if (placementText) {
        entries.push({ field: 'order_rate', text: placementText, rank: fieldRank('order_rate') });
        orderRateEmitted = true;
        continue;
      }
    }
    const entry = entryFromAtom(chunk, placementHints);
    if (entry) entries.push(entry);
    if (entry?.field === 'order_rate' || entry?.field === 'order') orderRateEmitted = true;
  }
  const idxFinal = entries.findIndex((entry) => entry.text === 'Final corner and beyond');
  const idxCorner = entries.findIndex((entry) => entry.text === 'Any corner' || entry.text === 'Not a corner');
  if (idxFinal >= 0 && idxCorner >= 0) {
    const cornerLine = entries[idxCorner].text;
    entries[idxFinal].text = cornerLine === 'Not a corner' ? 'Final non-corner' : 'Final corner';
    entries[idxFinal].field = 'is_finalcorner';
    entries[idxFinal].rank = fieldRank('is_finalcorner');
    entries.splice(idxCorner, 1);
  }
  return entries;
}

function formatOutput(entries) {
  const lines = [...entries]
    .sort((a, b) => (a.rank - b.rank) || String(a.text).localeCompare(String(b.text)))
    .map((entry) => entry.text)
    .filter(Boolean);
  return { lines, text: lines.map((line) => `${JSON.stringify(line)},`).join('\n') };
}

/** Raw skill condition code → English lines, in skill.json order. */
export function convertConditions(input) {
  rules();
  const { hints, cleaned: rawWithoutHints } = extractPlacementHints(input);
  const code = normalizeOps(rawWithoutHints).split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
  const blocks = code.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (blocks.length <= 1) {
    return formatOutput(translateExpr(code.replace(/\n/g, '&').replace(/&+/g, '&'), hints));
  }
  const all = [];
  for (const block of blocks) all.push(...translateExpr(block.replace(/\n/g, '&').replace(/&+/g, '&'), hints));
  return formatOutput(all);
}

const CHAIN_MARK = /^[（(]?[❯>]+[）)]?\s*$/;
const CHOICE_MARK = /^(?:[（(])?(Top|Bottom|Bot|Middle|Mid|Left|Right|Option\s*\d+)(?:[）)])?$/i;
const RANDOM_EITHER = /^randomly\s+either$/i;
const OR_SEP = /^or$/i;

function isRewardLine(line) {
  return /(?:\+|-)\d+|hint|bond|energy|mood|skill points|event chain ended|fans/i.test(line);
}
function isChoiceLabel(line) { return CHOICE_MARK.test(String(line || '').trim()); }
function isRandomEither(line) { return RANDOM_EITHER.test(String(line || '').trim()); }
function isOrSeparator(line) { return OR_SEP.test(String(line || '').trim()); }
function isStructureLine(line) {
  const t = String(line || '').trim();
  return isChoiceLabel(t) || isRandomEither(t) || isOrSeparator(t) || CHAIN_MARK.test(t);
}

function normalizeReward(line) {
  let text = String(line || '').trim();
  if (!text) return '';
  const namedBond = text.match(/^(.+?)\s+bond\s*([+-]?\d+)\s*$/i);
  if (namedBond) {
    const delta = namedBond[2].startsWith('+') || namedBond[2].startsWith('-') ? namedBond[2] : `+${namedBond[2]}`;
    return `Bond ${delta}`;
  }
  const bareBond = text.match(/^bond\s*([+-]?\d+)\s*$/i);
  if (bareBond) {
    const delta = bareBond[1].startsWith('+') || bareBond[1].startsWith('-') ? bareBond[1] : `+${bareBond[1]}`;
    return `Bond ${delta}`;
  }
  return text;
}

function joinBranch(lines) {
  const normalized = lines.map(normalizeReward).filter(Boolean);
  if (!normalized.length) return '';
  const bonds = normalized.filter((text) => /^Bond\s*[+-]?\d+/i.test(text));
  const hints = normalized.filter((text) => /\bhint\b/i.test(text));
  if (!bonds.length || !hints.length) return normalized.join(', ');
  const out = [];
  let emitted = false;
  for (const item of normalized) {
    if (/^Bond\s*[+-]?\d+/i.test(item) || /\bhint\b/i.test(item)) {
      if (!emitted) { out.push(...bonds, ...hints); emitted = true; }
      continue;
    }
    out.push(item);
  }
  return out.join(', ');
}

function joinRewards(lines) {
  const cleaned = lines.map((line) => String(line || '').trim()).filter((line) => line && !isChoiceLabel(line));
  const hasRandom = cleaned.some(isRandomEither);
  const orIndexes = cleaned.filter(isOrSeparator);
  if (hasRandom || orIndexes.length) {
    const branches = [];
    let current = [];
    for (const line of cleaned.filter((line) => !isRandomEither(line))) {
      if (isOrSeparator(line)) { branches.push(current); current = []; continue; }
      current.push(line);
    }
    branches.push(current);
    return branches.map(joinBranch).filter(Boolean).join(', OR ');
  }
  return joinBranch(cleaned);
}

function parseSingleEvent(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length);
  if (!lines.length) return null;
  const type = lines.some((line) => CHAIN_MARK.test(line.trim())) ? 'chain' : 'event';
  const body = lines.filter((line) => !CHAIN_MARK.test(line));
  const choiceIndexes = [];
  body.forEach((line, index) => { if (isChoiceLabel(line)) choiceIndexes.push(index); });
  if (choiceIndexes.length >= 1) {
    const name = body.slice(0, choiceIndexes[0]).filter((line) => !isStructureLine(line)).join(' ').trim() || 'Untitled Event';
    const results = [];
    for (let c = 0; c < choiceIndexes.length; c += 1) {
      const start = choiceIndexes[c];
      const end = c + 1 < choiceIndexes.length ? choiceIndexes[c + 1] : body.length;
      results.push(joinRewards(body.slice(start + 1, end)));
    }
    return { name, type, results: results.filter((result) => result.length) };
  }
  let name = '';
  const rewards = [];
  for (const line of body) {
    if (isStructureLine(line) && !isRandomEither(line) && !isOrSeparator(line)) continue;
    if (!name && !isRewardLine(line) && !isRandomEither(line) && !isOrSeparator(line)) {
      name = line.replace(/^[（(]?[❯>]+[）)]?\s*/, '').trim();
      continue;
    }
    if (!name) { name = line; continue; }
    rewards.push(line);
  }
  if (!name) return null;
  return { name, type, results: [joinRewards(rewards) || ''] };
}

/** Pasted event text → supporter.json event objects. */
export function parseEvents(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];
  const chunks = [];
  let current = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length) { chunks.push(current.join('\n')); current = []; }
      continue;
    }
    if (CHAIN_MARK.test(trimmed) && current.length) {
      chunks.push(current.join('\n'));
      current = [trimmed];
      continue;
    }
    current.push(trimmed);
  }
  if (current.length) chunks.push(current.join('\n'));
  return chunks.map(parseSingleEvent).filter(Boolean);
}

/** English condition lines, or raw condition code, → an activation_map object (or null). */
export function suggestActivationMap(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const looksLikeCode = /[a-zA-Z_]+\s*(>=|<=|==|!=|>|<)/.test(text);
  const lines = looksLikeCode
    ? convertConditions(text).lines
    : text.split(/\r?\n/).map((line) => line.replace(/^["']|["'],?$/g, '').trim()).filter(Boolean);
  return buildActivationMapForSkill({
    description: lines.join(' '),
    effect: [{ description: lines.join(' '), conditions: lines }],
  });
}
