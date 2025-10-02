import characters from '../assets/character.json' with { type: "json" };
import fetch from "node-fetch";
import sharp from 'sharp';

import { 
  buildUmaLatorHash as buildAdvancedUmaLatorHash,
  buildUmaLatorComparisonHash, 
  generateUmalatorLink,
  COURSE_IDS, 
  mapUmaToId
} from './umalator.js';
import { log } from 'console';

const gradeColors = {
  S: { r: 219, g: 189, b: 100 },   // yellow
  A: { r: 239, g: 155, b: 80 },   // orange
  B: { r: 231, g: 172, b: 190 },  // pink
  C: { r: 184, g: 217, b: 171 },  // green
  D: { r: 136, g: 205, b: 255 },  // blue
  E: { r: 236, g: 172, b: 255},  // purple
  F: { r: 173, g: 160, b: 237 },   // dark blue
  G: { r: 193, g: 192, b: 193 }   // grey
};

// -----------
// Helpers
// -----------

// Extract outfit title (handles [Title], [Titlel, [Title, etc.])
function extractTitle(ocrText) {
  if (!ocrText) return null;
  const text = String(ocrText);

  // --- Hardcoded replacements for known OCR quirks ---
  const replacements = {
    "[LOVE#4EVER]": "LOVE☆4EVER"
  };

  for (const [key, val] of Object.entries(replacements)) {
    if (text.includes(key)) {
      return val.toLowerCase(); // or normalize(val) if you want it normalized
    }
  }

  const normalize = s => s
    .toLowerCase()
    .replace(/[\-:|]/g, " ")   // normalize separators
    .replace(/\s+/g, " ")      // collapse multiple spaces
    .trim();

  // 1) Properly bracketed: [Title]
  let m = text.match(/\[([^\]\r\n]{1,200})\]/);
  if (m && m[1]) return normalize(m[1]);

  // 2) Open bracket but no closing ] on that line: "[Title" or "[Titlel"
  m = text.match(/\[([^\]\r\n]{1,200})/);
  if (m && m[1]) {
    let t = m[1].trim();

    // Heuristic cleanup for common OCR misreads of closing bracket:
    // Remove trailing 'l' or 'I' or '|' only if it looks like a stray char
    // (i.e. single trailing char and there is no real ']' anywhere in text)
    if (!text.includes(']')) {
      t = t.replace(/[\|\:]+$/g, "").trim();            // strip trailing pipes/colons
      if (t.length > 2 && /^[a-z]$/i.test(t.slice(-1)) && t.slice(-1).toLowerCase() === 'l') {
        // remove trailing 'l' when likely OCR -> ']'
        t = t.slice(0, -1).trim();
      }
      if (t.length > 2 && /^[iI]$/.test(t.slice(-1))) {
        // sometimes ] -> I
        t = t.slice(0, -1).trim();
      }
    }

    return normalize(t);
  }

  // 3) Fallback: try any [... start (non-greedy) and strip obvious trailing garbage
  m = text.match(/\[([^\]\r\n]+?)(?:\]|\b|$)/);
  if (m && m[1]) {
    let t = m[1].trim().replace(/[\|\:]+$/g, "");
    if (!text.includes(']') && t.length > 2 && t.slice(-1).toLowerCase() === 'l') {
      t = t.slice(0, -1).trim();
    }
    return normalize(t);
  }

  return null;
}

// Extract numbers from OCR text like "A 813" → "813"
function extractNumber(text) {
  if (typeof text !== "string") return "?";
  const match = text.match(/\d+/);
  return match ? match[0] : "?";
}

function normalizeSkillName(name) {
  if (!name) return "";

  const hardcodedFixes = {
    "Victoria por plancha &": "Victoria por plancha ☆",
    "Victoria por plancha #": "Victoria por plancha ☆",
    "Victoria por plancha *": "Victoria por plancha ☆",
    "G00 1st. Foo;": "G00 1st. F∞;",
    "G0O 1st. Foo;": "G00 1st. F∞;",
    "GO0 1st. Foo;": "G00 1st. F∞;",
    "..win Q.E.D.": "∴win Q.E.D.",
    "Flashy*Landing": "Flashy☆Landing",
    "Flashy&Landing": "Flashy☆Landing",
    "Flowery*Maneuver": "Flowery☆Maneuver",
    "Flowery&Maneuver": "Flowery☆Maneuver",
    "Flowery#Maneuver": "Flowery☆Maneuver",
    "SPARKLY*STARDOM": "SPARKLY☆STARDOM",
    "SPARKLY&STARDOM": "SPARKLY☆STARDOM",
    "SPARKLY#STARDOM": "SPARKLY☆STARDOM",
  };

  if (hardcodedFixes[name]) return hardcodedFixes[name];

  let clean = name
    // Normalize OCR mistakes for "Lv1"
    .replace(/LvI\b/gi, "Lv1")
    .replace(/Lvi\b/gi, "Lv1")
    .replace(/Lvll?\b/gi, "Lv1")

    // Remove any level indicators
    .replace(/Lvl?\s*[0-9IVX]+/gi, "")   // Lv1, Lvl3, LvX, LvII
    .replace(/\|\s*\d+\s*Skills?/gi, "") // "| 3 Skills"
    .replace(/\s*\d+\s*$/, "")           // trailing numbers 
    .trim();

  // Fix suffix symbols
  clean = clean
    .replace(/©/g, "◎") // OCR often reads ◎ as copyright symbol
    .replace(/(O|0)$/g, "○") // trailing O or 0 → ○
    .replace(/x$/i, "×")  // trailing x or X → ×

  return clean || null

}


// Resize once, return buffer + metadata
async function resizeImage(imageUrl, targetWidth = 592) {
  const res = await fetch(imageUrl);
  const buffer = Buffer.from(await res.arrayBuffer());

  const base = sharp(buffer).resize({ width: targetWidth });

  // Clone for OCR-safe PNG
  const { data, info } = await base.clone().raw().toBuffer({ resolveWithObject: true });
  const ocrBuffer = await base.clone().png().toBuffer();

  return {
    rawData: data,
    info,
    ocrBuffer
  };
}

// safe pixel read + bounds checks
function getPixelColor(rawData, info, x, y) {
  if (!info || typeof info.width !== 'number' || typeof info.height !== 'number') {
    console.error('getPixelColor: invalid image info', info);
    return { r: 193, g: 192, b: 193 };
  }
  if (!rawData || !(rawData instanceof Buffer || rawData instanceof Uint8Array)) {
    console.error('getPixelColor: invalid rawData', typeof rawData, rawData && rawData.length);
    return { r: 193, g: 192, b: 193 };
  }

  x = Math.round(x); y = Math.round(y);
  if (x < 0) x = 0;
  if (y < 0) y = 0;
  if (x >= info.width) x = info.width - 1;
  if (y >= info.height) y = info.height - 1;

  const channels = info.channels || 3;
  const idx = (y * info.width + x) * channels;
  if (idx + 2 >= rawData.length) {
    console.error('getPixelColor: index out of bounds', { idx, len: rawData.length, width: info.width, height: info.height });
    return { r: 193, g: 192, b: 193 };
  }

  return { r: rawData[idx], g: rawData[idx + 1], b: rawData[idx + 2] };
}

// returns { grade, dist } for a single pixel
function gradeForPixel(pixel) {
  let best = "?";
  let bestDist = Infinity;
  let second = null;

  for (const [grade, ref] of Object.entries(gradeColors)) {
    const dr = pixel.r - ref.r;
    const dg = pixel.g - ref.g;
    const db = pixel.b - ref.b;
    const dist = dr * dr + dg * dg + db * db; // squared euclidean
     if (dist < bestDist) {
      second = { grade: best, dist: bestDist };
      bestDist = dist;
      best = grade;
    }
  }

  // --- Preference rules ---
  // A vs S: prefer S if close
  if (best === "A" && second?.grade === "S" && Math.abs(bestDist - second.dist) < 2000) {
    return { grade: "S", dist: second.dist };
  }


  // F vs E: prefer E if close
  if (best === "F" && second?.grade === "E" && Math.abs(bestDist - second.dist) < 1500) {
    return { grade: "E", dist: second.dist };
  }

  // G vs F: prefer F if close
  if (best === "G" && second?.grade === "F" && Math.abs(bestDist - second.dist) < 1500) {
    return { grade: "F", dist: second.dist };
  }

  return { grade: best, dist: bestDist };
}

// given an array of pixels -> pick final grade using majority + distance tie-break
function gradeFromSamples(pixels) {
  if (!pixels || pixels.length === 0) return "G";
  const votes = {}; // grade -> {count, sumDist}
  for (const p of pixels) {
    const info = gradeForPixel(p);
    if (!votes[info.grade]) votes[info.grade] = { count: 0, sumDist: 0 };
    votes[info.grade].count++;
    votes[info.grade].sumDist += info.dist;
  }

  // find winner by count, tie-break by smaller avg dist
  let winner = "G";
  let bestCount = -1;
  let bestAvgDist = Infinity;
  for (const [g, stat] of Object.entries(votes)) {
    const avg = stat.sumDist / stat.count;
    if (stat.count > bestCount || (stat.count === bestCount && avg < bestAvgDist)) {
      bestCount = stat.count;
      bestAvgDist = avg;
      winner = g;
    }
  }
  return winner;
}

// average RGB of pixel list (useful to return a single pixel-like object)
function averagePixel(pixels) {
  if (!pixels || pixels.length === 0) return { r: 193, g: 192, b: 193 };
  let r=0,g=0,b=0;
  for (const p of pixels) { r += p.r; g += p.g; b += p.b; }
  const n = pixels.length;
  return { r: Math.round(r/n), g: Math.round(g/n), b: Math.round(b/n) };
}

// sample a small rectangle area and return filtered pixels
function sampleArea(rawData, info, startX, startY, w, h, stepX = 1, stepY = 1) {
  const out = [];
  for (let dx = 0; dx < w; dx += stepX) {
    for (let dy = -Math.floor(h/2); dy <= Math.floor(h/2); dy += stepY) {
      const x = Math.round(startX + dx);
      const y = Math.round(startY + dy);
      const pix = getPixelColor(rawData, info, x, y);
      // filter near-white / tiny variance (likely background)
      const intensity = (pix.r + pix.g + pix.b) / 3;
      const variance = Math.max(pix.r, pix.g, pix.b) - Math.min(pix.r, pix.g, pix.b);
      if (intensity > 245) continue;         // skip white-ish
      if (variance < 8) continue;            // skip nearly-grey pixels
      out.push(pix);
    }
  }
  return out;
}

// Convert pixel RGB → closest grade with tolerance
function detectGrade(pixel) {
  let bestGrade = "G";
  let bestDist = Infinity;

  for (const [grade, ref] of Object.entries(gradeColors)) {
    const dr = pixel.r - ref.r;
    const dg = pixel.g - ref.g;
    const db = pixel.b - ref.b;
    const dist = dr * dr + dg * dg + db * db; // squared distance

    if (dist < bestDist) {
      bestDist = dist;
      bestGrade = grade;
    }
  }

  // Threshold: anything too far = Grey
  if (bestDist > 3000) {
    return "G";
  }

  return bestGrade;
}

// Compare pixel color to the closest grade
function getGradeFromColor(pixel) {
  if (!pixel || typeof pixel.r !== 'number') return "?";
  // reuse gradeForPixel logic
  const { grade } = gradeForPixel(pixel);
  return grade;
}

// samples multiple pixels to the right of the word and returns an averaged pixel
async function getLetterColorNextToWord(ocrLines, rawData, info, targetWord, offsetX = 33) {
  if (!Array.isArray(ocrLines)) {
    console.warn('getLetterColorNextToWord: missing ocrLines');
    return { avg: { r:193, g:192, b:193 }, votedGrade: "G" };
  }

  const line = ocrLines.find(l => l.LineText && l.LineText.toLowerCase().includes(targetWord.toLowerCase()));
  if (!line) {
    console.warn('getLetterColorNextToWord: line not found for', targetWord);
    return { avg: { r:193, g:192, b:193 }, votedGrade: "G" };
  }

  let word = (line.Words || []).find(w => w.WordText && w.WordText.toLowerCase() === targetWord.toLowerCase());
  if (!word) word = (line.Words || []).find(w => w.WordText && w.WordText.toLowerCase().includes(targetWord.toLowerCase()));
  if (!word) {
    console.warn('getLetterColorNextToWord: no word boxes for', targetWord, line);
    return { avg: { r:193, g:192, b:193 }, votedGrade: "G" };
  }

  const left   = Number(word.Left);
  const width  = Number(word.Width);
  const top    = Number(word.Top);
  const height = Number(word.Height);

  // ✅ Use center of word box instead of right edge
  const centerX = left + Math.floor(width / 2);
  const centerY = top + Math.floor(height / 2);

  const widthBox  = 18;
  const heightBox = 9;
  const startX    = centerX + (Number(offsetX) || 0); // shift relative to center
  const startY    = centerY;

  const maxSamples = 25;
  const sx = Math.max(1, Math.floor(widthBox / Math.sqrt(maxSamples)));
  const sy = Math.max(1, Math.floor(heightBox / Math.sqrt(maxSamples)));

  const samples = sampleArea(rawData, info, startX, startY, widthBox, heightBox, sx, sy);

  if (samples.length === 0) {
    const fallback = getPixelColor(rawData, info, startX, centerY);
    const grade = detectGrade(fallback);
    return { avg: fallback, votedGrade: grade };
  }

  const avg = averagePixel(samples);
  const votedGrade = gradeFromSamples(samples);

  return { avg, votedGrade };
}
// --- group parser that uses votedGrade first ---
async function parseGroup(defs, ocrLines, rawData, info) {
  const result = {};
  for (const [word, offset] of defs) {
    const { avg, votedGrade } = await getLetterColorNextToWord(ocrLines, rawData, info, word, offset);
    // prefer votedGrade, but if it's null, fallback to detectGrade(avg)
    result[word] = votedGrade || detectGrade(avg);
  }
  return result;
}

/**
 * Shorten a URL using TinyURL (no API token needed)
 * @param {string} longUrl - The original long URL
 * @returns {Promise<string>} - Shortened URL
 */
export async function shortenUrl(longUrl) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(longUrl)}`);
    const shortUrl = await res.text();
    return shortUrl;
  } catch (err) {
    console.error("Error shortening URL:", err);
    return longUrl; // fallback
  }
}

// -----------
// Main
// -----------

// Resolve character by title or fallback to name
function resolveUma(ocrText) { 
  const title = extractTitle(ocrText);

  // Match by exact costume name
  const byCostume = characters.find(uma =>
    uma.costume && ocrText.toLowerCase().includes(uma.costume.toLowerCase())
  );
  if (byCostume) {
    return { ...byCostume, title: byCostume.costume };
  }

  // Fallback: match by base name in OCR text
  const byName = characters.find(uma =>
    uma.character_name && ocrText.toLowerCase().includes(uma.character_name.toLowerCase())
  );

  if (byName) {
    return { ...byName, title: null };
  }

  return { title: null, name: "Unknown", id: null };
}

// Parse OCR text into structured Uma profile
function parseStats(lines) {
  const header = lines.find(line =>
    line.toLowerCase().includes("speed")
  );
  if (!header) return { Speed: "?", Stamina: "?", Power: "?", Guts: "?", Wit: "?" };

  const nextLine = lines[lines.indexOf(header) + 1] || "";
  const nums = (nextLine.match(/(?<!\/)\d+/g) || []).slice(0, 5);
  if (nums.length !== 5) return { Speed: "?", Stamina: "?", Power: "?", Guts: "?", Wit: "?" };

  return {
    Speed: nums[0],
    Stamina: nums[1],
    Power: nums[2],
    Guts: nums[3],
    Wit: nums[4]
  };
}

// Parse grades (S–G) using OCR overlay + pixel color
async function parseAptitudes(ocrLines, rawData, info) {
  const aptDefs = {
    track:    [["Turf"], ["Dirt"]],
    distance: [["Sprint"], ["Mile"], ["Medium"], ["Long"]],
    style:    [["Front"], ["Pace"], ["Late" ], ["End"]]
  };

  return {
    track:    await parseGroup(aptDefs.track, ocrLines, rawData, info),
    distance: await parseGroup(aptDefs.distance, ocrLines, rawData, info),
    style:    await parseGroup(aptDefs.style, ocrLines, rawData, info)
  };
}

// Parse skill list from OCR lines
function parseSkills(lines) {
  const skills = [];
  const idx = lines.findIndex(line => line.toLowerCase().includes("skills"));
  if (idx === -1) return skills;

  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || /career info/i.test(line)) break;

    // Remove "Lvl X" and split by tabs
    const parts = line
      .split("\t")
      .map(s => s.replace(/Lvl\s*\d+/i, "").trim())
      .filter(Boolean)
      .map(normalizeSkillName);

    skills.push(...parts);
  }

  return skills;
}

function mergeSplitSkills(skills) {
  const combos = [
    { cur: "Front Runner", pattern: /^Straightaways [○◎×]?$/ },
    { cur: "Pace Chaser", pattern: /^Straightaways [○◎×]?$/ },
    { cur: "Late Surger", pattern: /^Straightaways [○◎×]?$/ },
    { cur: "End Closer", pattern: /^Straightaways [○◎×]?$/ },
    { cur: "Medium", pattern: /^Straightaways [○◎×]?$/ },
    { cur: "Outer Post", pattern: /^Proficiency [○◎×]?$/ },
    { cur: "Inner Post", pattern: /^Proficiency [○◎×]?$/ },
    { cur: "Behold Thine Emperor's", exact: "Divine Might" },
    { cur: "Where There's a Will,", exact: "There's a Way" },
    { cur: "This Dance Is for", exact: "Vittoria!" },
    { cur: "Straightaway", exact: "Acceleration" },
    { cur: "I Can See Right", exact: "Through You" },
    { cur: "The View from the Lead", exact: "Is Mine!" },
    { cur: "The Duty of Dignity", exact: "Calls" },
    { cur: "Non-Standard", exact: "Distance" },
    { cur: "You and Me!", exact: "One-on-One!" },
    { cur: "Introduction to", exact: "Physiology" },
    { cur: "Genius x Bakushin =", exact: "Victory" }
  ];

  function matchesCombo(base, other) {
    if (!base || !other) return false;
    for (const combo of combos) {
      if (combo.cur === base) {
        if (combo.exact) {
          if (combo.exact === other) return true;
        } else if (combo.pattern) {
          if (combo.pattern.test(other)) return true;
        }
      }
    }
    return false;
  }

  const merged = [];
  let i = 0;
  while (i < skills.length) {
    const cur = skills[i];
    const next = skills[i + 1] || "";
    const next2 = skills[i + 2] || "";
    const next3 = skills[i + 3] || "";

    // 1) cur + next
    if (matchesCombo(cur, next)) {
      merged.push(`${cur} ${next}`);
      i += 2;
      continue;
    }

    // 2) interleaved case: cur + next2 AND next + next3
    if (matchesCombo(cur, next2) && matchesCombo(next, next3)) {
      merged.push(`${cur} ${next2}`);
      merged.push(`${next} ${next3}`);
      i += 4; // consumed cur, next, next2, next3
      continue;
    }

    // 3) cur + next2 (no matching pair for next)
    if (matchesCombo(cur, next2)) {
      // push merged cur+next2 then keep next as its own entry
      merged.push(`${cur} ${next2}`);
      if (next) merged.push(next);
      i += 3; // consumed cur, next, next2
      continue;
    }

    // 4) next + next2 (cur stands alone)
    if (matchesCombo(next, next2)) {
      merged.push(cur);
      merged.push(`${next} ${next2}`);
      i += 3; // consumed cur, next, next2
      continue;
    }

    // 5) nothing matched — push cur
    merged.push(cur);
    i += 1;
  }

  return merged;
}

export async function parseUmaProfile(ocrText, ocrLines, imageUrl, rawData, info) {
  console.log(ocrText);
  const umaInfo = resolveUma(ocrText);
  const lines = ocrText.split("\n");

  const stats = parseStats(lines);
  const { track, distance, style } = await parseAptitudes(ocrLines, rawData, info);
  const skills = mergeSplitSkills(parseSkills(lines));

  const parsed = {
    name: umaInfo.character_name || umaInfo.name,
    title: umaInfo.title,
    type: umaInfo.type,
    stats,
    track,
    distance,
    style,
    skills,
    thumbnail: umaInfo.thumbnail
  };

  return await mapUmaToId(parsed);
}
// OCR.space call
export async function parseWithOcrSpace(imageUrl) {
    const apiKey = process.env.OCR_SPACE_KEY;
    
    // Step 1: fetch image
    const { rawData, info, ocrBuffer } = await resizeImage(imageUrl);

    // Step 2: send image
    const formData = new URLSearchParams();
    formData.append("base64Image", `data:image/png;base64,${ocrBuffer.toString("base64")}`);
    formData.append("language", "eng");
    formData.append("isOverlayRequired", "true"); // bounding boxes for future color detection   
    formData.append("isTable", "true");
    formData.append("OCREngine", "2"); // Engine 2

  const response = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    body: formData
  });

  const result = await response.json();
  if (result.IsErroredOnProcessing) throw new Error(result.ErrorMessage || "OCR.space failed");

  const parsedResult = result.ParsedResults?.[0];
  return {
    text: parsedResult?.ParsedText?.trim() || "",
    overlayLines: parsedResult?.TextOverlay?.Lines || [],
    rawData,
    info
  };
}   

export function buildUmaParsedEmbed(parsed) {
  return {
    title: `${parsed.name} (${parsed.type || "Unknown"})`,
    description: `**Stats**\nSpeed: ${parsed.stats.Speed} | Stamina: ${parsed.stats.Stamina} | Power: ${parsed.stats.Power} | Guts: ${parsed.stats.Guts} | Wit: ${parsed.stats.Wit}`,
    fields: [
      {
        name: "Track",
        value: `Turf: ${parsed.track.Turf} | Dirt: ${parsed.track.Dirt}`,
        inline: true
      },
      {
        name: "Distance",
        value: `Sprint: ${parsed.distance.Sprint} | Mile: ${parsed.distance.Mile} | Medium: ${parsed.distance.Medium} | Long: ${parsed.distance.Long}`,
        inline: true
      },
      {
        name: "Style",
        value: `Front: ${parsed.style.Front} | Pace: ${parsed.style.Pace} | Late: ${parsed.style.Late} | End: ${parsed.style.End}`,
        inline: true
      },
      {
        name: "Skills",
        value: parsed.skills?.length ? parsed.skills.join("\n") : "None"
      }
    ],
    url: parsed.url || null,
    thumbnail: parsed.thumbnail ? { url: parsed.thumbnail } : undefined,
    color: 0x00AE86
  };
}

export function generateUmaLatorLink(parsedUma, raceOptions = {}) {
  // Use default race conditions if none provided
  const defaultOptions = {
    courseId: COURSE_IDS["Tokyo_Turf_1600"] || 10606,
    ground: "Good",
    weather: "Sunny", 
    season: "Spring",
    surface: "Turf"
  };
  
  const finalOptions = { ...defaultOptions, ...raceOptions };
  return buildAdvancedUmaLatorHash(parsedUma, finalOptions);
}
