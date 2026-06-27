import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const races = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/races.json'), 'utf8'));

function isVaries(race) {
    return race.distance_meters === 'Varies'
        || race.racetrack === 'Varies'
        || race.distance_type === 'Varies';
}

function formatAnswer(race) {
    return `${race.racetrack} ${race.distance_meters}`;
}

function parseAnswer(answer) {
    const match = answer.match(/^(.+?) (\d+)m$/);
    return { track: match[1], distance: Number(match[2]) };
}

function hashString(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    return Math.abs(h);
}

const groups = new Map();
for (const race of races) {
    if (!['G1', 'G2', 'G3'].includes(race.grade) || isVaries(race)) continue;
    if (!groups.has(race.race_name)) groups.set(race.race_name, []);
    groups.get(race.race_name).push(race);
}

const eligible = [];
for (const [name, entries] of groups) {
    const answers = new Set(entries.map(formatAnswer));
    if (answers.size !== 1) continue;
    const grades = new Set(entries.map((r) => r.grade));
    const rep = entries.find((r) => r.grade === 'G1') ?? entries[0];
    eligible.push({
        name,
        correct: formatAnswer(rep),
        grades,
        isG1: grades.has('G1'),
        rep,
    });
}

const answerPool = [...new Set(eligible.map((e) => e.correct))];

function scoreWrong(correct, candidate) {
    if (candidate === correct) return -Infinity;
    const c = parseAnswer(correct);
    const d = parseAnswer(candidate);
    let score = 0;

    if (c.track === d.track) score += 55;
    if (c.distance === d.distance) score += 50;

    const distanceDiff = Math.abs(c.distance - d.distance);
    if (distanceDiff === 200) score += 28;
    else if (distanceDiff === 400) score += 22;
    else if (distanceDiff <= 600) score += 14;
    else if (distanceDiff <= 1000) score += 6;

    const kansai = new Set(['Hanshin', 'Kyoto', 'Chukyo']);
    const kanto = new Set(['Tokyo', 'Nakayama']);
    if (c.track !== d.track) {
        if (kansai.has(c.track) && kansai.has(d.track)) score += 12;
        if (kanto.has(c.track) && kanto.has(d.track)) score += 12;
    }

    score += (hashString(`${correct}:${candidate}`) % 5);
    return score;
}

function pickWrongAnswers(correct, count = 5) {
    const scored = answerPool
        .map((candidate) => ({ candidate, score: scoreWrong(correct, candidate) }))
        .filter((item) => item.score > -Infinity)
        .sort((a, b) => b.score - a.score);

    const picked = [];
    const usedTracks = new Set();
    const usedDistances = new Set();

    for (const item of scored) {
        if (picked.length >= count) break;
        const { track, distance } = parseAnswer(item.candidate);
        if (picked.length < 2 && !usedDistances.has(distance)) {
            picked.push(item.candidate);
            usedTracks.add(track);
            usedDistances.add(distance);
            continue;
        }
        if (picked.length < 4 && !usedTracks.has(track)) {
            picked.push(item.candidate);
            usedTracks.add(track);
            usedDistances.add(distance);
            continue;
        }
        if (picked.length >= 3) {
            picked.push(item.candidate);
            usedTracks.add(track);
            usedDistances.add(distance);
        }
    }

    if (picked.length < count) {
        for (const item of scored) {
            if (picked.length >= count) break;
            if (!picked.includes(item.candidate)) picked.push(item.candidate);
        }
    }

    return picked.slice(0, count);
}

const g1Entries = eligible
    .filter((e) => e.isG1)
    .sort((a, b) => a.name.localeCompare(b.name));

const g2g3Entries = eligible
    .filter((e) => !e.isG1)
    .sort((a, b) => a.name.localeCompare(b.name));

const pickedG2G3 = [];
const usedTracks = new Set();
for (const entry of g2g3Entries) {
    if (pickedG2G3.length >= 15) break;
    const track = parseAnswer(entry.correct).track;
    if (pickedG2G3.length < 10 && usedTracks.has(track)) continue;
    pickedG2G3.push(entry);
    usedTracks.add(track);
}
for (const entry of g2g3Entries) {
    if (pickedG2G3.length >= 15) break;
    if (!pickedG2G3.includes(entry)) pickedG2G3.push(entry);
}

const selected = [...g1Entries, ...pickedG2G3.sort((a, b) => a.name.localeCompare(b.name))];

const entries = selected.map(({ name, correct }) => [
    name,
    [correct, ...pickWrongAnswers(correct, 5)],
]);

const lines = entries.map((entry, index) => {
    const suffix = index < entries.length - 1 ? ',' : '';
    return `               ${JSON.stringify(entry)}${suffix}`;
});

const content = `{
  "name": "Test",
  "questions": [
        {   "promptTemplate": "What track and distance is the generic {0}?\\n ", "difficulty": "hard",
            "entries": [
${lines.join('\n')}
             ]
        }
  ]
}
`;

const outPath = path.join(ROOT, 'assets/quiz/categories/testquestions.json');
fs.writeFileSync(outPath, content, 'utf8');

console.log(`Wrote ${entries.length} entries (${g1Entries.length} G1, ${pickedG2G3.length} G2/G3)`);
