import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { httpError } from './adminAuth.js';
import { recordAdminAudit } from './assetStore.js';
import { getEvent, listEventSources, reloadEventDefinitions } from './eventStorage.js';
import { commitFiles, fastForwardLocalCheckout, getFileAtHead } from './githubCommit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EVENTS_DIR = path.resolve(__dirname, '..', 'assets', 'events');

function repoPathFor(fileName) {
  const base = path.basename(String(fileName || ''));
  if (!base || base !== fileName || !base.endsWith('.json') || base.includes('..')) {
    throw httpError(400, 'Invalid event file.');
  }
  return `assets/events/${base}`;
}

function sourceById(eventId) {
  return listEventSources().find((source) => source.definition.id === String(eventId)) || null;
}

export function listGambaEvents() {
  return listEventSources()
    .map((source) => {
      const live = getEvent(source.definition.id);
      return {
        id: source.definition.id,
        name: source.definition.name,
        status: live?.status || source.definition.status,
        startsAt: source.definition.startsAt,
        endsAt: source.definition.endsAt,
        file: source.file,
        entryCount: source.definition.entries.length,
        availability: source.definition.availability,
        listing: source.definition.listing || 'board',
      };
    })
    .sort((a, b) => (Date.parse(b.startsAt || '') || 0) - (Date.parse(a.startsAt || '') || 0) || a.name.localeCompare(b.name));
}

export async function readGambaEvent(eventId) {
  const source = sourceById(eventId);
  if (!source) throw httpError(404, 'Event not found.');
  const repoPath = repoPathFor(source.file);
  let blobSha = null;
  try {
    blobSha = (await getFileAtHead(repoPath)).blobSha;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  return { event: source.definition, file: source.file, blobSha };
}

function cleanEvent(raw) {
  if (!raw || typeof raw !== 'object') throw httpError(400, 'Missing event.');
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  if (!id || !name) throw httpError(400, 'Event id and name are required.');
  if (/[\\/]/.test(id)) throw httpError(400, 'Event id cannot contain a slash.');
  const entries = Array.isArray(raw.entries) ? raw.entries : [];
  if (!entries.length) throw httpError(400, 'Add at least one entry.');
  const availability = String(raw.availability || 'all');
  if (availability !== 'all' && availability !== 'guilds' && availability !== 'web') {
    throw httpError(400, 'Availability must be all, guilds, or web.');
  }
  const listing = availability === 'web' ? 'tournament' : 'board';
  return {
    id,
    name,
    type: String(raw.type || 'horse_race').trim() || 'horse_race',
    status: String(raw.status || 'scheduled').trim() || 'scheduled',
    startsAt: raw.startsAt ? String(raw.startsAt).trim() : null,
    endsAt: raw.endsAt ? String(raw.endsAt).trim() : null,
    availability,
    listing,
    guildIds: availability === 'guilds' && Array.isArray(raw.guildIds) ? raw.guildIds.map((id) => String(id).trim()).filter(Boolean) : [],
    threadId: raw.threadId ? String(raw.threadId).trim() : null,
    entries: entries.map((entry, index) => {
      const odds = Number(entry?.odds);
      const number = Number(entry?.number);
      if (!entry?.name || !Number.isFinite(number) || !Number.isFinite(odds)) {
        throw httpError(400, `Entry ${index + 1} needs a number, name, and odds.`);
      }
      return {
        number,
        name: String(entry.name).trim(),
        ageSex: entry.ageSex ? String(entry.ageSex).trim() : '',
        jockey: entry.jockey ? String(entry.jockey).trim() : '',
        odds,
      };
    }),
  };
}

function formatEvent(event) {
  const lines = event.entries.map((entry) => `    { "number": ${entry.number}, "name": ${JSON.stringify(entry.name)}, "ageSex": ${JSON.stringify(entry.ageSex)}, "jockey": ${JSON.stringify(entry.jockey)}, "odds": ${entry.odds} }`);
  const thread = event.threadId ? `\n  "threadId": ${JSON.stringify(event.threadId)},` : '';
  return `{
  "id": ${JSON.stringify(event.id)},
  "name": ${JSON.stringify(event.name)},
  "type": ${JSON.stringify(event.type)},
  "status": ${JSON.stringify(event.status)},
  "startsAt": ${JSON.stringify(event.startsAt)},
  "endsAt": ${JSON.stringify(event.endsAt)},
  "availability": ${JSON.stringify(event.availability)},
  "listing": ${JSON.stringify(event.listing || 'board')},
  "guildIds": ${JSON.stringify(event.guildIds)},${thread}
  "entries": [
${lines.join(',\n')}
  ]
}
`;
}

async function writeEventFile(repoPath, content) {
  const dest = path.resolve(__dirname, '..', repoPath);
  if (!dest.startsWith(`${EVENTS_DIR}${path.sep}`)) throw httpError(400, 'Refusing to write outside events.');
  await fs.mkdir(EVENTS_DIR, { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  await fs.rename(tmp, dest);
}

export async function saveGambaEvent({ event, file, creating, message, baseBlobSha, actor }) {
  const cleaned = cleanEvent(event);
  const existing = sourceById(cleaned.id);
  if (existing) {
    const wasWeb = existing.definition.availability === 'web' || existing.definition.listing === 'tournament';
    const nowWeb = cleaned.availability === 'web';
    if (wasWeb !== nowWeb) {
      throw httpError(400, 'A board race stays on the board, and a tournament race stays in its tournament.');
    }
  }
  if (creating && existing) throw httpError(409, `An event with id ${cleaned.id} already exists.`);
  if (!creating && existing && file && existing.file !== file) {
    throw httpError(409, 'Event file does not match this id.');
  }
  const duplicate = listEventSources().find((source) => source.definition.id === cleaned.id && source.file !== (file || existing?.file));
  if (duplicate) throw httpError(409, `Another file already uses id ${cleaned.id}.`);

  const fileName = creating ? `${cleaned.id}.json` : (file || existing?.file);
  if (creating && !/^[\w.-]+\.json$/.test(fileName)) {
    throw httpError(400, 'A new event id can only use letters, numbers, dot, dash, and underscore.');
  }
  const repoPath = repoPathFor(fileName);
  let headSha = null;
  try {
    headSha = (await getFileAtHead(repoPath)).blobSha;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  if (!creating && baseBlobSha && headSha && baseBlobSha !== headSha) {
    throw httpError(409, 'File changed on GitHub. Reload and try again.');
  }
  if (creating && headSha) throw httpError(409, 'That event file already exists on GitHub.');

  const content = formatEvent(cleaned);
  JSON.parse(content);
  const commit = await commitFiles(
    [{ path: repoPath, content, baseBlobSha: headSha }],
    message || `admin: ${creating ? 'add' : 'update'} gamba event ${cleaned.id}`,
  );
  const sync = await fastForwardLocalCheckout([repoPath]);
  if (!sync.synced) {
    console.warn(`Saved ${repoPath} on GitHub, but the local checkout was not fast-forwarded: ${sync.reason}`);
    await writeEventFile(repoPath, content);
  }
  reloadEventDefinitions();
  await recordAdminAudit({
    at: new Date().toISOString(),
    actor: actor?.discordId || null,
    username: actor?.username || null,
    file: repoPath,
    summary: `${creating ? 'add' : 'update'} gamba event ${cleaned.id}`,
    commitSha: commit.commitSha,
  });
  return { id: cleaned.id, file: fileName, commitSha: commit.commitSha, blobSha: commit.blobShas[repoPath] };
}

export async function deleteGambaEvent({ key, message, baseBlobSha, actor }) {
  const source = sourceById(key);
  if (!source) throw httpError(404, 'Event not found.');
  const repoPath = repoPathFor(source.file);
  let headSha = null;
  try {
    headSha = (await getFileAtHead(repoPath)).blobSha;
  } catch (error) {
    if (error.statusCode !== 404) throw error;
  }
  if (baseBlobSha && headSha && baseBlobSha !== headSha) {
    throw httpError(409, 'File changed on GitHub. Reload and try again.');
  }
  const commit = headSha
    ? await commitFiles(
      [{ path: repoPath, deleted: true, baseBlobSha: headSha }],
      message || `admin: delete gamba event ${source.definition.id}`,
    )
    : null;
  const sync = commit ? await fastForwardLocalCheckout([repoPath]) : { synced: false };
  if (!sync.synced) {
    if (commit) console.warn(`Deleted ${repoPath} on GitHub, but the local checkout was not fast-forwarded: ${sync.reason}`);
    await fs.unlink(path.join(EVENTS_DIR, source.file)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  reloadEventDefinitions();
  if (commit) {
    await recordAdminAudit({
      at: new Date().toISOString(),
      actor: actor?.discordId || null,
      username: actor?.username || null,
      file: repoPath,
      summary: `delete gamba event ${source.definition.id}`,
      commitSha: commit.commitSha,
    });
  }
  return { ok: true, commitSha: commit?.commitSha || null };
}
