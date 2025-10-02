import zlib from "zlib";
import fetch from "node-fetch";

let umaListCache = null;
let skillListCache = null;

async function loadUmalist() {
  if (!umaListCache) {
    const res = await fetch("https://raw.githubusercontent.com/alpha123/uma-tools/refs/heads/master/umalator-global/umas.json");
    if (!res.ok) throw new Error(`Failed to fetch umas.json: ${res.status}`);
    umaListCache = await res.json();
  }
  return umaListCache;
}

async function loadSkilllist() {
  if (!skillListCache) {
    const res = await fetch("https://raw.githubusercontent.com/alpha123/uma-tools/refs/heads/master/umalator-global/skillnames.json");
    if (!res.ok) throw new Error(`Failed to fetch skills.json: ${res.status}`);
    skillListCache = await res.json();
  }
  return skillListCache;
}

// Strategy mappings
const STRATEGY_MAP = {
  "Front": "Nige",      // Front Runner
  "Pace": "Senkou",     // Pace Chaser  
  "Late": "Sashi",      // Late Surger
  "End": "Oikomi"       // End Closer
};

// Ground condition mappings
const GROUND_MAP = {
  "Firm": 1,
  "Good": 2, 
  "Soft": 3,
  "Heavy": 4
};

// Weather condition mappings  
const WEATHER_MAP = {
  "Sunny": 1,
  "Cloudy": 2,
  "Rainy": 3,
  "Snowy": 4
};

// Season mappings
const SEASON_MAP = {
  "Spring": 1,
  "Summer": 2,
  "Autumn": 3,
  "Winter": 4
};

// Common course IDs from uma-tools
const COURSE_IDS = {
  // Tokyo
  "Tokyo_Turf_1400": 10504,
  "Tokyo_Turf_1600": 10606,
  "Tokyo_Turf_1800": 10707,
  "Tokyo_Turf_2000": 10809,
  "Tokyo_Turf_2400": 11210,
  "Tokyo_Turf_2500": 11311,
  "Tokyo_Turf_3400": 11915,
  
  // Nakayama
  "Nakayama_Turf_1200": 10101,
  "Nakayama_Turf_1600": 10303,
  "Nakayama_Turf_1800": 10404,
  "Nakayama_Turf_2000": 10505,
  "Nakayama_Turf_2200": 10606,
  "Nakayama_Turf_2500": 10808,
  
  // Add more as needed from course_data.json
};

// Default race settings
const DEFAULT_COURSE_ID = 10606; // Tokyo Turf 1600m
const DEFAULT_NSAMPLES = 500;
const DEFAULT_USE_POS_KEEP = true;
const DEFAULT_RACEDEF = {
  mood: 2,      // Normal mood
  ground: 1,    // Firm
  weather: 1,   // Sunny
  season: 1,    // Spring
  time: 2,      // Day
  grade: 100    // Race grade
};

/**
 * Determines the best strategy based on aptitude grades
 * @param {Object} styleAptitudes - Object with Front, Pace, Late, End grades
 * @returns {string} Internal strategy name (Nige/Senkou/Sashi/Oikomi)
 */
function determineStrategy(styleAptitudes) {
  const gradeRank = { "S": 7, "A": 6, "B": 5, "C": 4, "D": 3, "E": 2, "F": 1, "G": 0 };
  const tiebreakOrder = ["Nige", "Senkou", "Sashi", "Oikomi"];
  
  let bestStrategy = "Senkou"; // Default
  let bestRank = -1;
  
  for (const [displayName, internalName] of Object.entries(STRATEGY_MAP)) {
    const grade = styleAptitudes[displayName] || "G";
    const rank = gradeRank[grade] || 0;
    
    if (rank > bestRank) {
      bestRank = rank;
      bestStrategy = internalName;
    } else if (rank === bestRank) {
      // Tiebreaker: prefer earlier in order
      const currentIdx = tiebreakOrder.indexOf(internalName);
      const bestIdx = tiebreakOrder.indexOf(bestStrategy);
      if (currentIdx < bestIdx) {
        bestStrategy = internalName;
      }
    }
  }
  
  return bestStrategy;
}

/**
 * Determines the best distance aptitude
 * @param {Object} distanceAptitudes - Object with Sprint, Mile, Medium, Long grades
 * @returns {string} Best distance aptitude grade
 */
function getBestDistanceAptitude(distanceAptitudes) {
  const gradeRank = { "S": 7, "A": 6, "B": 5, "C": 4, "D": 3, "E": 2, "F": 1, "G": 0 };
  
  let best = "A"; // Default
  let bestRank = -1;
  
  for (const [distance, grade] of Object.entries(distanceAptitudes)) {
    const rank = gradeRank[grade] || 0;
    if (rank > bestRank) {
      bestRank = rank;
      best = grade;
    }
  }
  
  return best;
}

/**
 * Determines surface aptitude (Turf vs Dirt)
 * @param {Object} trackAptitudes - Object with Turf and Dirt grades
 * @param {string} surface - "Turf" or "Dirt" 
 * @returns {string} Aptitude grade for the surface
 */
function getSurfaceAptitude(trackAptitudes, surface = "Turf") {
  return trackAptitudes[surface] || "A";
}

/**
 * Maps skill names to Umalator skill IDs with unique-skill handling
 * @param {string[]} skillNames - Array of skill names
 * @returns {Promise<string[]>} Array of skill IDs (as strings)
 */
export async function mapSkillsToIds(skillNames = []) {
  if (!skillNames.length) return [];

  const skillList = await loadSkilllist(); 
  // skillList looks like: { "100101": ["SPARKLY☆STARDOM"], "200511": ["Speed Start"], ... }

  // Build a reverse lookup: { "sparkly☆stardom": ["100101"], ... }
  const skillLookup = {};
  for (const [id, names] of Object.entries(skillList)) {
    const arr = Array.isArray(names) ? names : [names];
    for (const n of arr) {
      if (typeof n === "string") {
        const key = n.toLowerCase();
        if (!skillLookup[key]) skillLookup[key] = [];
        skillLookup[key].push(id);
      }
    }
  }

  // Now resolve skills with unique/non-unique preference
  return skillNames.map((skill, idx) => {
    if (!skill) return null;
    const candidates = skillLookup[skill.toLowerCase()] || [];

    if (!candidates.length) {
      console.warn(`[mapSkillsToIds] ❌ Skill not found: "${skill}"`);
      return null;
    }

    if (idx === 0) {
      // First skill → prefer unique (100xxx)
      const unique = candidates.find(id => id.startsWith("100"));
      return unique || candidates[0];
    } else {
      // Other skills → prefer non-unique
      const nonUnique = candidates.find(id => !id.startsWith("100"));
      return nonUnique || candidates[0];
    }
  }).filter(Boolean);
}

/**
 * Maps uma names to uma IDs
 */
export async function mapUmaToId(parsed) {
    console.log("[mapUmaToId] Incoming parsed object:", {
    name: parsed?.name,
    title: parsed?.title,
    skills: parsed?.skills,
    });

    const umaData = await loadUmalist();

    let matchedUmaId = null;
    let matchedUmaInfo = null;
    let matchedOutfitId = null;

    for (const [id, data] of Object.entries(umaData)) {
        const baseName = data.name?.[1]?.toLowerCase();
        const outfits = data.outfits || {};

        // First: check base name
        if (parsed?.name?.toLowerCase() === baseName) {
        matchedUmaId = id;
        matchedUmaInfo = data;

        // Second: check outfit title if present
        if (parsed?.title) {
            const normTitle = `[${parsed.title
            .toLowerCase()
            .replace(/[\-:|]/g, " ")
            .replace(/\s+/g, " ")
            .trim()}]`;

            for (const [outfitId, outfitName] of Object.entries(outfits)) {
            const normOutfit = outfitName
                .toLowerCase()
                .replace(/[\-:|]/g, " ")
                .replace(/\s+/g, " ")
                .trim();

            if (normOutfit === normTitle) {
                matchedOutfitId = outfitId;
                break;
            }
            }
        }

        break;
        }
    }

    if (!matchedUmaId) {
        console.warn("[mapUmaToId] ❌ No match found for:", {
        parsedName: parsed?.name,
        parsedTitle: parsed?.title,
        });
        return { ...parsed, umaId: null, umaOutfitId: null };
    }

    console.log("[mapUmaToId] ✅ Match found:", {
        umaId: matchedUmaId,
        umaName: matchedUmaInfo.name?.[1],
        outfitId: matchedOutfitId,
        outfit: matchedOutfitId ? matchedUmaInfo.outfits[matchedOutfitId] : null,
    });

    return {
        ...parsed,
        umaId: matchedUmaId,
        umaName: matchedUmaInfo.name[1],
        umaOutfitId: matchedOutfitId,
        umaOutfits: matchedUmaInfo.outfits,
    };
}

/**
 * Creates a Horse object for Umalator
 * @param {Object} parsedUma - Your parsed Uma data
 * @param {Object} options - Additional options
 * @returns {Object} Horse object for Umalator payload
 */
async function createHorseObject(parsedUma, options = {}) {
  const strategy = determineStrategy(parsedUma.style);
  const strategyGrade = parsedUma.style[Object.keys(STRATEGY_MAP).find(k => STRATEGY_MAP[k] === strategy)] || "A";
  
  return {
    umaId: parsedUma.umaId || "",
    name: parsedUma.umaName || "",
    outfitId: parsedUma.umaOutfitId   || "",
    speed: parseInt(parsedUma.stats.Speed) || 0,
    stamina: parseInt(parsedUma.stats.Stamina) || 0,
    power: parseInt(parsedUma.stats.Power) || 0,
    guts: parseInt(parsedUma.stats.Guts) || 0,
    wisdom: parseInt(parsedUma.stats.Wit) || 0,
    skills: await mapSkillsToIds(parsedUma.skills),
    strategy: strategy,
    distanceAptitude: getBestDistanceAptitude(parsedUma.distance),
    surfaceAptitude: getSurfaceAptitude(parsedUma.track, options.surface || "Turf"),
    strategyAptitude: strategyGrade
  };
}

/**
 * Builds Umalator URL from one parsed Uma (duplicates for comparison)
 * @param {Object} parsedUma - Your parsed Uma data
 * @param {Object} raceOptions - Race conditions
 * @returns {string} Umalator URL with encoded data
 */
export async function buildUmaLatorHash(parsedUma, raceOptions = {}) {
  const uma1 = await createHorseObject(parsedUma, raceOptions);
  
  // For single Uma testing, duplicate as uma2
  const uma2 = { ...uma1 };
  
  const payload = {
    courseId: raceOptions.courseId || DEFAULT_COURSE_ID,
    nsamples: raceOptions.nsamples || DEFAULT_NSAMPLES,
    usePosKeep: raceOptions.usePosKeep !== undefined ? raceOptions.usePosKeep : DEFAULT_USE_POS_KEEP,
    racedef: {
      mood: raceOptions.mood || DEFAULT_RACEDEF.mood,
      ground: raceOptions.ground || DEFAULT_RACEDEF.ground,
      weather: raceOptions.weather || DEFAULT_RACEDEF.weather,
      season: raceOptions.season || DEFAULT_RACEDEF.season,
      time: raceOptions.time || DEFAULT_RACEDEF.time,
      grade: raceOptions.grade || DEFAULT_RACEDEF.grade
    },
    uma1,
    uma2
  };
  
  // Compress and encode
  const jsonStr = JSON.stringify(payload, null, 0); // No formatting
  const compressed = zlib.gzipSync(jsonStr);
  const base64 = compressed.toString("base64");
  const hash = encodeURIComponent(base64);
  
  return `https://alpha123.github.io/uma-tools/umalator-global/#${hash}`;
}

/**
 * Builds Umalator URL comparing two parsed Umas
 * @param {Object} parsedUma1 - First parsed Uma
 * @param {Object} parsedUma2 - Second parsed Uma  
 * @param {Object} raceOptions - Race conditions
 * @returns {string} Umalator URL with encoded data
 */
export async function buildUmaLatorComparisonHash(parsedUma1, parsedUma2, raceOptions = {}) {
  const uma1 = await createHorseObject(parsedUma1, raceOptions);
  const uma2 = await createHorseObject(parsedUma2, raceOptions);
  
  const payload = {
    courseId: raceOptions.courseId || DEFAULT_COURSE_ID,
    nsamples: raceOptions.nsamples || DEFAULT_NSAMPLES,
    usePosKeep: raceOptions.usePosKeep !== undefined ? raceOptions.usePosKeep : DEFAULT_USE_POS_KEEP,
    racedef: {
      mood: raceOptions.mood || DEFAULT_RACEDEF.mood,
      ground: GROUND_MAP[raceOptions.ground] || DEFAULT_RACEDEF.ground,
      weather: WEATHER_MAP[raceOptions.weather] || DEFAULT_RACEDEF.weather,
      season: SEASON_MAP[raceOptions.season] || DEFAULT_RACEDEF.season,
      time: raceOptions.time || DEFAULT_RACEDEF.time,
      grade: raceOptions.grade || DEFAULT_RACEDEF.grade
    },
    uma1,
    uma2
  };
  
  const jsonStr = JSON.stringify(payload, null, 0);
  const compressed = zlib.gzipSync(jsonStr);
  const base64 = compressed.toString("base64");
  const hash = encodeURIComponent(base64);
  
  return `https://alpha123.github.io/uma-tools/umalator-global/#${hash}`;
}


export async function generateUmalatorLink(parsedData) {
  // Example with custom race conditions
  const raceOptions = {
    courseId: COURSE_IDS["Tokyo_Turf_1600"], // or use a specific course
    ground: "Good",     // Will be mapped to 2
    weather: "Sunny",   // Will be mapped to 1
    season: "Spring",   // Will be mapped to 1
    surface: "Turf"     // For determining surface aptitude
  };
  
  return await buildUmaLatorHash(parsedData, raceOptions);
}

// Export constants for use in other parts of your application
export { COURSE_IDS, GROUND_MAP, WEATHER_MAP, SEASON_MAP, STRATEGY_MAP };