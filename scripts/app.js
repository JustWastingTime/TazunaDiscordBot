import 'dotenv/config';
import express from 'express';

// Validate required env vars at startup (fail fast with clear message)
const PUBLIC_KEY = process.env.PUBLIC_KEY || process.env.DISCORD_PUBLIC_KEY;
if (!PUBLIC_KEY) {
  console.error("Missing required env var: PUBLIC_KEY (Discord Application Public Key)");
  console.error("Add it in Railway: Project → Service → Variables → PUBLIC_KEY = <your public key>");
  process.exit(1);
}
import fs from 'fs';
import {
  ButtonStyleTypes,
  InteractionResponseFlags,
  InteractionResponseType,
  InteractionType,
  MessageComponentTypes,
  verifyKeyMiddleware,
} from 'discord-interactions';
import { scheduleColors, truncate, buildSupporterEmbed, buildSkillEmbed, buildSkillComponents, getColor, getCustomEmoji, parseEmojiForDropdown, buildEventEmbed, buildUmaEmbed, buildUmaComponents, buildRaceEmbed, buildCMEmbed, capitalize, buildResourceEmbed, buildEpithetEmbed, buildEpithetListPayload, EPITHET_PAGINATION_ID_PREFIX } from './utils.js';
import cache from './githubCache.js';
import { parseWithOcrSpace, parseUmaProfile, buildUmaParsedEmbed, generateUmaLatorLink, shortenUrl } from './parser.js';


import path from 'path';
import { fileURLToPath } from "url";

// ESM-friendly __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const characters = cache.characters;
const supporters = cache.supporters;
const events = cache.events;
const skills = cache.skills;
const races = cache.races;
const champsmeets = cache.champsmeets;
const legendraces = cache.legendraces;
const misc = cache.misc;
const schedule = cache.schedule;
const resources = cache.resources;
const epithets = cache.epithets;

// Create an express app
const app = express();
// Get port, or default to 3000
const PORT = process.env.PORT || 3000;

// Serve static assets (including guide images)
app.use('/assets', express.static(path.join(__dirname, '../assets')));


/**
 * Interactions endpoint URL where Discord will send HTTP requests
 * Parse request body and verifies incoming requests using discord-interactions package
 */
app.post('/interactions', verifyKeyMiddleware(PUBLIC_KEY), async function (req, res) {
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
          s.category.toLowerCase().includes(q) ||
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

        // Lookup supporters with this skill, hide r cards
        const supporterMatches = supporters.filter(s => {
          if (s.rarity == "r") return false;

          return (
            s.support_skills?.some(sk => sk.toLowerCase() === matches[0].skill_name.toLowerCase()) ||
            s.event_skills?.some(sk => sk.toLowerCase() === matches[0].skill_name.toLowerCase())
          );
        });

        // Sort supporters by rarity (ssr first)
        supporterMatches.sort((a, b) => {
          const order = { ssr: 0, sr: 1 };
          return order[a.rarity.toLowerCase()] - order[b.rarity.toLowerCase()];
        });

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
            umalatorUrl = await generateUmaLatorLink(parsed);

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

    if (name === "schedule") {
      res.send({
        type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
      });

      try {
        const schedules = schedule;

        for (const event of schedules) {
          const components = [
            {
              type: MessageComponentTypes.CONTAINER,
              accent_color: scheduleColors[event.event_type] || scheduleColors.Default,
              components: [
                {
                  type: MessageComponentTypes.MEDIA_GALLERY,
                  items: [
                    {
                      media: { url: event.thumbnail }
                    }
                  ]
                },
                {
                  type: MessageComponentTypes.TEXT_DISPLAY,
                  content: `${event.date}`
                }
              ]
            }
          ];

          const payload = {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components
          };

          // Send one message per schedule item
          await sendFollowup(token, payload);
        }
      } catch (err) {
        console.error("Schedule command error:", err);
        await sendFollowup(token, { content: "❌ Failed to load schedule." });
      }

      return;
    }

    // "resource" command
    if (name === 'resource') {
      const query = data.options?.find(opt => opt.name === "mode")?.value?.toLowerCase();

      // Find matches
      const matches = resources.filter(c => {
        if (!query) return true;

        return (
          c.name.toLowerCase().includes(query)
        );
      });


      // No matches
      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Resource "${query}" not found.` }
        });
      }

      // One match → embed
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildResourceEmbed(matches[0])
          
        });
      }
    }

    // "qp" command
    if (name === 'qp') {
      const guideKey = data.options?.find(opt => opt.name === "guide")?.value;

      const qpGuides = {
        training_basics: {
          title: "Sample Race Schedule",
          filename: "sample_schedule.png",
        },
        race_bonus_and_hammers: {
          title: "Race Bonus and Hammers",
          filename: "race_bonus_and_hammers.png",
        },
        consecutive_race_penalty: {
          title: "Consecutive Race Penalty",
          filename: "consecutive_race_penalty.png",
        },
        mood_energy_mant: {
          title: "Trackblazer Mood & Energy Events",
          filename: "mood_energy_mant.png",
        },
        unique_levels: {
          title: "Unique Levels",
          filename: "unique_levels.png",
        },
      };

      const guide = qpGuides[guideKey];

      if (!guide) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "❌ Unknown guide selected." }
        });
      }

      const protocol = req.get('x-forwarded-proto') || req.protocol || 'http';
      const host = req.get('host');
      const baseUrl = host ? `${protocol}://${host}` : '';
      const imageUrl = `${baseUrl}/assets/guides/${guide.filename}`;

      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: guide.title,
          embeds: [
            {
              image: { url: imageUrl }
            }
          ]
        }
      });
    }

    // "epithet" command
    if (name === 'epithet') {
      const nameOpt = data.options?.find(opt => opt.name === 'name')?.value?.trim?.() || '';
      const queryTerms = nameOpt ? nameOpt.toLowerCase().split(/\s+/) : [];

      const matches = epithets.filter(e => {
        if (queryTerms.length === 0) return true;
        const id = (e.id || '').toLowerCase();
        const conditions = (e.conditions || '').toLowerCase();
        const reward = (e.reward || '').toLowerCase();
        const aliases = (e.aliases || []).map(a => String(a).toLowerCase());
        return queryTerms.every(q =>
          id.includes(q) ||
          conditions.includes(q) ||
          reward.includes(q) ||
          aliases.some(a => a.includes(q))
        );
      });

      if (matches.length === 0) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ No epithet found${nameOpt ? ` for "${nameOpt}"` : ''}.` }
        });
      }

      // Single match → detail view (including when search is exact/specific)
      if (matches.length === 1) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: buildEpithetEmbed(matches[0])
        });
      }

      // Multiple matches → list with pagination
      const listPayload = buildEpithetListPayload(matches, 0, nameOpt || null);
      return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: listPayload
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
      const supporterMatches = supporters.filter(s => {
        if (s.rarity == "r") return false;
        return (
          s.support_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase()) ||
          s.event_skills?.some(sk => sk.toLowerCase() === skill.skill_name.toLowerCase())
        );
      });

      // Sort supporters by rarity (ssr first)
      supporterMatches.sort((a, b) => {
        const order = { ssr: 0, sr: 1 };
        return order[a.rarity.toLowerCase()] - order[b.rarity.toLowerCase()];
      });

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

    if (custom_id === "cm_select") {
      const selectedId = values[0];
      const cm = champsmeets.find(c => c.name === selectedId);

      if (!cm) {
        return res.send({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: `❌ Champion's Meet not found.` }
        });
      }

      const cmPayload = buildCMEmbed(cm);

      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: {
          content: `✅ You selected **${cm.name}**`,
          ...cmPayload
        }
      });
    }

    // Epithet list pagination
    if (custom_id.startsWith(EPITHET_PAGINATION_ID_PREFIX)) {
      const after = custom_id.slice(EPITHET_PAGINATION_ID_PREFIX.length);
      const sep = after.indexOf('_');
      const page = Math.max(0, parseInt(sep >= 0 ? after.slice(0, sep) : after, 10) || 0);
      const queryEnc = sep >= 0 ? after.slice(sep + 1) : '';
      const queryTerms = queryEnc ? queryEnc.toLowerCase().split(/\s+/) : [];

      const matches = epithets.filter(e => {
        if (queryTerms.length === 0) return true;
        const id = (e.id || '').toLowerCase();
        const conditions = (e.conditions || '').toLowerCase();
        const reward = (e.reward || '').toLowerCase();
        const aliases = (e.aliases || []).map(a => String(a).toLowerCase());
        return queryTerms.every(q =>
          id.includes(q) ||
          conditions.includes(q) ||
          reward.includes(q) ||
          aliases.some(a => a.includes(q))
        );
      });

      const listPayload = buildEpithetListPayload(matches, page, queryEnc || null);
      return res.send({
        type: InteractionResponseType.UPDATE_MESSAGE,
        data: listPayload
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

// --- Terms of Service & Privacy Policy (for Discord verification / discovery) ---
const termsHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Terms of Service – Tazuna Bot</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .updated { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
  </style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p class="updated">Last updated: March 2025</p>
  <p>By inviting and using <strong>Tazuna</strong> (“the Bot”) in your Discord server, you agree to these terms.</p>
  <ul>
    <li>You must comply with <a href="https://discord.com/terms">Discord’s Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a>.</li>
    <li>You may not use the Bot for spam, abuse, or to violate any applicable laws.</li>
    <li>The Bot is provided “as is.” We do not guarantee uptime or specific features.</li>
    <li>We may update or discontinue the Bot with reasonable notice where possible.</li>
  </ul>
  <p>If you do not agree, please remove the Bot from your server.</p>
</body>
</html>
`;

const privacyHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Privacy Policy – Tazuna Bot</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #333; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .updated { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    h2 { font-size: 1.1rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="updated">Last updated: March 2025</p>
  <p>This policy describes what data <strong>Tazuna</strong> (“the Bot”) collects and how it is used.</p>
  <h2>Data we collect</h2>
  <ul>
    <li><strong>Discord data:</strong> User IDs, usernames, server (guild) IDs, and channel IDs when you use commands or when your server uses leaderboard/sheets features.</li>
    <li><strong>Saved data:</strong> If you use the save command, we store the labels and URLs (e.g. Umalator links) you provide, associated with your Discord user ID.</li>
    <li><strong>Server data:</strong> For servers that use leaderboards or Google Sheets sync, we store server configuration (e.g. sheet IDs, channel IDs) and fan/rank data synced from your sheet.</li>
    <li><strong>Images:</strong> Images you upload for profile parsing are sent to a third-party OCR service for text extraction; we do not store the image content long-term.</li>
  </ul>
  <h2>How we use it</h2>
  <p>Data is used to provide Bot features (leaderboards, trainer lookups, saved links, sheet sync, image parsing) and to operate the service.</p>
  <h2>Storage & sharing</h2>
  <p>Data is stored on the Bot’s hosting infrastructure and, where configured, in Google Sheets. We do not sell your data. We may share data only as required by law or to protect the service.</p>
  <h2>Your rights</h2>
  <p>You can stop using the Bot and remove it from your server at any time. Data tied to your user or server may remain in our storage until we purge it; you can request deletion by contacting the Bot developer.</p>
  <h2>Changes</h2>
  <p>We may update this policy; the “Last updated” date will be revised. Continued use of the Bot after changes constitutes acceptance.</p>
</body>
</html>
`;

app.get('/terms', (req, res) => {
  res.type('html').send(termsHtml);
});

app.get('/privacy', (req, res) => {
  res.type('html').send(privacyHtml);
});

app.listen(PORT, () => {
  console.log('Listening on port', PORT);
});
