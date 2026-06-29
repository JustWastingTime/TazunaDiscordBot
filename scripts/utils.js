import 'dotenv/config';
import fs from 'fs';
import { url } from 'inspector';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let skillCategoryEmotes = {};
try {
  const filePath = path.join(__dirname, '..', 'assets', 'skillemotes.json');
  skillCategoryEmotes = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (err) {
  console.warn("No skillemotes.json found, using default fallback.");
  skillCategoryEmotes = {
    default: '✨'
  };
}

export { skillCategoryEmotes };

/** Load JSON file, return defaultValue if file doesn't exist (e.g. ENOENT). */
export function loadJsonSafe(filePath, defaultValue = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT" || e.code === "ENOTDIR") {
      return defaultValue;
    }
    throw e;
  }
}
const rankCategoryEmotes = {
  A: '<:RankA:1412694937203511336>',
  B: '<:RankB:1412694961358372894>',
  C: '<:RankC:1412694982363578450>',
  D: '<:RankD:1412695001825284198>',
  E: '<:RankE:1412695032137257040>',
  F: '<:RankF:1412695050969681982>',
  G: '<:RankG:1412695075271475212>',
  S: '<:RankS:1412695122784551033>',
  default: '❓' // fallback
};

const raceGradeIcons = {
  G1: 'https://gametora.com/images/umamusume/race_ribbons/utx_txt_grade_ribbon_05.png',
  G2: 'https://gametora.com/images/umamusume/race_ribbons/utx_txt_grade_ribbon_04.png',
  G3: 'https://gametora.com/images/umamusume/race_ribbons/utx_txt_grade_ribbon_03.png',
  EX: 'https://gametora.com/images/umamusume/race_ribbons/utx_txt_grade_ribbon_07.png',
  default: '' // fallback
};

export const scheduleColors = {
  "Anniversary": 0xFFD700,
  "Scenario": 0x00BFFF,
  "Banner": 0xFF69B4,
  "Legend Races": 0xFFA500,
  "Champions Meeting": 0xADFF2F,
  "Story Event": 0x9370DB,
  "Default": 0x808080
};


export async function DiscordRequest(endpoint, options) {
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  // Stringify payloads
  if (options.body) options.body = JSON.stringify(options.body);
  // Use fetch to make requests
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
    },
    ...options
  });
  // throw API errors
  if (!res.ok) {
    const data = await res.json();
    console.log(res.status);
    throw new Error(JSON.stringify(data));
  }
  // return original response
  return res;
}

export async function InstallGlobalCommands(appId, commands) {
  // API endpoint to overwrite global commands
  const endpoint = `applications/${appId}/commands`;

  try {
    // This is calling the bulk overwrite endpoint: https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
  } catch (err) {
    console.error(err);
  }
}

export async function InstallGuildCommands(appId, guildId, commands) {
  const endpoint = `applications/${appId}/guilds/${guildId}/commands`;

  try {
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
  } catch (err) {
    console.error(err);
  }
}

// Simple method that returns a random emoji from list
export function getRandomEmoji() {
  const emojiList = ['😭','😄','😌','🤓','😎','😤','🤖','😶‍🌫️','🌏','📸','💿','👋','🌊','✨'];
  return emojiList[Math.floor(Math.random() * emojiList.length)];
}

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Helper used above
export function truncate(s, max) {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function getRarityImageLink(str) {
  if (str === 'SSR' || str === 'ssr')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_txt_rarity_03.png';
  }
  else if (str === 'SR' || str === 'sr')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_txt_rarity_02.png';
  }
  if (str === 'R' || str === 'r')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_txt_rarity_01.png';
  }
}

function getCardTypeImageLink(str) {
  if (str === 'speed')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_ico_obtain_00.png';
  }
  if (str === 'stamina')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_ico_obtain_01.png';
  }
  if (str === 'power')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_ico_obtain_02.png';
  }
  if (str === 'guts')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_ico_obtain_03.png';
  }
  if (str === 'wit')
  {
    return 'https://gametora.com/images/umamusume/icons/utx_ico_obtain_04.png';
  }
}

// Emoji for the Card Type Dropdown
export function getCustomEmoji(str) {
  if (str === 'speed')
  {
    return { "id": "1409344810426564750", "name": "Speed" };
  }
  else if (str === 'stamina')
  {
    return { "id": "1409340937137684551", "name": "Stamina" };
  }
  else if (str === 'power')
  {
    return { "id": "1409344836322070578", "name": "Power" };
  }
  else if (str === 'wit')
  {
    return { "id": "1409344858698551367", "name": "Wit" };
  }
  else if (str === 'guts')
  {
    return { "id": "1409344879930249216", "name": "Guts" };
  }
  else if (str === 'friend')
  {
    return { "id": "1409344903833452604", "name": "Friend" };
  }
  else if (str === 'group')
  {
    return { "id": "1409344925103030315", "name": "Group" };
  }
}

// Emoji for the Skill Type Dropdown
export function getSkillEmoji(str) {
   if (!str) return skillCategoryEmotes.default;

  // normalize: lowercase & strip spaces
  const key = str.toLowerCase().replace(/\s+/g, "");

  return skillCategoryEmotes[key] || skillCategoryEmotes.default;
}

export function parseEmojiForDropdown(emojiStr) {
   if (!emojiStr) return { name: "❔" }; // fallback

  const customMatch = emojiStr.match(/^<:(\w+):(\d+)>$/);
  if (customMatch) {
    // Custom emoji
    return { id: customMatch[2], name: customMatch[1] };
  }

  // Assume Unicode emoji
  return { name: emojiStr };
}


export function getRankEmoji(str) {
   if (!str) return rankCategoryEmotes.default;

  // normalize: lowercase & strip spaces
  const key = str;

  return rankCategoryEmotes[key] || rankCategoryEmotes.default;
}

function getRaceGradeIcons(str) {
   if (!str) return raceGradeIcons.default;

  // normalize: lowercase & strip spaces
  const key = str;

  return raceGradeIcons[key] || raceGradeIcons.default;
}

export function getColor(str) {
  if (str === 'red')
  {
    return 16734029;
  }
  else if (str === 'blue')
  {
    return 3915519;
  }
  else if (str === 'green')
  {
    return 5939528;
  }
  else if (str === 'yellow')
  {
    return 16769113;
  }
  else if (str === 'pink')
  {
    return 16738283;
  }
  else if (str === 'orange')
  {
    return 15699013;
  }
  else if (str === 'greener')
  {
    return 1733686;
  }
  else if (str === 'purple') {
    return 10181046;
  }
}

// Returns Color for the Cards Embed
export function getCardColor(str)
{
  if (str === 'speed')
  {
    return getColor('blue');
  }
  else if (str === 'stamina')
  {
    return getColor('red');
  }
  else if (str === 'power')
  {
    return getColor('yellow');
  }
  else if (str === 'guts')
  {
    return getColor('pink');
  }
  else if (str === 'wit')
  {
    return getColor('green');
  }
  else if (str === 'friend')
  {
    return getColor('orange');
  }
  else if (str === 'group')
  {
    return getColor('greener');
  }
}

// Returns Color for the Skills Embed
export function getSkillColor(str)
{
  if (str === 'speed')
  {
    return getColor('green');
  }
}

// Get Gametora's thumbnail for the skill
export function getSkillThumbnail(str)
{
  if (str === 'speed')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10011.png';
  }
  if (str === 'speednegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10014.png';
  }
  if (str === 'goldenspeed')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10012.png';
  }

  if (str === 'stamina')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10021.png';
  }
  if (str === 'staminanegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10024.png';
  }
  if (str === 'goldenstamina')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10022.png';
  }

  if (str === 'power')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10031.png';
  }
  if (str === 'powernegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10034.png';
  }
  if (str === 'goldenpower')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10032.png';
  }

  if (str === 'guts')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10041.png';
  }
  if (str === 'gutsnegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10044.png';
  }

  if (str === 'gate')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10051.png';
  }
  if (str === 'gatenegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10054.png';
  }

  if (str === 'super7')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10061.png';
  }
  if (str === 'goldensuper7')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_10062.png';
  }

  if (str === 'recovery')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20021.png';
  }
  if (str === 'goldenrecovery')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20022.png';
  }
  if (str === 'rainbowrecovery')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20023.png';
  }
  if (str === 'recoverynegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20024.png';
  }
  if (str === 'recoveryspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20111.png';
  }
  if (str === 'goldenrecoveryspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20112.png';
  }

  if (str === 'velocity')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20011.png';
  }
  if (str === 'goldenvelocity')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20012.png';
  }
  if (str === 'rainbowvelocity')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20013.png';
  }
  if (str === 'velocitynegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20014.png';
  }
  if (str === 'velocityspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20101.png';
  }
  if (str === 'goldenvelocityspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20102.png';
  }
  if (str === 'goldenvelocitynegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20015.png';
  }

  if (str === 'accel')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20041.png';
  }
  if (str === 'goldenaccel')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20042.png';
  }
  if (str === 'rainbowaccel')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20043.png';
  }
  if (str === 'accelnegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20044.png';
  }
  if (str === 'accelspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20121.png';
  }
  if (str === 'goldenaccelspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20122.png';
  }

  if (str === 'flow')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20051.png';
  }
  if (str === 'goldenflow')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20052.png';
  }
  if (str === 'flowspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20131.png';
  }
  if (str === 'goldenflowspecial')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20132.png';
  }

  if (str === 'focus')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20061.png';
  }
  if (str === 'goldenfocus')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20062.png';
  }
  if (str === 'focusnegative')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20064.png';
  }

  if (str === 'vision')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20091.png';
  }
  if (str === 'goldenvision')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_20092.png';
  }

  if (str === 'velocitydebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30011.png';
  }
  if (str === 'goldenvelocitydebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30012.png';
  }

  if (str === 'acceldebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30021.png';
  }
  if (str === 'goldenacceldebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30022.png';
  }

  if (str === 'frenzy')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30041.png';
  }

  if (str === 'recoverydebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30051.png';
  }
  if (str === 'goldenrecoverydebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30052.png';
  }

  if (str === 'visiondebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30071.png';
  }
  if (str === 'goldenvisiondebuff')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_30072.png';
  }

  if (str === 'runaway')
  {
    return 'https://gametora.com/images/umamusume/skill_icons/utx_ico_skill_40012.png';
  }
}

export function formatCardSkill(skillName, skillsJSON)
{
  const skill = skillsJSON.find(s => 
    s.skill_name.toLowerCase() === skillName.toLowerCase()
  );

  if (!skill) {
    return `${skillCategoryEmotes.default} ${skillName}`; // fallback
  }

  const emote = skillCategoryEmotes[skill.category] || skillCategoryEmotes.default;
  return `${emote} ${skillName}`;
}

export function buildSupporterEmbed(supporter, skills, level) {
  if (!supporter || typeof supporter !== "object") {
    return {
      title: "Supporter not found",
      description: "The selected supporter could not be loaded. Please run the command again.",
      color: 0xE74C3C
    };
  }

  const effects = (supporter.effects || []).map(e => {
    if (level !== undefined) {
      // Example: "Friendship Bonus – 20/21/23/25/25%"
      const [label, values] = e.split(/–|-/).map(s => s.trim());
      if (values) {
        const match = values.match(/^([\d/.\s]+)(.*)$/); 
        if (match) {
          const parts = match[1].split("/").map(v => v.trim());
          const suffix = match[2].trim(); // capture things like "%", "pt"
          if (parts[level] !== undefined) {
            return `✨ ${label} – ${parts[level]}${suffix}`;
          }
        }
      }
    }
    return `✨ ${e}`;
  });

  return {
    title: supporter.card_name + ' (' + supporter.rarity.toUpperCase() +')',
    description:
      '__Unique__ \n' +
      supporter.unique +
      '\n\n' +
      effects.join('\n') +
      '\n \u200B',
    color: getCardColor(supporter.category),
    thumbnail: { url: supporter.thumbnail },
    fields: [
      {
        name: 'Support Skills',
        value: supporter.support_skills
          .map(e => formatCardSkill(e, skills))
          .join('\n'),
        inline: true
      },
      {
        name: 'Event Skills',
        value: supporter.event_skills
          .map(e => formatCardSkill(e, skills))
          .join('\n'),
        inline: true
      }
    ],
    author: {
      name: supporter.character_name,
      icon_url: getCardTypeImageLink(supporter.category)
    },
    url: supporter.url,
    footer: typeof level === "number"
    ? { text: `Showing data for LB ${level}` }
    : undefined
  };
}

export function buildSupporterComponents(supporter, level) {
  const truncateForSelect = (text, max = 100) => {
    if (!text) return "";
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  };
  const getSupporterEventTitle = (event, index, allEvents) => {
    const baseTitle = event?.name || `Event ${index + 1}`;
    if (String(event?.type || "").toLowerCase() !== "chain") {
      return baseTitle;
    }

    let chainStep = 0;
    for (let i = 0; i <= index; i++) {
      if (String(allEvents?.[i]?.type || "").toLowerCase() === "chain") {
        chainStep += 1;
      }
    }

    return `(${ "❯".repeat(Math.max(1, chainStep)) }) ${baseTitle}`;
  };

  const allSkills = [
    ...(supporter.support_skills || []),
    ...(supporter.event_skills || [])
  ];
  const dedupedSkills = [...new Set(allSkills)];
  const events = supporter.events || [];

  if (dedupedSkills.length === 0 && events.length === 0) {
    return [];
  }

  const rows = [];

  if (dedupedSkills.length > 0) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "supporter_skill_select",
          placeholder: "Select a skill",
          options: dedupedSkills.slice(0, 25).map(skillName => ({
            label: truncateForSelect(skillName, 100),
            value: `${supporter.id}|${level ?? ""}::${skillName}`
          }))
        }
      ]
    });
  }

  if (events.length > 0) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3,
          custom_id: "supporter_event_select",
          placeholder: "Select an event",
          options: events.slice(0, 25).map((event, index) => {
            const results = Array.isArray(event.results) ? event.results : [];
            const preview = results
              .slice(0, 2)
              .map((r, i) => `Result ${i + 1}: ${r}`)
              .join(" | ");
            return {
              label: truncateForSelect(getSupporterEventTitle(event, index, events), 100),
              value: `${supporter.id}|${level ?? ""}::${index}`,
              description: truncateForSelect(preview || "No result text", 100)
            };
          })
        }
      ]
    });
  }

  return rows;
}

export function buildSupporterEventEmbed(supporter, event, eventIndex = 0) {
  const fields = [];
  const results = Array.isArray(event?.results) ? event.results : [];
  const allEvents = supporter?.events || [];
  const baseTitle = event?.name || `Event ${eventIndex + 1}`;
  let title = baseTitle;

  if (String(event?.type || "").toLowerCase() === "chain") {
    let chainStep = 0;
    for (let i = 0; i <= eventIndex; i++) {
      if (String(allEvents?.[i]?.type || "").toLowerCase() === "chain") {
        chainStep += 1;
      }
    }
    title = `(${ "❯".repeat(Math.max(1, chainStep)) }) ${baseTitle}`;
  }

  const conditionRaw = event?.condition ?? event?.conditions ?? event?.trigger ?? event?.triggers;
  if (conditionRaw) {
    const conditionText = Array.isArray(conditionRaw)
      ? conditionRaw.map(t => `- ${t}`).join("\n")
      : String(conditionRaw);
    fields.push({
      name: "Condition",
      value: conditionText,
      inline: false
    });
  }

  if (results.length > 0) {
    results.forEach((result, idx) => {
      fields.push({
        name: `Result ${idx + 1}`,
        value: String(result),
        inline: false
      });
    });
  } else {
    fields.push({
      name: "Results",
      value: "No results listed.",
      inline: false
    });
  }

  return {
    title,
    color: getCardColor(supporter.category),
    author: {
      name: `${supporter.character_name} (${supporter.card_name})`,
      icon_url: getCardTypeImageLink(supporter.category)
    },
    fields
  };
}

export function buildSkillEmbed(skill, supporterList) {
  const fields = [];

  // ===== Preconditions =====
  if (skill.preconditions && skill.preconditions.length > 0) {
    fields.push({
      name: "Preconditions",
      value: skill.preconditions.map(p => `- ${p}`).join("\n") + "\n\u200B",
      inline: false
    });
  }

  // ===== Effects =====
  if (skill.effect && skill.effect.length > 0) {
    skill.effect.forEach((effect, index) => {
      let value = "";

      // Conditions
      if (effect.conditions && effect.conditions.length > 0) {
        value += effect.conditions.map(c => `- ${c}`).join("\n");
      }

      // Effect description
      value += `\n\n**Effect:**\n${effect.description}`;

      // Inherited effect (if exists)
      if (effect.inherited) {
        value += `\n\n**Inherited:**\n${effect.inherited}`;
      }

      fields.push({
        name: skill.effect.length > 1 ? `Condition ${index + 1}` : "Condition",
        value: value + "\n\u200B",
        inline: true
      });
    });
  }

  if (skill.horse) {
    fields.push({
      name: "Inherited from",
      value: skill.horse,
      inline: false
    });
  }

  return {
    description: skill.description + "\n\u200B",
    color: getSkillColor(skill.category),
    author: {
      icon_url: getSkillThumbnail(skill.category),
      name: skill.skill_name,
      url: "https://gametora.com/umamusume/skill-condition-viewer?skill=" + skill.gametora_id
    },
    fields: fields
  };
}

export function appendMapOverrideToSkillNavId(baseId, mapOverrideKey) {
  if (!mapOverrideKey) return baseId;
  return `${baseId}::${mapOverrideKey}`;
}

export function parseSkillNavCustomId(customId) {
  const match = String(customId ?? "").match(/^(upgrade_|downgrade_)(.+)$/);
  if (!match) return null;
  const rest = match[2];
  const sep = rest.indexOf("::");
  if (sep === -1) {
    return { kind: match[1] === "upgrade_" ? "upgrade" : "downgrade", targetName: rest, mapOverrideKey: null };
  }
  return {
    kind: match[1] === "upgrade_" ? "upgrade" : "downgrade",
    targetName: rest.slice(0, sep),
    mapOverrideKey: rest.slice(sep + 2) || null,
  };
}

export function buildUmalatorSkillVisualizerUrl(cid, sid) {
  if (!cid || !sid) return null;
  return `https://umalator.app/umalator-global/skill-visualizer/v2/#cid=${cid},sid=${sid}`;
}

export function buildSkillComponents(skill, includeDropdown = false, supporters, mapOverrideKey = null, mapCid = null) {
  const rows = [];
  const buttonComponents = [];

  // Dropdown (if needed)
  if (includeDropdown) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3, // SELECT_MENU
          custom_id: "supporter_lookup_select",
          placeholder: "Lookup Supporters with this skill",
          options: supporters.slice(0, 25).map(s => ({
            label: `${s.character_name} - ${s.card_name} (${s.rarity.toUpperCase()})`,
            value: s.id,
            emoji: getCustomEmoji(s.category)
          }))
        }
      ]
    });
  }

  // Upgrade button (if skill has one)
  if (skill.upgrade) {
    buttonComponents.push({
      type: 2,
      style: 1,
      label: `Upgrade → ${skill.upgrade}`,
      custom_id: appendMapOverrideToSkillNavId(`upgrade_${skill.upgrade}`, mapOverrideKey),
    });
  }

  // Downgrade button (if skill has one)
  if (skill.downgrade) {
    buttonComponents.push({
      type: 2,
      style: 1,
      label: `Downgrade → ${skill.downgrade}`,
      custom_id: appendMapOverrideToSkillNavId(`downgrade_${skill.downgrade}`, mapOverrideKey),
    });
  }

  const umalatorUrl = buildUmalatorSkillVisualizerUrl(mapCid, skill.gametora_id);
  if (umalatorUrl) {
    buttonComponents.push({
      type: 2,
      style: 5,
      label: "Umalator's Visualizer",
      url: umalatorUrl,
    });
  }

  // Only push row if buttons exist
  if (buttonComponents.length > 0) {
    rows.push({
      type: 1,
      components: buttonComponents
    });
  }

  return rows;

}

export function buildEventEmbed(event, eventList) {
  const fields = [
    { 
      name: "Type", 
      value: `${event.type} (${event.subtype})\n \u200B`, 
      inline: true 
    },
    { 
      name: "Source", 
      value: event.source_name ? event.source_name + '\n \u200B' : "—\n \u200B", 
      inline: true 
    },
    {
      name: "Options",
      value: event.options.map((opt, i) => {
        const outcomesText = opt.outcomes.map(o => {
          const effectsText = o.effects.map(e => `🔸 ${e}`).join("\n");

          if (o.chance === 100) {
            // hide chance if it's exactly 100
            return effectsText;
          } else if (typeof o.chance === "number") {
            // numeric chance, show with %
            return `*Chance ${o.chance}%:*\n${effectsText}`;
          } else if (typeof o.chance === "string") {
            // string chance, show without %
            return `*${o.chance}:*\n${effectsText}`;
          } else {
            // fallback (no chance provided)
            return effectsText;
          }
        }).join("\n");

        return `__Option ${i + 1}:__ ${opt.option_text}\n${outcomesText}`;
      }).join("\n\n")
    }
  ];

  return {
    title: event.event_name,  
    description: (event.conditions || "") + '\n \u200B',
    thumbnail: { url: event.thumbnail || "" },
    fields: fields
  };
}

export function buildUmaEmbed(uma, skills) {
  if (!uma || typeof uma !== "object") {
    return {
      title: "Uma not found",
      description: "The selected character could not be loaded. Please run the command again.",
      color: 0xE74C3C
    };
  }

  const epithetValue = uma.epithet
    ? (typeof uma.epithet === "string"
        ? uma.epithet
        : [
            uma.epithet.name ? `**${uma.epithet.name}**` : null,
            uma.epithet.condition || null
          ].filter(Boolean).join("\n"))
    : null;

  return {
    title: `${uma.character_name} (${uma.type})`,
    fields: [
      { name: "Rarity", value: uma.rarity + '\n \u200B', inline: true },
      {
        name: "Stat Bonuses",
        value: Object.entries(uma.stat_bonuses?.[0] || {})
          .filter(([_, v]) => v) // only show non-empty
          .map(([k, v]) => {
            const emoji = getCustomEmoji(k);
            return emoji ? `<:${emoji.name}:${emoji.id}> ${v}` : `${k}: ${v}`;
          })
          .join(" ") + '\n \u200B' || "—\n \u200B",
        inline: true
      },
      {
        name: "Aptitudes",
        value: (uma.aptitudes || [])
          .map(group =>
            Object.entries(group)
              .map(([k, v]) => `${k}: ${getRankEmoji(v)}`)
              .join(" | ")  
          )
          .join("\n") + '\n \u200B',  // ← put each aptitude group on a new line
        inline: false
      },
      ...(epithetValue
        ? [
            {
              name: "Epithet",
              value: `${epithetValue}\n \u200B`,
              inline: false
            }
          ]
        : []),
      { name: "Unique Skill", value: `${formatCardSkill(uma.unique, skills)}` + '\n \u200B', inline: false },
      {
        name: "Skills",
        value: uma.skills?.length ? uma.skills.map(e => formatCardSkill(e, skills)).join("\n ") : "—",
        inline: true
      },
      {
        name: "Potential",
        value: uma.potential?.length ? uma.potential.map(e => formatCardSkill(e, skills)).join("\n ") : "—",
        inline: true
      },
      {
        name: "Event Skills",
        value: uma.event_skills?.length ? uma.event_skills.map(e => formatCardSkill(e, skills)).join("\n ") : "—",
        inline: true
      },
      ...(uma.secrets?.length
        ? [
            {
              name: "Secrets",
              value: uma.secrets
                .map(s => `*${s.conditions}* \n${s.rewards}`)
                .join("\n\n") + '\n \u200B',
              inline: false
            }
          ]
        : [])
    ],
    url: uma.url
  };
}

export function buildUmaComponents(uma, includeDropdown = false, charactersJSON) {
  const rows = [];

  // 🔎 Find variants by character_name
  const variants = charactersJSON.filter(u => u.character_name === uma.character_name);

  // Variant dropdown (if more than one)
  if (variants.length > 1) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3, // SELECT_MENU
          custom_id: "uma_variant_select",
          placeholder: `Select a ${uma.character_name} variant`,
          options: variants.map(v => ({
            label: `${v.type} (${v.rarity})`, // e.g. "Original (⭐⭐⭐)"
            value: v.id                    // unique identifier
          }))
        }
      ]
    });
  }

  // Collect all skills
  const allSkills = [
    ...(uma.unique ? [uma.unique] : []),
    ...(uma.skills || []),
    ...(uma.potential || []),
    ...(uma.event_skills || [])
  ];

  // Deduplicate skills
  const dupelessSkills = [...new Set(allSkills)];

  // Skill dropdown (if any skills exist)
  if (dupelessSkills.length > 0) {
    rows.push({
      type: 1,
      components: [
        {
          type: 3, // SELECT_MENU
          custom_id: "uma_skill_select",
          placeholder: "Select a skill",
          options: dupelessSkills.map(s => ({
            label: s,
            value: `${uma.id}::${s}`
          }))
        }
      ]
    });
  }

  return rows;
}

export function buildUmaParsedEmbed(parsed) {
  return {
    title: parsed.name || "Unknown Uma",
    description: parsed.epithet || "",
    fields: [
      {
        name: "Stats",
        value: Object.entries(parsed.stats)
          .map(([k, v]) => `${k}: ${v.rank || ""} ${v.value}`)
          .join("\n"),
        inline: true
      },
      {
        name: "Track",
        value: Object.entries(parsed.track)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        inline: true
      },
      {
        name: "Distance",
        value: Object.entries(parsed.distance)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        inline: true
      },
      {
        name: "Style",
        value: Object.entries(parsed.style)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
        inline: true
      },
      {
        name: "Skills",
        value: parsed.skills.length > 0
          ? parsed.skills.map(s => `• ${s}`).join("\n")
          : "—"
      }
    ]
  };
}

export function buildRaceEmbed(race, charactersJSON) {
  // find all horses that must run this race
  const participants = charactersJSON
    .filter(c => c.races?.includes(race.id))
    .map(c => c.character_name);

  return {
    title: race.race_name,
    thumbnail: { url: race.thumbnail },
    image: { url: race.image },
    fields: [
      { name: "Grade", value: race.grade || "—", inline: true },
      { name: "Track", value: race.racetrack || "—", inline: true },
      { name: "Distance", value: `${race.distance_type} (${race.distance_meters})`, inline: true },
      { name: "Terrain", value: race.terrain || "—", inline: true },
      { name: "Direction", value: race.direction || "—", inline: true },
      { name: "Season", value: race.season || "—", inline: true },
      { name: "Time", value: race.time || "—", inline: true },
      { name: "Sparks", value: race.sparks || "—", inline: true },
      participants.length > 0
        ? { name: "Umas (Objective Races)", value: participants.join(", ") }
        : { name: "Umas (Objective Races)", value: "None" }
    ],
    author: {
      name: race.date,
      icon_url: getRaceGradeIcons(race.grade)
    },
    url: race.url
  };
}

export function buildMapEmbed(resolved, imageUrl = null) {
  const map = resolved?.rawMap ?? {};
  const customRace = resolved?.customRace ?? null;
  const statThreshold = map.stat_treshold ?? map.stat_threshold ?? map.stat_thresholds ?? "";

  const fields = [
    { name: "Racetrack", value: String(map.racetrack ?? "—"), inline: true },
    { name: "Distance", value: String(map.distance_meters ?? "—"), inline: true },
    { name: "Terrain", value: String(map.terrain ?? "—"), inline: true },
    { name: "Direction", value: String(map.direction ?? "—"), inline: true },
  ];

  if (statThreshold) {
    fields.push({
      name: "Stat Thresholds",
      value: Array.isArray(statThreshold) ? statThreshold.join(" & ") : String(statThreshold),
      inline: false,
    });
  }

  if (customRace?.host) {
    fields.push({ name: "Host", value: String(customRace.host), inline: true });
  }

  if (customRace?.description) {
    fields.push({ name: "About", value: String(customRace.description), inline: false });
  }

  const track = customRace?.track;
  if (track && [track.season, track.ground, track.weather].some(Boolean)) {
    const conditions = [track.season, track.ground, track.weather].filter(Boolean).join("  •  ");
    fields.push({ name: "Conditions", value: conditions, inline: false });
  }

  if (Array.isArray(map.races) && map.races.length > 0) {
    const racesText = map.races.slice(0, 8).map((race) => `• ${race}`).join("\n");
    fields.push({
      name: "Races",
      value: racesText.length > 1024 ? `${racesText.slice(0, 1021)}...` : racesText,
      inline: false,
    });
  }

  const embed = {
    title: resolved?.label ?? map.name ?? "Course Map",
    fields,
    url: customRace?.url ?? map.url,
  };

  if (imageUrl) {
    embed.image = { url: imageUrl };
  }

  return { embeds: [embed] };
}

export function buildCMEmbed(cm) {
  const buttons = [];

  // Umalator (safe assumption: usually under 512)
  if (cm.umalator && cm.umalator.length <= 512) {
    buttons.push({
      type: 2,
      style: 5,
      label: "To Umalator",
      url: cm.umalator
    });
  }

  return {
    embeds: [
      {
        title: cm.name,
        description: `Starting on \n📅 ${cm.date}`,
        fields: [
          { name: "Racetrack", value: cm.track.racetrack, inline: true },  
          { name: "Distance", value: `${cm.track.distance_type} (${cm.track.distance_meters})`, inline: true },
          { name: "Terrain", value: cm.track.terrain, inline: true },  
          { name: "Conditions", value: `${cm.track.season}  •  ${cm.track.ground}  •  ${cm.track.direction}  •  ${cm.track.weather}`, inline: false },
          { name: "Similar to", value: cm.track.similar ?? "—" }
        ],
        image: { url: cm.image },
        url: cm.url
      }
    ],
    components: buttons.length
      ? [
          {
            type: 1,
            components: buttons
          }
        ]
      : []
  };
}

export function buildResourceEmbed(r) {
  const buttons = [];
  buttons.push({
    type: 2,
    style: 5,
    label: "View Resource",
    url: r.url
  });
  

  return {
    embeds: [
      {
        title: r.name,
        description: r.description,
        url: r.url
      }
    ],
    components: buttons.length
      ? [
          {
            type: 1,
            components: buttons
          }
        ]
      : []
  };
}

const EPITHET_RANK_COLORS = {
  gold: 0xFFD700,
  silver: 0xC0C0C0,
  bronze: 0xCD7F32,
  default: 0x9B59B6
};

/** Single epithet detail embed (rank, conditions, reward). */
export function buildEpithetEmbed(e) {
  const rank = (e.rank || '').toLowerCase();
  const color = EPITHET_RANK_COLORS[rank] ?? EPITHET_RANK_COLORS.default;
  const rankLabel = rank ? capitalize(rank) : '—';
  return {
    embeds: [
      {
        title: e.id || 'Epithet',
        color,
        fields: [
          { name: 'Rank', value: rankLabel, inline: true },
          { name: 'Conditions', value: e.conditions || '—', inline: false },
          { name: 'Reward', value: e.reward || '—', inline: false }
        ]
      }
    ]
  };
}

const EPITHET_LIST_PAGE_SIZE = 10;
const EPITHET_PAGINATION_ID_PREFIX = 'epithet_p_';
const EPITHET_PAGINATION_QUERY_MAX = 80;

/** Build list embed + pagination buttons for epithets. query encoded in custom_id (max 80 chars). */
export function buildEpithetListPayload(matches, page, query) {
  const totalPages = Math.max(1, Math.ceil(matches.length / EPITHET_LIST_PAGE_SIZE));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const start = safePage * EPITHET_LIST_PAGE_SIZE;
  const slice = matches.slice(start, start + EPITHET_LIST_PAGE_SIZE);
  const queryEnc = query ? String(query).slice(0, EPITHET_PAGINATION_QUERY_MAX) : '';
  const prefix = `${EPITHET_PAGINATION_ID_PREFIX}${safePage}_${queryEnc}`;

  const description = slice
    .map((e, i) => {
      //const cond = (e.conditions || '—').length > 80 ? (e.conditions || '—').slice(0, 77) + '…' : (e.conditions || '—');
      //const rew = (e.reward || '—').length > 60 ? (e.reward || '—').slice(0, 57) + '…' : (e.reward || '—');
      const cond = e.conditions || '—';
      const rew = e.reward || '—';
      return `**${e.id}** ${cond}\n Reward: ${rew}`;
    })
    .join('\n\n');

  const title = query ? `Epithets matching "${query}"` : 'All epithets';
  const embed = {
    title,
    description: description || 'No epithets on this page.',
    color: 0x9B59B6,
    footer: { text: `Page ${safePage + 1} of ${totalPages} • ${matches.length} epithet(s)` }
  };

  const prevId = `${EPITHET_PAGINATION_ID_PREFIX}${safePage - 1}_${queryEnc}`;
  const nextId = `${EPITHET_PAGINATION_ID_PREFIX}${safePage + 1}_${queryEnc}`;
  const components = [
    {
      type: 1,
      components: [
        { type: 2, style: 2, custom_id: prevId, label: 'Previous', disabled: safePage <= 0 },
        { type: 2, style: 2, custom_id: nextId, label: 'Next', disabled: safePage >= totalPages - 1 }
      ]
    }
  ];

  return { embeds: [embed], components };
}

export { EPITHET_PAGINATION_ID_PREFIX, EPITHET_LIST_PAGE_SIZE };

