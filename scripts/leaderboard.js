import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

import {
  MessageComponentTypes,
  InteractionResponseFlags
} from 'discord-interactions';

import { syncUsers } from "./sheets.js";

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serversPath = path.join(__dirname, "..", "assets", "servers.json");
const usersPath = path.join(__dirname, "..", "assets", "users.json");

// ---------------------------------------------------------------------------
// Discord API helper
// ---------------------------------------------------------------------------

async function sendDiscordMessage(channelId, payload) {
  return fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: {
      "Authorization": `Bot ${process.env.DISCORD_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  }).then(r => r.json());
}

async function editDiscordMessage(channelId, messageId, payload) {
  return fetch(
    `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        "Authorization": `Bot ${process.env.DISCORD_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    }
  ).then(r => r.json());
}

// ---------------------------------------------------------------------------
// Helper functions (copied exactly from your command)
// ---------------------------------------------------------------------------

const getColorEmoji = (col) => {
  switch ((col || "").toLowerCase()) {
    case "purple": return "🟣";
    case "blue":   return "🔵";
    case "green":  return "🟢";
    case "yellow": return "🟡";
    case "red":    return "🔴";
    default:       return "⚪";
  }
};

function truncate(text, max) {
  if (!text) return "";
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function padRight(s, w) {
  return String(s).padEnd(w, " ");
}

function padLeft(s, w) {
  return String(s).padStart(w, " ");
}

// ---------------------------------------------------------------------------
// Build leaderboard output (same as your slash command)
// ---------------------------------------------------------------------------

function buildLeaderboardPayload(clubNames, usersList, serversList) {
  const targetClubs = clubNames;

  // Filter users inside these clubs
  const clubUsers = usersList.filter(u => targetClubs.includes(u.club));

  if (clubUsers.length === 0) {
    return {
      content: `❌ No users found for club(s): ${targetClubs.join(", ")}.`
    };
  }

  // Sort (monthly)
  const sorted = [...clubUsers].sort(
    (a, b) =>
      (Number(a.rank_monthly) || 1e9) - (Number(b.rank_monthly) || 1e9)
  );

  // aggregated stats
  const parseNum = v => Number(v) || 0;

  const matchedServers = serversList.filter(s => targetClubs.includes(s.name));

  const medians = matchedServers.map(s => parseNum(s.fans_median)).filter(n => n > 0);
  const totalFansSum = matchedServers.reduce(
    (acc, s) => acc + parseNum(s.fans_guild_total), 0
  );
  const dailyVals = matchedServers.map(s => parseNum(s.daily_average)).filter(n => n > 0);

  // aggregated median
  let aggregatedMedian = 0;
  if (medians.length > 0) {
    medians.sort((a, b) => a - b);
    const mid = Math.floor(medians.length / 2);
    aggregatedMedian =
      medians.length % 2 === 1
        ? medians[mid]
        : Math.round((medians[mid - 1] + medians[mid]) / 2);
  }

  const aggregatedDaily =
    dailyVals.length > 0
      ? Math.round(dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length)
      : 0;

  // build table rows
  const rows = sorted.map((u, idx) => {
    const rankField = u.rank_monthly || String(idx + 1);
    const fansField = Number(u.fans_monthly) || 0;
    const dailyField = Number(u.daily_average) || 0;

    return {
      rank: `#${rankField}`,
      name: u.name || "Unknown",
      fans: fansField.toLocaleString(),
      daily: dailyField.toLocaleString(),
      colorEmoji: getColorEmoji(u.color)
    };
  });

  // Column widths
  const rankWidth  = Math.max(4, ...rows.map(r => r.rank.length));
  const nameWidth  = Math.min(50, Math.max(10, ...rows.map(r => r.name.length)));
  const fansWidth  = Math.max(10, ...rows.map(r => r.fans.length), "Total Fans".length);
  const dailyWidth = Math.max(9, ...rows.map(r => r.daily.length), "Daily Avg".length);

  // Header
  const header = [
    padRight("Rank", rankWidth),
    padRight("Name", nameWidth),
    padLeft("Total Fans", fansWidth),
    padLeft("Daily Avg", dailyWidth),
    "Zone"
  ].join("  ");

  const sep = "-".repeat(Math.min(120, header.length));

  // Body
  const bodyLines = rows.map(r =>
    `${padRight(r.rank, rankWidth)}  ` +
    `${padRight(truncate(r.name.replace(/！/g, '!'), nameWidth), nameWidth)}  ` +
    `${padLeft(r.fans, fansWidth)}  ` +
    `${padLeft(r.daily, dailyWidth)}  ` +
    `${r.colorEmoji}`
  );

  const table = [header, sep, ...bodyLines].join("\n");

  // Title & footer
    const title = `## 🏆 Leaderboard — ${targetClubs.join(", ")} (Monthly Fans)`;

    const footerText =
        `-# Median Fans: ${aggregatedMedian.toLocaleString()}  •  ` +
        `Total Fans: ${totalFansSum.toLocaleString()}  •  ` +
        `Daily Avg: ${aggregatedDaily.toLocaleString()}`;

    const now = Math.floor(Date.now() / 1000);
    const lastUpdatedLine = `Last updated: <t:${now}:R>`;

    // Final Discord components
    return {
    embeds: [
      {
        title: `🏆 Leaderboard — ${targetClubs.join(", ")} (Monthly Fans)`,
        description: "```" + table + "```",
        color: 15844367,
        footer: {
          text:
            `Median Fans: ${aggregatedMedian.toLocaleString()} • ` +
            `Total Fans: ${totalFansSum.toLocaleString()} • ` +
            `Daily Avg: ${aggregatedDaily.toLocaleString()}`
        },
        timestamp: new Date().toISOString()
      }
    ]
  };
}

// ---------------------------------------------------------------------------
// Main Updater Loop
// ---------------------------------------------------------------------------

export async function updateLeaderboard() {
  try {
    console.log("[LeaderboardUpdater] Syncing users...");
    await syncUsers();

    const servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
    const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));

    let changed = false;

    for (const server of servers) {
      if (!server.leaderboard_channel) continue;

      console.log(`[LeaderboardUpdater] Updating ${server.name}`);

      const payload = buildLeaderboardPayload(
        [server.name], // ONE club per server
        users,
        servers
      );

      // Create message if missing
      if (!server.leaderboard_message_id) {
        const msg = await sendDiscordMessage(
          server.leaderboard_channel,
          payload
        );

        if (msg?.id) {
          server.leaderboard_message_id = msg.id;
          changed = true;
        }

        continue;
      }

      // Otherwise edit existing
      await editDiscordMessage(
        server.leaderboard_channel,
        server.leaderboard_message_id,
        payload
      );
    }

    // Persist updated message IDs
    if (changed) {
      fs.writeFileSync(serversPath, JSON.stringify(servers, null, 2));
    }

  } catch (err) {
    console.error("[LeaderboardUpdater] ERROR:", err);
  }
}

// ---------------------------------------------------------------------------
// Run interval (once per hour)
// ---------------------------------------------------------------------------

updateLeaderboard();
setInterval(updateLeaderboard, 1000 * 60 * 60);