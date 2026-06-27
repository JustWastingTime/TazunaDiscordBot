import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const characters = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/character.json'), 'utf8'));
const skills = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/skill.json'), 'utf8'));

const STOP_WORDS = new Set([
    'a', 'an', 'the', 'is', 'for', 'in', 'its', 'to', 'of', 'and', 'me', 'my', 'this', 'from',
    'be', 'with', 'there', 'where', 'one', 'on', 'go', 'it', 's', 'i', 'we', 'you', 'that',
]);

const THEME_KEYWORDS = {
    victory: ['victory', 'win', 'vittoria', 'cheer', 'triumph', 'champion', 'possible'],
    star: ['star', 'stellar', 'shooting', 'sparkly', 'stardom', 'dioskouroi'],
    rose: ['rose', 'fang', 'thorn', 'closer'],
    festive: ['festive', 'miracle', 'harvest', 'mummy', '114th', 'cacao', 'present', 'bountiful'],
    pride: ['pride', 'king', 'halo', 'emperor', 'divine', 'dignity', 'legacy', 'resplendent'],
    speed: ['speed', 'lightning', 'flash', 'full', 'bakushin', 'shift', 'cruisin'],
    dance: ['dance', 'vaudeville', 'barcarole', 'dazzl', 'flowery', 'maneuver', 'peerless'],
    teio: ['teio'],
    dark: ['shadow', 'nemesis', 'break', 'schwarzes'],
    cute: ['hug', 'pure', 'heart', 'budding', 'blossom', 'fairy', 'lovely', 'spring'],
    technical: ['trigger', 'q.e.d', 'keep', 'real', 'g00', 'beat', 'lookat', 'u=ma', 'schwarzes', 'never goof'],
    lead: ['lead', 'view', 'ahead', 'front', 'leadership'],
    recovery: ['heal', 'encompassing', 'superior', 'ambition', 'sakura'],
    food: ['guten', 'appetit', 'cacao', 'operation'],
    ocean: ['anchor', 'voyage', 'joyful', 'condor'],
    iron: ['iron', 'pump'],
    ticket: ['ticket'],
};

const CHARACTER_VIBES = {
    'Admire Vega': ['star', 'victory', 'lead'],
    'Agnes Digital': ['speed', 'victory', 'technical'],
    'Agnes Tachyon': ['technical', 'speed'],
    'Air Groove': ['pride', 'dance'],
    'Air Shakur': ['technical', 'dark'],
    'Biwa Hayahide': ['technical', 'festive', 'victory'],
    'Curren Chan': ['dance', 'cute', 'technical'],
    'Daiwa Scarlet': ['pride', 'speed', 'victory'],
    'Eishin Flash': ['dark', 'food', 'technical'],
    'El Condor Pasa': ['ocean', 'victory', 'star'],
    'Fine Motion': ['cute', 'dance', 'fairy'],
    'Fuji Kiseki': ['dance', 'star', 'festive'],
    'Gold City': ['technical', 'speed', 'dance'],
    'Gold Ship': ['ocean', 'dark', 'cute'],
    'Grass Wonder': ['recovery', 'lead', 'cute'],
    'Haru Urara': ['cute', 'festive', 'victory'],
    'Hishi Akebono': ['cute', 'speed', 'festive'],
    'Hishi Amazon': ['victory', 'dark', 'speed'],
    'Inari One': ['festive', 'speed', 'cute'],
    'Ines Fujin': ['speed', 'victory', 'cute'],
    'Kawakami Princess': ['pride', 'cute', 'victory'],
    'King Halo': ['pride', 'victory'],
    'Kitasan Black': ['victory', 'cute', 'festive'],
    'Maruzensky': ['speed', 'star', 'festive'],
    'Matikanefukukitaru': ['victory', 'festive', 'cute'],
    'Matikanetannhauser': ['victory', 'cute', 'speed'],
    'Mayano Top Gun': ['speed', 'cute', 'festive'],
    'Meisho Doto': ['cute', 'festive', 'victory'],
    'Mejiro Ardan': ['dance', 'festive', 'cute'],
    'Mejiro Dober': ['lead', 'recovery', 'cute'],
    'Mejiro McQueen': ['pride', 'dance', 'recovery'],
    'Mejiro Palmer': ['speed', 'cute', 'festive'],
    'Mejiro Ryan': ['iron', 'pride', 'speed'],
    'Mihono Bourbon': ['technical', 'speed', 'festive'],
    'Narita Brian': ['dark', 'speed', 'festive'],
    'Narita Taishin': ['dark', 'cute', 'speed'],
    'Nice Nature': ['cute', 'lead', 'recovery'],
    'Nishino Flower': ['cute', 'festive', 'recovery'],
    'Oguri Cap': ['recovery', 'festive', 'star'],
    'Rice Shower': ['rose', 'dark', 'cute'],
    'Sakura Bakushin O': ['speed', 'victory'],
    'Sakura Chiyono O': ['recovery', 'cute', 'festive'],
    'Seiun Sky': ['dark', 'food', 'cute'],
    'Smart Falcon': ['star', 'cute', 'victory'],
    'Special Week': ['star', 'dance', 'victory'],
    'Super Creek': ['cute', 'recovery', 'festive'],
    'Sweep Tosho': ['victory', 'star', 'festive'],
    'Symboli Rudolf': ['pride', 'victory', 'dark'],
    'T.M. Opera O': ['dance', 'pride', 'victory'],
    'Taiki Shuttle': ['victory', 'speed', 'dance'],
    'Tokai Teio': ['teio', 'victory', 'speed'],
    'Tosen Jordan': ['cute', 'dance', 'victory'],
    'Winning Ticket': ['ticket', 'victory', 'festive'],
    'Yaeno Muteki': ['dance', 'pride', 'festive'],
};

const COSTUME_THEMES = {
    Halloween: ['festive', 'rose', 'dark', 'cute'],
    Wedding: ['dance', 'cute', 'pride', 'victory'],
    Valentines: ['cute', 'food', 'dance'],
    Valentine: ['cute', 'food', 'dance'],
    Christmas: ['festive', 'victory', 'cute'],
    'New Year': ['festive', 'victory', 'cute'],
    Summer: ['dance', 'ocean', 'cute', 'speed'],
    Festival: ['festive', 'dance', 'speed'],
    Fantasy: ['dark', 'pride', 'recovery', 'star'],
    Ballroom: ['dance', 'pride', 'cute'],
    Cheerleader: ['victory', 'cute', 'iron'],
    Camping: ['recovery', 'lead', 'cute'],
    'Anime Collab': ['victory', 'recovery', 'pride'],
    'Full Armor': ['festive', 'victory', 'technical'],
};

function cardSubject(card) {
    return `${card.character_name} (${card.type})`;
}

function tokenizeName(name) {
    return name
        .toLowerCase()
        .replace(/[^\w\s'☆♪♡∞]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function getThemes(name) {
    const lower = name.toLowerCase();
    const themes = new Set();
    for (const [theme, words] of Object.entries(THEME_KEYWORDS)) {
        if (words.some((w) => lower.includes(w))) themes.add(theme);
    }
    return themes;
}

function aptitudeVector(card) {
    const [surface, distance, style] = card.aptitudes;
    const grades = { S: 8, A: 7, B: 6, C: 5, D: 4, E: 3, F: 2, G: 1 };
    const toNum = (g) => grades[g] ?? 0;
    return {
        turf: toNum(surface.Turf),
        dirt: toNum(surface.Dirt),
        sprint: toNum(distance.Sprint),
        mile: toNum(distance.Mile),
        medium: toNum(distance.Medium),
        long: toNum(distance.Long),
        front: toNum(style.Front),
        pace: toNum(style.Pace),
        late: toNum(style.Late),
        end: toNum(style.End),
    };
}

function aptitudeSimilarity(a, b) {
    const keys = Object.keys(a);
    let sum = 0;
    for (const k of keys) sum += 8 - Math.abs(a[k] - b[k]);
    return sum;
}

function dominantStyle(vec) {
    const styles = ['front', 'pace', 'late', 'end'];
    return styles.reduce((best, s) => (vec[s] > vec[best] ? s : best), 'front');
}

function nameFormatScore(correct, candidate) {
    let score = 0;
    const patterns = [
        [/☆/g, 8],
        [/♪/g, 8],
        [/♡/g, 6],
        [/[∞]/g, 10],
        [/[''']/g, 5],
        [/[:#]/g, 6],
        [/[（(]/g, 4],
    ];
    for (const [re, pts] of patterns) {
        const cHas = re.test(correct);
        const dHas = re.test(candidate);
        if (cHas && dHas) score += pts;
        else if (cHas !== dHas) score -= 2;
        re.lastIndex = 0;
    }
    const lenRatio = Math.min(correct.length, candidate.length) / Math.max(correct.length, candidate.length);
    if (lenRatio > 0.55) score += Math.round(lenRatio * 8);
    return score;
}

function sharedTokenScore(correct, candidate) {
    const a = new Set(tokenizeName(correct));
    const b = new Set(tokenizeName(candidate));
    let shared = 0;
    for (const t of a) if (b.has(t)) shared += 12;
    return shared;
}

function themeOverlapScore(correctThemes, candidateThemes, cardThemes) {
    let score = 0;
    for (const t of correctThemes) if (candidateThemes.has(t)) score += 18;
    for (const t of cardThemes) if (candidateThemes.has(t)) score += 10;
    return score;
}

const skillMeta = new Map();
for (const s of skills) {
    if (s.rarity === 'unique') {
        skillMeta.set(s.skill_name, {
            category: s.category,
            horse: s.horse || '',
            description: (s.description || '').toLowerCase(),
        });
    }
}

const cards = characters.map((c) => ({
    ...c,
    subject: cardSubject(c),
    aptitude: aptitudeVector(c),
    dominantStyle: null,
}));
for (const c of cards) c.dominantStyle = dominantStyle(c.aptitude);

const subjectToCard = new Map(cards.map((c) => [c.subject, c]));
const uniqueByCard = new Map(cards.map((c) => [c.subject, c.unique]));

function scoreDistractor(sourceCard, correctSkill, candidateSkill, candidateCard) {
    if (candidateSkill === correctSkill) return -Infinity;

    let score = 0;
    const correctMeta = skillMeta.get(correctSkill) || {};
    const candidateMeta = skillMeta.get(candidateSkill) || {};

    if (candidateCard.character_name === sourceCard.character_name && candidateCard.subject !== sourceCard.subject) {
        score += 70;
    }

    if (correctMeta.category && candidateMeta.category === correctMeta.category) {
        score += 40;
    }

    if (candidateMeta.horse && candidateMeta.horse.includes(sourceCard.character_name.split(' ')[0])) {
        score += 15;
    }

    const correctThemes = getThemes(correctSkill);
    const candidateThemes = getThemes(candidateSkill);
    const costumeThemes = (COSTUME_THEMES[sourceCard.type] || []).reduce((set, t) => set.add(t), new Set());
    score += themeOverlapScore(correctThemes, candidateThemes, costumeThemes);

    score += sharedTokenScore(correctSkill, candidateSkill);
    score += nameFormatScore(correctSkill, candidateSkill);
    score += aptitudeSimilarity(sourceCard.aptitude, candidateCard.aptitude) * 0.9;

    if (sourceCard.dominantStyle === candidateCard.dominantStyle) score += 12;

    const sourceDist = Math.max(sourceCard.aptitude.medium, sourceCard.aptitude.long, sourceCard.aptitude.mile, sourceCard.aptitude.sprint);
    const candDist = Math.max(candidateCard.aptitude.medium, candidateCard.aptitude.long, candidateCard.aptitude.mile, candidateCard.aptitude.sprint);
    if (Math.abs(sourceDist - candDist) <= 1) score += 8;

    if (sourceCard.type !== 'Original' && candidateCard.type === sourceCard.type) score += 22;

    const sourceVibes = CHARACTER_VIBES[sourceCard.character_name] || [];
    for (const vibe of sourceVibes) {
        if (candidateThemes.has(vibe)) score += 16;
    }
    if (sourceVibes.includes('technical')) {
        if (candidateThemes.has('technical')) score += 22;
        if (candidateThemes.has('cute')) score -= 18;
    }
    if (sourceCard.character_name.startsWith('Mejiro ') && candidateCard.character_name.startsWith('Mejiro ')) {
        score += 14;
    }

    if (correctMeta.description && candidateMeta.description) {
        const cd = new Set(tokenizeName(correctMeta.description));
        const dd = new Set(tokenizeName(candidateMeta.description));
        for (const t of cd) if (dd.has(t)) score += 4;
    }

    score += (hashString(`${sourceCard.subject}:${candidateSkill}`) % 7) * 0.3;

    return score;
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

function pickDistractors(sourceCard, correctSkill, count = 5) {
    const scored = [];
    for (const candidateCard of cards) {
        const candidateSkill = candidateCard.unique;
        const score = scoreDistractor(sourceCard, correctSkill, candidateSkill, candidateCard);
        if (score > -Infinity) {
            scored.push({ skill: candidateSkill, score, card: candidateCard });
        }
    }
    scored.sort((a, b) => b.score - a.score);

    const picked = [];
    const pickedSkills = new Set([correctSkill]);
    const pickedCards = new Set();

    const sibling = scored.filter(
        (s) => s.card.character_name === sourceCard.character_name && s.card.subject !== sourceCard.subject
    );
    if (sibling[0] && !pickedSkills.has(sibling[0].skill)) {
        picked.push(sibling[0].skill);
        pickedSkills.add(sibling[0].skill);
        pickedCards.add(sibling[0].card.subject);
    }

    const correctMeta = skillMeta.get(correctSkill) || {};
    if (correctMeta.category) {
        const sameCategory = scored.find(
            (s) => !pickedSkills.has(s.skill) && (skillMeta.get(s.skill) || {}).category === correctMeta.category
        );
        if (sameCategory) {
            picked.push(sameCategory.skill);
            pickedSkills.add(sameCategory.skill);
            pickedCards.add(sameCategory.card.subject);
        }
    }

    for (const item of scored) {
        if (picked.length >= count) break;
        if (pickedSkills.has(item.skill)) continue;
        if (pickedCards.has(item.card.subject) && picked.length >= 2) continue;
        picked.push(item.skill);
        pickedSkills.add(item.skill);
        pickedCards.add(item.card.subject);
    }

    if (picked.length < count) {
        for (const item of scored) {
            if (picked.length >= count) break;
            if (pickedSkills.has(item.skill)) continue;
            picked.push(item.skill);
            pickedSkills.add(item.skill);
        }
    }

    return picked.slice(0, count);
}

const testQuestions = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/quiz/categories/testquestions.json'), 'utf8'));
const group = testQuestions.questions.find((q) => q.promptTemplate === "{0}'s unique skill is called?");

if (!group) {
    console.error('Unique skill group not found');
    process.exit(1);
}

const newEntries = group.entries.map(([subject, answers]) => {
    const card = subjectToCard.get(subject);
    if (!card) {
        console.warn(`Missing card for subject: ${subject}`);
        return [subject, answers];
    }
    const correct = card.unique;
    const wrong = pickDistractors(card, correct, 5);
    return [subject, [correct, ...wrong]];
});

if (process.argv.includes('--write')) {
    const lines = newEntries.map((e, i) => {
        const suffix = i < newEntries.length - 1 ? ',' : '';
        return `          ${JSON.stringify(e)}${suffix}`;
    });
    const filePath = path.join(ROOT, 'assets/quiz/categories/testquestions.json');
    let content = fs.readFileSync(filePath, 'utf8');
    const start = content.indexOf('"entries": [');
    const end = content.indexOf('\n        ]\n    }', start);
    if (start === -1 || end === -1) {
        console.error('Could not locate entries block');
        process.exit(1);
    }
    const before = content.slice(0, start + '"entries": [\n'.length);
    const after = content.slice(end);
    content = `${before}${lines.join('\n')}\n${after}`;
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Updated ${newEntries.length} entries in testquestions.json`);
} else {
    for (const [subject, answers] of newEntries) {
        console.log(JSON.stringify([subject, answers]));
    }
}
