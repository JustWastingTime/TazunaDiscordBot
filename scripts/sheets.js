import { google } from "googleapis";
import fs from "fs";
import path from 'path';
import { fileURLToPath } from "url";

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to the current file
const serversPath = path.join(__dirname, "..", "assets", "servers.json");
const usersPath   = path.join(__dirname, "..", "assets", "users.json");

let servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
let users   = JSON.parse(fs.readFileSync(usersPath, "utf8"));

const auth = new google.auth.GoogleAuth({
  keyFile: "./assets/credentials.json",
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });


const SHEET_NAME = "Data";

const cleanNumber = str => Number(String(str).replace(/,/g, "")) || 0;

export function getSpreadsheetId(guildId) {
  const server = servers.find(s => s.id === guildId);
  return server?.sheetsid || null; // null if not found
}

export function getSpreadsheetIdForUser(userId) {
  // Find the user in users.json
  const user = users.find(u => u.id === userId);
  if (!user) return null;

  // Get their club
  const clubName = user.club;
  if (!clubName) return null;

  // Find matching server in servers.json
  const server = servers.find(s => s.name === clubName);
  return server?.sheetsid || null;
}

// Update pending data for a user
export async function logPending(discordId, value) {
  try {
    // Find the username + club from your JSON
    const user = users.find(u => u.id === discordId);
    if (!user) return "User ID not found in JSON.";

    const username = user.name;
    const SPREADSHEET_ID = getSpreadsheetIdForUser(discordId);
    if (!SPREADSHEET_ID) return "Could not find a linked spreadsheet for this user.";

    // Read the sheet to find the user row
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!A2:J`,
    });

    const rows = res.data.values;
    if (!rows || rows.length === 0) return "No data found.";

    let rowIndex = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i][1] === username) { // Column B assumed = Name
        rowIndex = i + 2; // +2 because sheet starts at A2
        break;
      }
    }

    if (rowIndex === -1) return "User not found.";

    // Update Pending Data column (J)
    const range = `${SHEET_NAME}!J${rowIndex}`;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[value]],
      },
    });

    return `✅ Updated ${username}'s fancount to ${Number(value).toLocaleString()} in Pending Data.`;

  } catch (err) {
    console.error(err);
    return "Error updating sheet.";
  }
}

// Sync Google Sheet values into users.json
export async function syncUsers() {

  // In case you updated users and servers json manually without restarting the bot
  servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
  users   = JSON.parse(fs.readFileSync(usersPath, "utf8"));

  let updatedUsers = [];

  for (const server of servers) {
    if (!server.sheetsid) {
      console.warn(`⚠️ No spreadsheet ID for server ${server.name}`);
      continue;
    }

    try {
      // 1. Get player data (rows 2 to 31)
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId: server.sheetsid,
        range: `${SHEET_NAME}!A2:J31`,
      });

      const rows = res.data.values || [];
      if (rows.length === 0) {
        console.log(`No data found in sheet for ${server.name}`);
        continue;
      }

      // 2. Get thresholds (M23:P23) using dailies for better zone distribution
      const threshRes = await sheets.spreadsheets.values.get({
        spreadsheetId: server.sheetsid,
        range: `${SHEET_NAME}!M23:P23`,
      });
      const thresholds = (threshRes.data.values?.[0] || []).map(v => cleanNumber(v));

      // 3. Map users from this server
      for (const row of rows) {
        if (!row || row.length < 9) continue;

        const username = row[1];
        if (!username) continue;

        const totalFans = cleanNumber(row[4]);
        const monthlyFans = cleanNumber(row[5]);
        const rankTotal = cleanNumber(row[7]);
        const rankMonthly = cleanNumber(row[8]);
        const growthDailyAvg = cleanNumber(row[6]);

        // Find existing user by name (case-insensitive)
        let existing = users.find(u => u.name?.toLowerCase() === username.toLowerCase());

        // Start with existing data if found, else create fresh
        let user = existing ? { ...existing } : { id: row[0], name: username, club: server.name };

        // Compare fans_total between umamoe and sheets and keep the higher one
        const jsonFans  = cleanNumber(user.fans_total);
        const sheetFans = totalFans;

        const finalFans = Math.max(jsonFans, sheetFans);
        user.fans_total = finalFans.toString();

        // Overwrite only the synced fields
        user.fans_monthly = monthlyFans.toString();
        user.rank_total = rankTotal.toString();
        user.rank_monthly = rankMonthly.toString();
        user.daily_average = growthDailyAvg.toString();
        user.club = server.name;

        // Assign color
        let color = "red";
        if (thresholds.length > 0) {
          if (growthDailyAvg >= thresholds[0]) color = "purple";
          else if (growthDailyAvg >= thresholds[1]) color = "blue";
          else if (growthDailyAvg >= thresholds[2]) color = "green";
          else if (growthDailyAvg >= thresholds[3]) color = "yellow";
        }
        user.color = color;

        updatedUsers.push(user);

        // 🔁 if JSON is higher, update the sheet
        if (jsonFans > sheetFans) {
          try {
            const rowIndex = rows.indexOf(row) + 2;
            await sheets.spreadsheets.values.update({
              spreadsheetId: server.sheetsid,
              range: `${SHEET_NAME}!J${rowIndex}`, // Column J = pending fans
              valueInputOption: "USER_ENTERED",
              requestBody: {
                values: [[jsonFans]],
              },
            });
          } catch (err) {
            console.warn(`⚠️ Failed to push fans for ${username}`, err.message);
          }
        }
      }

      // 4. Update server-wide stats (optional)
      const statsRes = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: server.sheetsid,
        ranges: [`${SHEET_NAME}!M4:N4`, `${SHEET_NAME}!M8`],
      });

      const stats1 = statsRes.data.valueRanges[0]?.values?.[0] || [];
      const stats2 = statsRes.data.valueRanges[1]?.values?.[0] || [];

      server.fans_median = cleanNumber(stats1[0]).toString();
      server.fans_guild_total = cleanNumber(stats1[1]).toString();
      server.daily_average = cleanNumber(stats2[0]).toString();

    } catch (err) {
      console.error(`❌ Error syncing server ${server.name}:`, err.message);
    }
  }

  // Replace only synced users, but keep unsynced ones (so nothing is lost)
  const finalUsers = users.map(u => {
    const updated = updatedUsers.find(nu => nu.name.toLowerCase() === u.name.toLowerCase());
    return updated ? updated : u;
  });

  // Add any brand-new synced users not already in file
  for (const newUser of updatedUsers) {
    if (!finalUsers.find(u => u.name.toLowerCase() === newUser.name.toLowerCase())) {
      finalUsers.push(newUser);
    }
  }

  // Save everything back
  users = finalUsers;
  
  fs.writeFileSync(usersPath, JSON.stringify(users, null, 4));
  fs.writeFileSync(serversPath, JSON.stringify(servers, null, 4));

  console.log(`[LeaderboardUpdater] Synced ${users.length} users from ${servers.length} servers.`);
  return users;
}
