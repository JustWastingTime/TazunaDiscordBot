import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import ffmpegPath from 'ffmpeg-static';

const execFileAsync = promisify(execFile);
const QUIZ_AUDIO_FETCH_TIMEOUT_MS = 20_000;

function parseFfmpegDuration(output) {
  const match = output.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const seconds = parseFloat(match[3]);
  return hours * 3600 + minutes * 60 + seconds;
}

async function probeDuration(inputPath) {
  if (!ffmpegPath) throw new Error('ffmpeg binary not available');

  try {
    await execFileAsync(ffmpegPath, ['-i', inputPath], { maxBuffer: 2 * 1024 * 1024 });
  } catch (err) {
    const output = `${err.stdout || ''}\n${err.stderr || ''}`;
    const duration = parseFfmpegDuration(output);
    if (duration != null) return duration;
    throw new Error('Could not read audio duration');
  }

  throw new Error('Could not read audio duration');
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors.
  }
}

async function downloadAudio(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(QUIZ_AUDIO_FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Failed to download audio (${response.status})`);

  const inputPath = path.join(
    os.tmpdir(),
    `tazuna-quiz-src-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
  );
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(inputPath, buffer);
  return inputPath;
}

async function trimAudioFile(inputPath, clipSeconds, duration) {
  const maxStart = Math.max(0, duration - clipSeconds);
  const start = maxStart > 0.25 ? Math.random() * maxStart : 0;
  const clipLength = Math.min(clipSeconds, Math.max(0, duration - start));
  if (clipLength <= 0) throw new Error('Audio clip length is zero');

  const outputPath = path.join(
    os.tmpdir(),
    `tazuna-quiz-clip-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`,
  );

  await execFileAsync(ffmpegPath, [
    '-ss', start.toFixed(3),
    '-i', inputPath,
    '-t', clipLength.toFixed(3),
    '-acodec', 'libmp3lame',
    '-q:a', '4',
    '-y', outputPath,
  ]);

  const buffer = fs.readFileSync(outputPath);
  safeUnlink(outputPath);
  return buffer;
}

export async function createQuizAudioFile(audioUrl, clipSeconds) {
  if (!ffmpegPath) {
    const response = await fetch(audioUrl, {
      signal: AbortSignal.timeout(QUIZ_AUDIO_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Failed to download audio (${response.status})`);
    return {
      buffer: Buffer.from(await response.arrayBuffer()),
      filename: 'quiz-audio.mp3',
      mime: 'audio/mpeg',
    };
  }

  let inputPath;
  try {
    inputPath = await downloadAudio(audioUrl);
    const duration = await probeDuration(inputPath);

    if (duration <= clipSeconds) {
      return {
        buffer: fs.readFileSync(inputPath),
        filename: 'quiz-audio.mp3',
        mime: 'audio/mpeg',
      };
    }

    const buffer = await trimAudioFile(inputPath, clipSeconds, duration);
    return { buffer, filename: 'quiz-audio.mp3', mime: 'audio/mpeg' };
  } finally {
    if (inputPath) safeUnlink(inputPath);
  }
}
