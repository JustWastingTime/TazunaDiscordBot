import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const filePath = path.join(__dirname, '../assets/quiz/categories/testquestions.json');

let content = fs.readFileSync(filePath, 'utf8');

// Repair broken entries missing opening bracket: `"Subject",[` -> `["Subject",[`
content = content.replace(/^\s+"([^"]+)",(\[)/gm, (match, subject, bracket) => {
    const indent = match.match(/^\s+/)[0];
    return `${indent}["${subject}",${bracket}`;
});

// Add (Original) to subjects without any parenthetical tag
content = content.replace(/^\s+\["([^"]+)",(\[)/gm, (match, subject, bracket) => {
    if (/\([^)]+\)$/.test(subject.trim())) return match;
    const indent = match.match(/^\s+/)[0];
    return `${indent}["${subject} (Original)",${bracket}`;
});

fs.writeFileSync(filePath, content, 'utf8');

const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
const entries = data.questions[0].entries;
const untagged = entries.filter((e) => !/\([^)]+\)$/.test(e[0])).map((e) => e[0]);
console.log(`Validated ${entries.length} entries. Untagged remaining: ${untagged.length}`);
if (untagged.length) console.log(untagged);
