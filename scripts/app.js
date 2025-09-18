import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { buildSupporterEmbed, buildSkillEmbed, buildSkillComponents, getColor, getCustomEmoji, parseEmojiForDropdown, buildEventEmbed, buildUmaEmbed, buildUmaComponents, buildRaceEmbed, buildCMEmbed, capitalize } from './utils.js';
import { getSpreadsheetId, getSpreadsheetIdForUser, logPending, syncUsers } from "./sheets.js"; 
import cache from './githubCache.js';
import { parseWithOcrSpace, parseUmaProfile, buildUmaParsedEmbed, generateUmaLatorLink, shortenUrl } from './parser.js';

import path from 'path';
import { fileURLToPath } from "url";

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to the current file
const serversPath = path.join(__dirname, "..", "assets", "servers.json");
const usersPath   = path.join(__dirname, "..", "assets", "users.json");

const servers = JSON.parse(fs.readFileSync(serversPath, "utf8"));
const users   = JSON.parse(fs.readFileSync(usersPath, "utf8"));

const characters = cache.characters;
const supporters = cache.supporters;
const events = cache.events;
const skills = cache.skills;
const races = cache.races;
const champsmeets = cache.champsmeets;

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

function getUsers() {
  return JSON.parse(fs.readFileSync(usersPath, "utf8"));
}

function getServers() {
  return JSON.parse(fs.readFileSync(serversPath, "utf8"));
}

/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(process.env.PUBLIC_KEY), async function (req, res) {
  // Interaction id, type and data
  const { id, type, data, message, token } = req.body;

  /**
   * Handle verification requests
   */
  if (type === InteractionType.PING) {
    return res.send({ type: InteractionResponseType.PONG });
  }

  /**
   * Handle slash command requests
   * See https://discord.com/developers/docs/interactions/application-commands#slash-commands
   */
  if (type === InteractionType.APPLICATION_COMMAND) {
    const { name, options } = data;

    // "supporter" command
    if (name === 'supporter') {
      const supporterQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const levelOpt = data.options?.find(opt => opt.name === 'limitbreak')?.value; // may be undefined
      const query = supporterQuery.toLowerCase().split(/\s+/); 

      const level = levelOpt !== undefined ? Number(levelOpt) : undefined;
      const matches = supporters.filter(s => {
        return query.every(q =>
          s.card_name.toLowerCase().includes(q) ||
          s.character_name.toLowerCase().includes(q) ||
          s.rarity.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Supporter: ${supporterQuery} not found` }
        });
      }
      // If only 1 result
      else if (matches.length === 1)
      {
        return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { 
          embeds: [buildSupporterEmbed(matches[0], skills, level)]
          }
        });
      }

      // If multiple matches → return a dropdown menu
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "supporter_select",
                  placeholder: "Choose a supporter",
                  options: matches.slice(0, 25).map(s => ({
                    label:  s.card_name + ' (' + s.rarity.toUpperCase() +')' , // must be <=100 chars
                    value: `${s.id}|${level}`, // send the supporter id back on select
                    description: s.character_name,
                    emoji: getCustomEmoji(s.category)
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "skill" command
    if (name === 'skill') {
      const skillQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const query = skillQuery.toLowerCase().split(/\s+/); 

      // Find the skills that match
      const matches = skills.filter(s => {
        return query.every(q =>
          s.skill_name.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Skill ${skillQuery} not found` }
        });
      }

      // If only 1 result
      if (matches.length === 1)
      {

        // Lookup supporters with this skill
        const supporterMatches = supporters.filter(s =>
          s.support_skills?.some(sk => sk.toLowerCase() === matches[0].skill_name.toLowerCase()) ||
          s.event_skills?.some(sk => sk.toLowerCase() === matches[0].skill_name.toLowerCase())
        );

        // Format supporter names into a list
        let supporterList = supporterMatches.length
          ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
          : 'None';

        // Creating components if the skill has cards or upgraded version
        let components = [];

        return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { 
          embeds: [buildSkillEmbed(matches[0], supporterList)],
          components: buildSkillComponents(matches[0], supporterMatches.length, supporterMatches)
        }
        });
      }
      

      // If multiple matches → return a dropdown menu
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "skill_select",
                  placeholder: "Choose a Skill",
                  options: matches.slice(0, 25).map(s => ({
                    label:  s.skill_name , // must be <=100 chars
                    value: s.skill_name, // send the skill title back on select
                    description: s.description.length > 80 
                      ? s.description.slice(0, 77) + "..." 
                      : s.description,
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "event" command
    if (name === 'event') {
      const eventQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const query = eventQuery.toLowerCase().split(/\s+/); 

      // Find the skills that match
      const matches = events.filter(s => {
        return query.every(q =>
          s.event_name.toLowerCase().includes(q) ||
          s.source_name?.toLowerCase().includes(q) ||
          s.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Event ${eventQuery} not found` }
        });
      }

      // If only 1 result
      if (matches.length === 1)
      {
        return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { 
          embeds: [buildEventEmbed(matches[0], events)],
        }
        });
      }

      // If multiple matches → return a dropdown menu
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "event_select",
                  placeholder: "Choose an Event",
                  options: matches.map(s => ({
                    label:  s.event_name.length > 100 
                      ? s.event_name.slice(0, 97) + "..." 
                      : s.event_name,// must be <=100 chars
                    value: s.id, // send the source back
                     description: s.source_name + " - " + s.subtype
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    if (name === 'uma') {
      const umaQuery = data.options?.find(opt => opt.name === 'name')?.value?.toLowerCase();
      const query = umaQuery.toLowerCase().split(/\s+/); 

      // Find matches
      const matches = characters.filter(c => {
        return query.every(q =>
          c.character_name.toLowerCase().includes(q) ||
          c.aliases?.some(a => a.toLowerCase().includes(q))
        );
      });

      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Uma "${umaQuery}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { 
            embeds: [buildUmaEmbed(matches[0], skills)],
            components: buildUmaComponents(matches[0], true, characters)
          }
        });
      }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "uma_select",
                  placeholder: "Choose a Character",
                  options: matches.slice(0, 25).map(c => ({
                    label: c.character_name.length > 100 
                      ? c.character_name.slice(0, 97) + "..." 
                      : c.character_name,
                    value: c.id,
                    description: c.type + " " + c.rarity
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    if (name === "race") {
    const raceQuery = data.options?.find(opt => opt.name === "name")?.value?.toLowerCase();
    const gradeFilter = data.options?.find(opt => opt.name === "grade")?.value;
    const yearFilter = data.options?.find(opt => opt.name === "year")?.value;
    const query = raceQuery ? raceQuery.split(/\s+/) : [];

    // Find matches
    const matches = races.filter(r => {
      let ok = true;

      // Text query
      if (query.length > 0) {
        ok = ok && query.every(q =>
          r.race_name.toLowerCase().includes(q) ||
          r.aliases?.some(a => a.toLowerCase().includes(q))
        );
      }

      // Grade filter
      if (gradeFilter) {
        ok = ok && r.grade === gradeFilter;
      }

      // Year filter
      if (yearFilter) {
        ok = ok && r.date?.toLowerCase().includes(yearFilter.toLowerCase());
      }

      return ok;
    });

    // No matches
    if (matches.length === 0) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `❌ Race not found.` }
      });
    }

    // One match → embed
    if (matches.length === 1) {
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { embeds: [buildRaceEmbed(matches[0], characters)] }
      });
    }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "race_select",
                  placeholder: "Choose a Race",
                  options: matches.slice(0, 25).map(r => ({
                    label: r.race_name.length > 100
                      ? r.race_name.slice(0, 97) + "..."
                      : r.race_name,
                    value: r.id,
                    description: `${r.grade} • ${r.distance_meters} • ${r.racetrack} • ${r.date}`
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "cm" command
    if (name === 'cm') {
      const cupQuery = data.options?.find(opt => opt.name === "name")?.value?.toLowerCase();

      // Find matches
      const matches = champsmeets.filter(c => {
        if (!cupQuery) return true;

        return (
          c.name.toLowerCase().includes(cupQuery) ||
          c.number.toLowerCase().includes(cupQuery)
        );
      });


      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Champion's Meeting "${cupQuery}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildCMEmbed(matches[0])
          
        });
      }

      // Multiple matches → dropdown
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: `🔎 Found ${matches.length} matches. Pick one:`,
          components: [
            {
              type: 1, // Action row
              components: [
                {
                  type: 3, // String Select
                  custom_id: "cm_select",
                  placeholder: "Choose a CM",
                  options: matches.slice(0, 25).map(c => ({
                    label: c.name.length > 100 
                      ? c.name.slice(0, 97) + "..." 
                      : c.name,
                    value: c.name
                  }))
                }
              ]
            }
          ]
        }
      });
    }

    // "log" command
    if (name === 'log') {
      // Interaction context
      const context = req.body.context;
      const value = options[0].value;

      // User ID is in user field for (G)DMs, and member for servers
      const userId = context === 0 ? req.body.member.user.id : req.body.user.id;

      // Call the Google Sheets updater
      const result = await logPending(userId, value);

      return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [
              {
                type: MessageComponentTypes.TEXT_DISPLAY,
                content: result
              }
            ]
          },
        });
    }

    // "leaderboard" command
    if (name === 'leaderboard') {
      // Defer so we have time to sync
      res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE });

      try {
        const mode = options?.find(opt => opt.name === "mode")?.value || "monthly";
        const clubArg = options?.find(opt => opt.name === "clubname")?.value; // optional user override
        const guildId = req.body.guild_id;
        const userId = req.body.user?.id || req.body.member?.user?.id;

        // Always sync first to make sure data is fresh
        await syncUsers();

        // Reload fresh JSON after syncing
        const usersList = getUsers();
        const serversList = getServers();

        // Find which servers/clubs we should include
        let matchedServers = [];

        if (clubArg) {
          // Exact name match first (case-insensitive)
          matchedServers = serversList.filter(s => s.name.toLowerCase() === clubArg.toLowerCase());

          // If none, try contains (partial)
          if (matchedServers.length === 0) {
            matchedServers = serversList.filter(s => s.name.toLowerCase().includes(clubArg.toLowerCase()));
          }

          if (matchedServers.length === 0) {
            await sendFollowup(token, {
              content: `❌ Club "${clubArg}" not found.`
            });
            return;
          }
        } else {
          // No clubname passed — try to resolve from guild or user's club (DM)
          if (guildId) {
            matchedServers = serversList.filter(s => s.id === guildId);
          }

          if (!guildId) {
            // In DM — resolve from user's club field
            if (userId) {
              const user = usersList.find(u => u.id === userId);
              if (user?.club) {
                matchedServers = serversList.filter(s => s.name === user.club);
              }
            }
          }

          if (matchedServers.length === 0) {
            await sendFollowup(token, {
              content: "❌ Could not determine which club/server to pull leaderboard from. Try `/leaderboard clubname:\"YourClub\"`."
            });
            return;
          }
        }

        const targetClubs = matchedServers.map(s => s.name);

        // Filter users for these clubs
        const clubUsers = usersList.filter(u => targetClubs.includes(u.club));

        if (clubUsers.length === 0) {
          await sendFollowup(token, {
            content: `❌ No users found for club(s): ${targetClubs.join(", ")}.`
          });
          return;
        }

        // Sort depending on mode (use rank if available; fallback to fans descending)
        let sorted;
        if (mode === "total") {
          sorted = [...clubUsers].sort((a, b) => (Number(a.rank_total) || 1e9) - (Number(b.rank_total) || 1e9));
        } else {
          sorted = [...clubUsers].sort((a, b) => (Number(a.rank_monthly) || 1e9) - (Number(b.rank_monthly) || 1e9));
        }

        const top10 = sorted.slice(0, 10);

        // Build leaderboard description (same format as before)
        const description = top10.map(u => {
          const rank = mode === "total" ? u.rank_total : u.rank_monthly;
          const fans = mode === "total" ? u.fans_total : u.fans_monthly;
          return `**#${rank}** ${u.name} — ⭐ ${Number(fans).toLocaleString()}`;
        }).join("\n");

        // Aggregate server stats for footer
        const parseNum = v => Number(v) || 0;

        const medians = matchedServers.map(s => parseNum(s.fans_median)).filter(n => n > 0);
        const totalFansSum = matchedServers.reduce((acc, s) => acc + parseNum(s.fans_guild_total), 0);
        const dailyVals = matchedServers.map(s => parseNum(s.daily_average)).filter(n => n > 0);

        // Median-of-medians (if multiple) — fallback to 0 if empty
        let aggregatedMedian = 0;
        if (medians.length > 0) {
          medians.sort((a, b) => a - b);
          const mid = Math.floor(medians.length / 2);
          aggregatedMedian = (medians.length % 2 === 1)
            ? medians[mid]
            : Math.round((medians[mid - 1] + medians[mid]) / 2);
        }

        // Avg daily (rounded)
        const aggregatedDaily = dailyVals.length > 0
          ? Math.round(dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length)
          : 0;

        // Build footer text exactly as you requested
        const footerText = `Median Fans: ${Number(aggregatedMedian).toLocaleString()}  •  Total Fans: ${Number(totalFansSum).toLocaleString()}  •  Daily Avg: ${Number(aggregatedDaily).toLocaleString()}`;

        // Embed title: single club gets possessive title, multiple clubs aggregated
        const title = matchedServers.length === 1
          ? `🏆 ${matchedServers[0].name}'s Leaderboard (${mode === "total" ? "Total Fans" : "Monthly Fans"})`
          : `🏆 Leaderboard — ${targetClubs.join(", ")} (${mode === "total" ? "Total Fans" : "Monthly Fans"})`;

        const embed = {
          title,
          description: description || "No data available.",
          color: 0xf1c40f,
          footer: { text: footerText }
        };

        await sendFollowup(token, { embeds: [embed] });

      } catch (err) {
        console.error("Leaderboard command error:", err);
        await sendFollowup(token, { content: "❌ Error fetching leaderboard." });
      }

      return;
    }

    // "trainer" command to lookup yourself or other trainers
    if (name === 'trainer') {
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      try {
        const trainerQuery = data.options?.find(opt => opt.name === "name")?.value;
        const userId = req.body.context === 0 ? req.body.member.user.id : req.body.user.id;

        // Always sync before reading
        await syncUsers();

        // Load updated users.json
        const users = JSON.parse(fs.readFileSync(usersPath, "utf8"));

        let user;
        if (trainerQuery) {
          user = users.find(u => u.name.toLowerCase() === trainerQuery.toLowerCase());
        } else {
          user = users.find(u => u.id === userId);
        }

        if (!user) {
          await sendFollowup(token, { content: "❌ Trainer not found." });
          return;
        }

        const embed = {
          title: `Trainer Profile: ${user.name}`,
          color: getColor(user.color),
          description: `You have mined **${Number(user.fans_monthly).toLocaleString()}** fans this month.\n\u200B`,
          fields: [
            { name: "👥 Total Fans", value: Number(user.fans_total).toLocaleString(), inline: true },
            { name: "📈 Daily Gains (Avg)", value: Number(user.daily_average).toLocaleString(), inline: true },
            { name: "🚦 Zone", value: capitalize(user.color), inline: true },
            { name: "⭐ Current Rank", value: '# ' + Number(user.rank_total).toLocaleString(), inline: true },
            { name: "〽️ Monthly Rank", value: '# ' + Number(user.rank_monthly).toLocaleString(), inline: true },
          ],
          footer: user.club ? { text: `Club: ${user.club}` } : undefined
        };

        const buttons = (user.save_data || [])
          .filter(s => {
            try { return ['http:', 'https:', 'discord:'].includes(new URL(s.url).protocol); }
            catch { return false; }
          })
          .map((s, i) => ({ type: 2, style: 5, label: s.label || `Slot ${i + 1}`, url: s.url }));

        await sendFollowup(token, {
          embeds: [embed],
          components: buttons.length ? [{ type: 1, components: buttons }] : []
        });

      } catch (err) {
        console.error("Trainer command error:", err);
        await sendFollowup(token, { content: "❌ Error fetching trainer data." });
      }

      return;
    }

    // "banana" command to lookup all users under the banana line (you can replace with a user you want)
    if (name === "banana") {
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      try {
        // Sync fresh data
        const userList = await syncUsers();

        // Get current guildId
        const guildId = req.body.guild_id;
        const clubName = data.options?.find(opt => opt.name === "clubname")?.value;

        // Resolve target clubs
        let targetServers = servers.filter(s => s.id === guildId);
        if (clubName) {
          targetServers = targetServers.filter(s => s.name.toLowerCase() === clubName.toLowerCase());
        }
        const targetClubs = targetServers.map(s => s.name);

        // Filter only users in these clubs
        const filteredUsers = userList.filter(u => targetClubs.includes(u.club));

        // Find Banana inside these users
        const bananaUser = filteredUsers.find(u => u.name.toLowerCase() === "banana");
        if (!bananaUser) {
          return sendFollowup(token, { content: "❌ Could not find Banana in this server’s data." });
        }

        const BANANA_THRESHOLD = Number(bananaUser.daily_average);

        // Users below Banana’s daily avg
        const bananaUsers = filteredUsers.filter(
          u => Number(u.daily_average) < BANANA_THRESHOLD
        );

        if (bananaUsers.length === 0) {
          return sendFollowup(token, { content: "🍌 Nobody is below Banana’s threshold right now. Keep it up!" });
        }

        // Align columns nicely
        const maxLen = Math.max(
          ...bananaUsers.map(u => Number(u.daily_average).toLocaleString().length)
        );

        const desc = "```\n" + bananaUsers
          .map(
            (u, i) =>
              `${String(i + 1).padStart(2, " ")}. ${u.name.padEnd(15, " ")} ${Number(u.daily_average).toLocaleString().padStart(maxLen, " ")}`
          )
          .join("\n") + "\n```";

        const embed = {
          title: "🍌 Banana Line (Daily Average)",
          description: desc,
          color: 0xFFDD00,
          footer: {
            text: `Banana’s threshold: ${BANANA_THRESHOLD.toLocaleString()} fans/day`
          }
        };

        await sendFollowup(token, { embeds: [embed] });

      } catch (err) {
        console.error("Banana command error:", err);
        await sendFollowup(token, { content: "❌ Error fetching Banana data." });
      }

      return;
    }

    // "parse" command
    if (name === "parse") {
      const attachmentId = data.options?.find(opt => opt.name === "image")?.value;
      const attachment = data.resolved?.attachments?.[attachmentId];

      if (!attachment) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Please upload an image to scan." }
        });
      }

      // Step 1: Defer right away
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: "Tazuna is scrutinizing your uma." }
      });

      (async () => {
        try {
          // Step 2: Run OCR
          const ocrResult = await parseWithOcrSpace(attachment.url);

          const requiredWords = ["Turf", "Dirt", "Sprint", "Mile", "Medium", "Long", "Front", "Pace", "Late", "End"];
          const missingWords = requiredWords.filter(word => !ocrResult.text.includes(word));
          if (missingWords.length > 0) {
            return await sendFollowup(token, {
              content: `❌ OCR failed: the image is missing these required fields: ${missingWords.join(', ')}`
            });
          }

          // Step 3: Parse Uma profile
          const parsed = await parseUmaProfile(
            ocrResult.text, 
            ocrResult.overlayLines, 
            attachment.url,
            ocrResult.rawData,
            ocrResult.info
          );

          // Step 4: Generate Umalator link
          let umalatorUrl = null;
          try {
            umalatorUrl = generateUmaLatorLink(parsed);

            // Shorten the URL for Discord button
            //if (umalatorUrl) {
              //umalatorUrl = await shortenUrl(umalatorUrl);
            //}
          } catch (umalatorError) {
            console.warn("Failed to generate or shorten UmaLator URL:", umalatorError.message);
          }

          // Step 5: Build embed with Umalator link
          const embed = buildUmaParsedEmbed(parsed, false);

          // Step 6: Add Umalator link button
          let components = [];
          if (umalatorUrl) {
            components = [
              {
                type: 1, // Action row
                components: [
                  {
                    type: 2,      // Button
                    style: 5,     // Link button
                    label: "Open in Umalator",
                    url: umalatorUrl
                  }
                ]
              }
            ];
          }
          
          await sendFollowup(token, {
            content: `✅ Parsed Uma data for **${parsed.name || "Unknown"}**`,
            embeds: [embed], components
          });

        } catch (err) {
          console.error("OCR Error:", err);
          await sendFollowup(token, { 
            content: "❌ Error processing image with OCR.space. " + err.message 
          });
        }
      })();

      return; // <- important to prevent falling through to unknown command handler
    }

    if (name === "register") {
      const slot = data.options.find(o => o.name === "slot").value;
      const name = data.options.find(o => o.name === "name").value;
      const url = data.options.find(o => o.name === "url").value;

      if (slot < 1 || slot > 5) {
        return res.send({
          type: 4,
          data: { content: "❌ Slot must be between 1 and 5." }
        });
      }

      const userId = req.body.context === 0 ? req.body.member.user.id : req.body.user.id;
      let user = users.find(u => u.id === userId);
      

      if (!user) {
        return res.send({
          type: 4,
          data: { content: "❌ User not found." }
        });
      }

      // Ensure save_data array exists
      if (!user.save_data) {
        user.save_data = Array(5).fill({ label: "", url: "" });
      }

      // Update slot (1–5 → index 0–4)
      user.save_data[slot - 1] = { label: name, url };

      // Save JSON
      fs.writeFileSync("./assets/users.json", JSON.stringify(users, null, 2));

      return res.send({
        type: 4,
        data: { content: `✅ Saved **${name}** in slot ${slot}.` }
      });
    }

    // "setchannel" command to set an admin channel for application purposes
    if (name === "setchannel") {
      const member = req.body.member;

      // Convert permissions to BigInt (safe for large bitfields)
      const perms = BigInt(member.permissions || "0");
      const ADMIN = 0x00000008n; // Administrator bit

      const isAdmin = (perms & ADMIN) === ADMIN;
      if (!isAdmin) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { 
            content: "❌ You must be an admin to use this command.", 
            flags: 64 // ephemeral
          }
        });
      }

      const channelId = options.find(o => o.name === "channel").value;

      // Save channelId to config.json
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
      } catch {
        config = {};
      }
      config.applicationChannel = channelId;
      fs.writeFileSync("./config.json", JSON.stringify(config, null, 2));

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { content: `✅ Saved channel <#${channelId}>` }
      });
    }

    // "apply" command
    if (name === "apply") {
      const trainerName = options.find(o => o.name === "name")?.value;
      const trainerId = options.find(o => o.name === "id")?.value;
      const fanCount = options.find(o => o.name === "fancount")?.value;

      // Get Discord ID
      const discordId = req.body.context === 0 
        ? req.body.member.user.id 
        : req.body.user.id;

      // Validation
      if (!trainerName || !trainerId || !fanCount) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "❌ You must provide a name, ID, and fan count to apply.",
            flags: 64 // ephemeral
          },
        });
      }

      // Load saved channelId
      let config = {};
      try {
        config = JSON.parse(fs.readFileSync("./config.json", "utf8"));
      } catch {
        config = {};
      }
      const appChannelId = config.applicationChannel;
      if (!appChannelId) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "❌ Application channel not set. Please ask an admin to run `/setchannel` first.",
            flags: 64
          },
        });
      }

      // Build embed
      const embed = {
        title: "📨 New Application",
        description: "A new trainer has applied!",
        color: 0x3498db,
        fields: [
          { name: "Trainer Name", value: trainerName, inline: true },
          { name: "Trainer ID", value: trainerId, inline: true },
          { name: "Fans", value: Number(fanCount).toLocaleString(), inline: true },
          { name: "Discord ID", value: discordId, inline: false },
        ],
        footer: { text: "Application submitted via /apply" }
      };

      // Approve button
      const components = [
        {
          type: 1, // action row
          components: [
            {
              type: 2, // button
              style: 3, // green
              label: "✅ Approve Application",
              custom_id: `approve_${discordId}_${trainerId}`,
            },
          ],
        },
      ];

      // Send application into saved channel
      await fetch(`https://discord.com/api/v10/channels/${appChannelId}/messages`, {
        method: "POST",
        headers: {
          "Authorization": `Bot ${process.env.DISCORD_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          embeds: [embed],
          components,
        }),
      });

      // Confirm to the applicant
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "✅ Your application has been submitted!",
          flags: 64 // ephemeral
        },
      });
    }

    console.error(`unknown command: ${name}`);
    return res.status(400).json({ error: 'unknown command' });
  }

  if (type === InteractionType.MESSAGE_COMPONENT) {
    const { custom_id, values } = data;

    if (custom_id === "supporter_select") {
      const [selectedId, levelStr] = values[0].split("|");
      const supporter = supporters.find(s => s.id === selectedId);
      const level = levelStr ? Number(levelStr) : undefined;

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${supporter.card_name}**`,
          embeds: [buildSupporterEmbed(supporter, skills, level)],
          components: [] // remove the dropdown after selection
        }
      });
    }

    // Handling selecting a skill from a dropdown
    if (custom_id === "skill_select") {
      const selectedTitle = values[0].toLowerCase();
      const skill = skills.find(s =>
        s.skill_name.toLowerCase() === selectedTitle
      );

      // Lookup supporters with this skill
      const supporterMatches = supporters.filter(s =>
        s.support_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase()) ||
        s.event_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase())
      );

      // Format supporter names into a list
      let supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [buildSkillEmbed(skill, supporterList)],
          components: buildSkillComponents(skill, supporterMatches.length, supporterMatches)
        }
      });
    }

    // Handling selecting a supporter card from skills
    if (custom_id === "supporter_lookup_select") {
      const cardID = values[0];
      const supporter = supporters.find(s => s.id === cardID);
      
      return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { 
            embeds: [buildSupporterEmbed(supporter, skills)]
            }
          });
    }

    // Handling looking up the upgraded skill
    if (custom_id.startsWith("upgrade_")) {
      const upgradedName = custom_id.replace("upgrade_", "").toLowerCase();
      const upgradedSkill = skills.find(s =>
        s.skill_name.toLowerCase() === upgradedName
      );

      if (!upgradedSkill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "⚠️ Upgraded skill not found!" }
        });
      }

      // Lookup supporters with this skill
      const supporterMatches = supporters.filter(s =>
        s.support_skills?.some(sk => sk.toLowerCase() === upgradedSkill.skill_name.toLowerCase()) ||
        s.event_skills?.some(sk => sk.toLowerCase() === upgradedSkill.skill_name.toLowerCase())
      );

      // Format supporter names into a list
      let supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          embeds: [buildSkillEmbed(upgradedSkill, supporterList)],
          components: buildSkillComponents(upgradedSkill, supporterMatches.length, supporterMatches)
        }
      });
    }

    // Handling looking up the downgraded skill
    if (custom_id.startsWith("downgrade_")) {
      const downgradedName = custom_id.replace("downgrade_", "").toLowerCase();
      const downgradedSkill = skills.find(s =>
        s.skill_name.toLowerCase() === downgradedName
      );

      if (!downgradedSkill) {
        return res.send({
          type: InteractionResponseType.UPDATE_MESSAGE,
          data: { content: "⚠️ Downgraded skill not found!" }
        });
      }

      // Lookup supporters with this skill
      const supporterMatches = supporters.filter(s =>
        s.support_skills?.some(sk => sk.toLowerCase() === downgradedSkill.skill_name.toLowerCase()) ||
        s.event_skills?.some(sk => sk.toLowerCase() === downgradedSkill.skill_name.toLowerCase())
      );

      // Format supporter names into a list
      let supporterList = supporterMatches.length
        ? supporterMatches.map(s => `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`).join('\n')
        : 'None';

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          embeds: [buildSkillEmbed(downgradedSkill, supporterList)],
          components: buildSkillComponents(downgradedSkill, supporterMatches.length, supporterMatches)
        }
      });
    }

    if (custom_id === "uma_select") {
      const selectedTitle = values[0];
      const uma = characters.find(c =>
        c.id === selectedTitle
      );

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${uma.character_name} (${uma.type})**`,
          embeds: [buildUmaEmbed(uma, skills)],
          components: buildUmaComponents(uma, true, characters)
        }
      });
    }

    if (custom_id === "uma_variant_select") {
      const selectedVariantId = values[0];
      const variant = characters.find(c => c.id === selectedVariantId);

      if (!variant) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Variant not found.` }
        });
      }

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE, // update the same message
        data: {
          embeds: [buildUmaEmbed(variant, skills)],
          components: buildUmaComponents(variant, true, characters)
        }
      });
    }

    // Handling selecting a skill from Uma's skill dropdown
    if (custom_id === "uma_skill_select") {
      const [umaId, selectedTitle] = values[0].split("::");

      const uma = characters.find(c => c.id === umaId);

      const skill = skills.find(s =>
        s.skill_name.toLowerCase() === selectedTitle.toLowerCase()
      );

      if (!skill) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Skill "${values[0]}" not found.` }
        });
      }

      // Lookup supporters with this skill
      const supporterMatches = supporters.filter(s =>
        s.support_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase()) ||
        s.event_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase())
      );

      let supporterList = supporterMatches.length
        ? supporterMatches.map(s =>
            `• ${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`
          ).join('\n')
        : 'None';

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${skill.skill_name}**`,
          embeds: [buildUmaEmbed(uma, skills), buildSkillEmbed(skill, supporterList)],
          components: [
            ...buildUmaComponents(uma, true, characters),
            ...buildSkillComponents(skill, supporterMatches.length, supporterMatches)
          ]
        }
      });
    }

    if (custom_id === "event_select") {
      const selectedId = values[0]; // exact match
      const event = events.find(s => s.id === selectedId);

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${event.event_name}**`,
          embeds: [buildEventEmbed(event, events)] // remove the dropdown after selection
        }
      });
    }

    if (custom_id === "race_select") {
      const selectedId = values[0];
      const race = races.find(r => r.id === selectedId);

      if (!race) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Race not found.` }
        });
      }

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${race.race_name}**`,
          embeds: [buildRaceEmbed(race, characters)],
          components: [] // remove the dropdown after selection
        }
      });
    }
  }

console.error('unknown interaction type', type);
return res.status(400).json({ error: 'unknown interaction type' });
});

async function sendFollowup(token, payload) {
  const response = await fetch(
    `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${token}`, 
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("Follow-up failed:", response.status, errText);
  } 

  return response;
}


app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
