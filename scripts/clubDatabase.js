import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'tazuna.db');

let db;

function ensureDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS guild_clubs (
      guild_id TEXT NOT NULL,
      circle_id TEXT NOT NULL,
      circle_name TEXT,
      registered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, circle_id)
    );

    CREATE TABLE IF NOT EXISTS user_links (
      discord_user_id TEXT PRIMARY KEY,
      viewer_id TEXT NOT NULL,
      trainer_name TEXT NOT NULL,
      circle_id TEXT NOT NULL,
      circle_name TEXT,
      linked_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function registerGuildClub(guildId, circleId, circleName) {
  const database = ensureDb();
  database
    .prepare(
      `INSERT INTO guild_clubs (guild_id, circle_id, circle_name)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id, circle_id) DO UPDATE SET circle_name = excluded.circle_name`,
    )
    .run(String(guildId), String(circleId), circleName ?? null);
}

export function unregisterGuildClub(guildId, circleId) {
  const database = ensureDb();
  const result = database
    .prepare('DELETE FROM guild_clubs WHERE guild_id = ? AND circle_id = ?')
    .run(String(guildId), String(circleId));
  return result.changes > 0;
}

export function getGuildClubs(guildId) {
  const database = ensureDb();
  return database
    .prepare(
      'SELECT circle_id AS circleId, circle_name AS circleName FROM guild_clubs WHERE guild_id = ? ORDER BY circle_name COLLATE NOCASE',
    )
    .all(String(guildId));
}

export function isGuildClubRegistered(guildId, circleId) {
  const database = ensureDb();
  const row = database
    .prepare('SELECT 1 FROM guild_clubs WHERE guild_id = ? AND circle_id = ?')
    .get(String(guildId), String(circleId));
  return Boolean(row);
}

export function upsertUserLink({ discordUserId, viewerId, trainerName, circleId, circleName }) {
  const database = ensureDb();
  database
    .prepare(
      `INSERT INTO user_links (discord_user_id, viewer_id, trainer_name, circle_id, circle_name, linked_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(discord_user_id) DO UPDATE SET
         viewer_id = excluded.viewer_id,
         trainer_name = excluded.trainer_name,
         circle_id = excluded.circle_id,
         circle_name = excluded.circle_name,
         linked_at = datetime('now')`,
    )
    .run(
      String(discordUserId),
      String(viewerId),
      trainerName,
      String(circleId),
      circleName ?? null,
    );
}

export function getUserLink(discordUserId) {
  const database = ensureDb();
  return (
    database
      .prepare(
        `SELECT discord_user_id AS discordUserId, viewer_id AS viewerId, trainer_name AS trainerName,
                circle_id AS circleId, circle_name AS circleName, linked_at AS linkedAt
         FROM user_links WHERE discord_user_id = ?`,
      )
      .get(String(discordUserId)) ?? null
  );
}
