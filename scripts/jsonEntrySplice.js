import { httpError } from './adminAuth.js';

function scanContainer(raw, start) {
  const open = raw[start];
  const close = open === '{' ? '}' : ']';
  if (close !== '}' && close !== ']') throw httpError(500, 'Expected a JSON object or array.');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw httpError(500, 'Unterminated JSON value.');
}

/** Top-level objects in a JSON array, with the key field read from each object. */
export function indexEntries(raw, keyField) {
  let i = 0;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (raw[i] !== '[') throw httpError(500, 'Asset file is not a JSON array.');
  i += 1;
  const entries = [];
  while (i < raw.length) {
    while (i < raw.length && /[\s,]/.test(raw[i])) i += 1;
    if (i >= raw.length || raw[i] === ']') break;
    if (raw[i] !== '{') throw httpError(500, `Expected an object entry at offset ${i}.`);
    const start = i;
    const end = scanContainer(raw, i);
    const text = raw.slice(start, end);
    let key = null;
    try {
      const obj = JSON.parse(text);
      if (obj && obj[keyField] != null) key = String(obj[keyField]);
    } catch (error) {
      throw httpError(500, `Could not parse an entry: ${error.message}`);
    }
    entries.push({ start, end, key });
    i = end;
  }
  return entries;
}

function formatPrimitive(value) {
  return JSON.stringify(value);
}

function formatValue(value, key, indent) {
  if (key === 'results' && Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    const pad = ' '.repeat(indent);
    const inner = ' '.repeat(indent + 4);
    if (!value.length) return '[]';
    return `\n${pad}[\n${value.map((item) => `${inner}${JSON.stringify(item)}`).join(',\n')}\n${pad}]`;
  }
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const pad = ' '.repeat(indent);
    const inner = indent + 4;
    const items = value.map((item) => `${' '.repeat(inner)}${formatValue(item, null, inner)}`);
    return `[\n${items.join(',\n')}\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const pad = ' '.repeat(indent);
    const inner = indent + 4;
    const lines = keys.map((child, index) => {
      const comma = index < keys.length - 1 ? ',' : '';
      return `${' '.repeat(inner)}${JSON.stringify(child)}: ${formatValue(value[child], child, inner)}${comma}`;
    });
    return `{\n${lines.join('\n')}\n${pad}}`;
  }
  return formatPrimitive(value);
}

/** Compact opening line so the subject stays visible when the entry is folded. */
export function formatEntry(obj, headerKeys = []) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw httpError(400, 'Entry must be a JSON object.');
  }
  const keys = Object.keys(obj);
  const header = [];
  for (const key of headerKeys) {
    if (!keys.includes(key)) continue;
    const value = obj[key];
    if (value != null && typeof value === 'object') continue;
    header.push(key);
  }
  const rest = keys.filter((key) => !header.includes(key));
  if (!header.length) {
    const lines = ['{'];
    rest.forEach((key, index) => {
      const comma = index < rest.length - 1 ? ',' : '';
      lines.push(`        ${JSON.stringify(key)}: ${formatValue(obj[key], key, 8)}${comma}`);
    });
    lines.push('    }');
    return lines.join('\n');
  }
  const headerText = header.map((key) => `${JSON.stringify(key)}: ${JSON.stringify(obj[key])}`).join(', ');
  const lines = [`{   ${headerText}${rest.length ? ',' : ''}`];
  rest.forEach((key, index) => {
    const comma = index < rest.length - 1 ? ',' : '';
    lines.push(`        ${JSON.stringify(key)}: ${formatValue(obj[key], key, 8)}${comma}`);
  });
  lines.push('    }');
  return lines.join('\n');
}

function findOne(entries, key) {
  const matches = entries.filter((entry) => entry.key === String(key));
  if (!matches.length) throw httpError(404, `No entry named "${key}".`);
  if (matches.length > 1) throw httpError(409, `More than one entry is named "${key}".`);
  return matches[0];
}

function removeEntry(raw, start, end) {
  let from = start;
  let to = end;
  let after = end;
  while (after < raw.length && /[ \t]/.test(raw[after])) after += 1;
  if (raw[after] === ',') {
    to = after + 1;
    if (raw[to] === '\r') to += 1;
    if (raw[to] === '\n') to += 1;
    let lineStart = start;
    while (lineStart > 0 && raw[lineStart - 1] !== '\n') lineStart -= 1;
    if (raw.slice(lineStart, start).trim() === '') from = lineStart;
  } else {
    let k = start - 1;
    while (k >= 0 && /\s/.test(raw[k])) k -= 1;
    if (raw[k] === ',') from = k;
  }
  return raw.slice(0, from) + raw.slice(to);
}

function assertParses(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('root is not an array');
    return parsed;
  } catch (error) {
    throw httpError(500, `Refusing to save invalid JSON: ${error.message}`);
  }
}

/**
 * Replace, insert, or delete one top-level object without rewriting the rest of the file.
 * Returns the new file text. Throws if the result is not valid JSON.
 */
export function applyEntryChange(raw, { keyField, headerKeys, op, key, entry, afterKey }) {
  const entries = indexEntries(raw, keyField);
  let next = raw;

  if (op === 'edit') {
    const current = findOne(entries, key);
    const newKey = entry?.[keyField] != null ? String(entry[keyField]) : '';
    if (newKey && newKey !== String(key) && entries.some((item) => item.key === newKey)) {
      throw httpError(409, `"${newKey}" already exists.`);
    }
    const formatted = formatEntry(entry, headerKeys);
    next = raw.slice(0, current.start) + formatted + raw.slice(current.end);
  } else if (op === 'delete') {
    const current = findOne(entries, key);
    next = removeEntry(raw, current.start, current.end);
  } else if (op === 'add') {
    const newKey = entry?.[keyField] != null ? String(entry[keyField]) : '';
    if (!newKey) throw httpError(400, `${keyField} is required.`);
    if (entries.some((item) => item.key === newKey)) {
      throw httpError(409, `"${newKey}" already exists.`);
    }
    const formatted = formatEntry(entry, headerKeys);
    if (!entries.length) {
      const open = raw.indexOf('[');
      const close = raw.lastIndexOf(']');
      if (open < 0 || close < 0) throw httpError(500, 'Asset file is not a JSON array.');
      next = `${raw.slice(0, open + 1)}\n    ${formatted}\n${raw.slice(close)}`;
    } else {
      const anchor = afterKey ? findOne(entries, afterKey) : entries[entries.length - 1];
      const insertion = `,\n    ${formatted}`;
      next = raw.slice(0, anchor.end) + insertion + raw.slice(anchor.end);
    }
  } else {
    throw httpError(400, 'Unknown entry operation.');
  }

  assertParses(next);
  if (!next.endsWith('\n')) next += '\n';
  return next;
}
