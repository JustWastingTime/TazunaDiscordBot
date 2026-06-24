import { createQuizAudioFile } from './quizAudio.js';
import { createSilhouetteFile } from './quizImage.js';
import { resolveMcqAnswers } from './quizLists.js';

export const DEFAULT_ROUND_SECONDS = 10;
export const AUDIO_ROUND_BONUS_SECONDS = 5;
export const IMAGE_ROUND_BONUS_SECONDS = 5;
export const MIN_ROUND_SECONDS = 10;
export const MAX_ROUND_SECONDS = 30;
export const DEFAULT_SCORE_GOAL = 15;
export const FIRST_POINTS = 2;
export const OTHER_POINTS = 1;
export const BETWEEN_ROUNDS_MS = 3_000;
export const QUIZ_START_COUNTDOWN_SECONDS = 5;
export const QUIZ_WIN_MIN_PARTICIPANTS = 3;
export const QUIZ_WIN_BASE_COINS = 10;
export const QUIZ_WIN_COINS_PER_PARTICIPANT = 5;
export const QUIZ_WIN_MAX_COINS = 50;
export const EMPTY_ROUND_LIMIT = 3;
export const UMASTAN_GAMER_POOL_WEIGHT = 0.6;

export const QUIZ_GAMEMODES = {
  gamer: ['umas', 'gamedata'],
  larper: ['songs', 'keiba', 'trivia', 'umaguesser'],
  umadol: ['songs'],
  umaguesser: ['umaguesser'],
  testing: ['testquestions'],
};

export const DEFAULT_GAMEMODE = 'umastan';
export const DIFFICULTY_LEVELS = ['easy', 'medium', 'hard', 'expert'];
export const SESSION_DIFFICULTY_LEVELS = [...DIFFICULTY_LEVELS, 'default'];
export const DEFAULT_DIFFICULTY = 'default';
export const DEFAULT_QUESTION_DIFFICULTY = 'medium';
export const QUIZ_MODE = 'mcq';
export const BUTTON_LABEL_MAX = 80;

const MCQ_WRONG_CHOICES = 3;

function shuffleArray(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function normalizeAnswer(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildMcqChoiceSet(question) {
  const answers = resolveMcqAnswers(question.answers || [], {
    minWrong: MCQ_WRONG_CHOICES,
    normalizeAnswer,
  });
  if (!answers.length) return { choices: [], correctIndex: -1 };

  const correctAnswer = answers[0];
  const wrongPool = answers.slice(1);
  const selectedWrong =
    wrongPool.length > MCQ_WRONG_CHOICES
      ? shuffleArray(wrongPool).slice(0, MCQ_WRONG_CHOICES)
      : wrongPool;

  return {
    choices: [correctAnswer, ...selectedWrong],
    correctIndex: 0,
  };
}

function isMcqChoiceCorrect(round, choiceIndex) {
  return round?.type === 'mcq' && choiceIndex === round.correctIndex;
}

function shuffleMcqAnswers(answers, correctIndex) {
  const indexed = answers.map((text, i) => ({ text, originalIndex: i }));
  for (let i = indexed.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [indexed[i], indexed[j]] = [indexed[j], indexed[i]];
  }
  const shuffledAnswers = indexed.map((entry) => entry.text);
  const shuffledCorrectIndex = indexed.findIndex((entry) => entry.originalIndex === correctIndex);
  return { shuffledAnswers, correctIndex: shuffledCorrectIndex };
}

function getMcqAnswerText(round, question) {
  if (round?.shuffledAnswers && typeof round.correctIndex === 'number') {
    return round.shuffledAnswers[round.correctIndex];
  }
  return question.answers?.[0] ?? '?';
}

function getResponseChoiceLabel(round, response) {
  if (response.choiceIndex != null && round?.shuffledAnswers) {
    return round.shuffledAnswers[response.choiceIndex];
  }
  if (response.text) return response.text;
  return null;
}

function getCategoryFooterText(question) {
  const name = question.categoryName || question.category || 'Quiz';
  return `Category - ${name}`;
}

export function normalizeGamemode(gamemode) {
  const value = String(gamemode || '').toLowerCase();
  if (
    value === 'gamer'
    || value === 'larper'
    || value === 'umadol'
    || value === 'umaguesser'
    || value === 'testing'
  ) {
    return value;
  }
  if (value === 'godgamer') return DEFAULT_GAMEMODE;
  return DEFAULT_GAMEMODE;
}

export function getGamemodeCategories(gamemode, enabledCategories) {
  const normalized = normalizeGamemode(gamemode);
  if (normalized === DEFAULT_GAMEMODE) return [...enabledCategories];
  if (normalized === 'testing') return ['testquestions'];
  const enabled = new Set(enabledCategories);
  return (QUIZ_GAMEMODES[normalized] || []).filter((categoryId) => enabled.has(categoryId));
}

export function getGamemodeLabel(gamemode) {
  const labels = {
    gamer: 'Gamer',
    larper: 'Larper',
    umadol: 'Umadol',
    umaguesser: 'Umaguesser',
    umastan: 'Umastan',
    testing: 'TESTING - IGNORE THIS',
  };
  return labels[normalizeGamemode(gamemode)];
}

export function normalizeDifficulty(difficulty) {
  const value = String(difficulty ?? '').trim().toLowerCase();
  if (SESSION_DIFFICULTY_LEVELS.includes(value)) return value;
  return DEFAULT_DIFFICULTY;
}

export function getDifficultyLabel(difficulty) {
  const labels = {
    easy: 'Easy',
    medium: 'Medium',
    hard: 'Hard',
    expert: 'Expert',
    default: 'Default',
  };
  return labels[normalizeDifficulty(difficulty)];
}

export function getQuizParticipantCount(scores) {
  return Object.keys(scores || {}).length;
}

export function calculateQuizWinReward(participantCount) {
  if (participantCount < QUIZ_WIN_MIN_PARTICIPANTS) return 0;
  const raw =
    QUIZ_WIN_BASE_COINS + (participantCount - QUIZ_WIN_MIN_PARTICIPANTS) * QUIZ_WIN_COINS_PER_PARTICIPANT;
  return Math.min(QUIZ_WIN_MAX_COINS, raw);
}

function truncateLabel(label, fallback = 'Answer') {
  const s = String(label ?? '').trim();
  if (!s) return fallback;
  return s.length <= BUTTON_LABEL_MAX ? s : `${s.slice(0, BUTTON_LABEL_MAX - 1)}…`;
}

export function getQuestionDifficulty(question) {
  const value = String(question?.difficulty || DEFAULT_QUESTION_DIFFICULTY).toLowerCase();
  return DIFFICULTY_LEVELS.includes(value) ? value : DEFAULT_QUESTION_DIFFICULTY;
}

export function rollQuestionDifficulty(sessionDifficulty) {
  const mode = normalizeDifficulty(sessionDifficulty);
  switch (mode) {
    case 'easy':
      return 'easy';
    case 'medium':
      return Math.random() < 0.8 ? 'medium' : 'easy';
    case 'hard':
      return Math.random() < 0.8 ? 'hard' : 'medium';
    case 'expert':
      return 'expert';
    case 'default':
    default: {
      const roll = Math.random();
      if (roll < 0.4) return 'hard';
      if (roll < 0.7) return 'medium';
      if (roll < 0.9) return 'easy';
      return 'expert';
    }
  }
}

export function buildTierTryOrder(sessionDifficulty) {
  const mode = normalizeDifficulty(sessionDifficulty);
  const rolled = rollQuestionDifficulty(mode);

  switch (mode) {
    case 'easy':
      return ['easy', 'medium'];
    case 'medium':
      return [rolled, 'hard'];
    case 'hard':
      return [rolled, 'expert'];
    case 'expert':
      return ['expert', 'hard'];
    case 'default': {
      const fallbackOrder = ['hard', 'medium', 'easy', 'expert'].filter((tier) => tier !== rolled);
      return [rolled, ...fallbackOrder];
    }
    default:
      return [rolled];
  }
}

export function matchesMediaFilters(question, { allowAudio = true, allowPicture = true } = {}) {
  if (question.audioUrl && !allowAudio) return false;
  if (question.imageUrl && !allowPicture) return false;
  return true;
}

export function filterSessionQuestions(questions, options) {
  const { gamemode, allowAudio, allowPicture } = options;
  return questions.filter((question) => {
    if (question.type !== QUIZ_MODE) return false;
    return matchesMediaFilters(question, { allowAudio, allowPicture });
  });
}

function pickRandomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function getTemplateKey(question) {
  const category = String(question?.category || '').trim().toLowerCase();
  const template = String(question?.promptTemplate || question?.prompt || '').trim().toLowerCase();
  return `${category}::${template}`;
}

function countAskedTimes(questionId, usedIds) {
  let count = 0;
  for (const id of usedIds) {
    if (id === questionId) count += 1;
  }
  return count;
}

function countTemplateAskedTimes(templateKey, usedIds, questionById) {
  let count = 0;
  for (const id of usedIds) {
    const question = questionById.get(id);
    if (!question) continue;
    if (getTemplateKey(question) === templateKey) count += 1;
  }
  return count;
}

function applyRepeatGuards(pool, usedIds, avoidId = null) {
  let candidates = [...pool];
  if (!candidates.length) return candidates;

  if (avoidId && candidates.length > 1) {
    const noImmediateRepeat = candidates.filter((question) => question.id !== avoidId);
    if (noImmediateRepeat.length) candidates = noImmediateRepeat;
  }

  const recentWindowSize = Math.max(3, Math.min(12, Math.floor(usedIds.length * 0.2)));
  const recentIds = new Set(usedIds.slice(-recentWindowSize));
  if (recentIds.size && candidates.length > recentIds.size) {
    const notRecent = candidates.filter((question) => !recentIds.has(question.id));
    if (notRecent.length) candidates = notRecent;
  }

  return candidates;
}

function pickWeightedFromPool(pool, usedIds, questionById, avoidId = null) {
  if (!pool.length) return null;

  const candidates = applyRepeatGuards(pool, usedIds, avoidId);
  if (!candidates.length) return null;

  const grouped = new Map();
  for (const question of candidates) {
    const templateKey = getTemplateKey(question);
    if (!grouped.has(templateKey)) grouped.set(templateKey, []);
    grouped.get(templateKey).push(question);
  }
  let templateGroups = [...grouped.entries()].map(([templateKey, questions]) => ({ templateKey, questions }));

  const avoidTemplate = avoidId ? getTemplateKey(questionById.get(avoidId)) : null;
  if (avoidTemplate && templateGroups.length > 1) {
    const noImmediateTemplateRepeat = templateGroups.filter((group) => group.templateKey !== avoidTemplate);
    if (noImmediateTemplateRepeat.length) templateGroups = noImmediateTemplateRepeat;
  }

  const minTemplateAsked = Math.min(
    ...templateGroups.map((group) => countTemplateAskedTimes(group.templateKey, usedIds, questionById)),
  );
  const leastAskedTemplates = templateGroups.filter(
    (group) => countTemplateAskedTimes(group.templateKey, usedIds, questionById) === minTemplateAsked,
  );
  const pickedTemplateQuestions = pickRandomItem(leastAskedTemplates).questions;

  const usedSet = new Set(usedIds);
  const unused = pickedTemplateQuestions.filter((question) => !usedSet.has(question.id));
  const workingPool = unused.length ? unused : pickedTemplateQuestions;

  const minAsked = Math.min(...workingPool.map((question) => countAskedTimes(question.id, usedIds)));
  const leastAsked = workingPool.filter(
    (question) => countAskedTimes(question.id, usedIds) === minAsked,
  );
  return pickRandomItem(leastAsked);
}

function pickQuestionFromPool(eligible, selectedDifficulty, usedIds) {
  if (!eligible.length) return null;

  const questionById = new Map(eligible.map((question) => [question.id, question]));
  const avoidId = usedIds.length ? usedIds[usedIds.length - 1] : null;
  const usedSet = new Set(usedIds);
  const unusedEligible = eligible.filter((question) => !usedSet.has(question.id));
  const searchPool = unusedEligible.length ? unusedEligible : eligible;
  const tierOrder = buildTierTryOrder(selectedDifficulty);

  for (const tier of tierOrder) {
    const tierPool = searchPool.filter(
      (question) => getQuestionDifficulty(question) === tier,
    );
    if (!tierPool.length) continue;
    const picked = pickWeightedFromPool(tierPool, usedIds, questionById, avoidId);
    if (picked) return picked;
  }

  const lastTier = tierOrder[tierOrder.length - 1];
  const lastTierPool = searchPool.filter(
    (question) => getQuestionDifficulty(question) === lastTier,
  );
  if (lastTierPool.length) {
    return pickWeightedFromPool(lastTierPool, usedIds, questionById, avoidId);
  }

  return null;
}

function buildUmastanPickOrder(questions, enabledCategories) {
  const enabled = new Set(enabledCategories || []);
  const gamerCats = new Set(QUIZ_GAMEMODES.gamer.filter((categoryId) => enabled.has(categoryId)));
  const larperCats = new Set(QUIZ_GAMEMODES.larper.filter((categoryId) => enabled.has(categoryId)));
  const gamerPool = questions.filter((question) => gamerCats.has(question.category));
  const larperPool = questions.filter((question) => larperCats.has(question.category));

  const preferGamer = Math.random() < UMASTAN_GAMER_POOL_WEIGHT;
  const primary = preferGamer ? gamerPool : larperPool;
  const secondary = preferGamer ? larperPool : gamerPool;
  const order = [];
  if (primary.length) order.push(primary);
  if (secondary.length) order.push(secondary);
  return order.length ? order : [questions];
}

export function pickQuestion(questions, options) {
  const { selectedDifficulty, usedIds = [], gamemode, enabledCategories } = options;
  const eligible = questions.filter((q) => q.type === QUIZ_MODE);
  if (!eligible.length) return null;

  const poolsToTry = normalizeGamemode(gamemode) === DEFAULT_GAMEMODE
    ? buildUmastanPickOrder(eligible, enabledCategories)
    : [eligible];

  for (const pool of poolsToTry) {
    const picked = pickQuestionFromPool(pool, selectedDifficulty, usedIds);
    if (picked) return picked;
  }

  return null;
}

export function getQuestionById(questions, id) {
  return questions.find((q) => q.id === id) || null;
}

export function normalizeRoundSeconds(seconds) {
  if (seconds == null || !Number.isFinite(Number(seconds))) return DEFAULT_ROUND_SECONDS;
  return Math.min(MAX_ROUND_SECONDS, Math.max(MIN_ROUND_SECONDS, Math.floor(Number(seconds))));
}

export function normalizeScoreGoal(scoreGoal) {
  if (scoreGoal == null || !Number.isFinite(Number(scoreGoal))) return DEFAULT_SCORE_GOAL;
  return Math.min(50, Math.max(10, Math.floor(Number(scoreGoal))));
}

export function parseYesNo(value, defaultValue = true) {
  if (value == null || value === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'yes' || normalized === 'true') return true;
  if (normalized === 'no' || normalized === 'false') return false;
  return defaultValue;
}

export function isAudioQuestion(question) {
  return Boolean(question?.audioUrl);
}

export function isImageQuestion(question) {
  return Boolean(question?.imageUrl);
}

export function getRoundSeconds(quizState, question) {
  const base = normalizeRoundSeconds(quizState?.roundSeconds);
  let bonus = 0;
  if (isAudioQuestion(question)) bonus += AUDIO_ROUND_BONUS_SECONDS;
  if (isImageQuestion(question)) bonus += IMAGE_ROUND_BONUS_SECONDS;
  return base + bonus;
}

export function createQuizState({
  guildId,
  channelId,
  startedBy,
  starterName,
  gamemode,
  difficulty,
  roundSeconds,
  scoreGoal,
  allowAudio,
  allowPicture,
}) {
  const mode = normalizeGamemode(gamemode);
  return {
    guildId,
    channelId,
    startedBy,
    starterName,
    mode: QUIZ_MODE,
    gamemode: mode,
    difficulty: normalizeDifficulty(difficulty),
    roundSeconds: normalizeRoundSeconds(roundSeconds),
    scoreGoal: normalizeScoreGoal(scoreGoal),
    allowAudio: mode === 'umadol' ? true : allowAudio,
    allowPicture: mode === 'umaguesser' || mode === 'testing' ? true : allowPicture,
    status: 'active',
    scores: {},
    usedQuestionIds: [],
    emptyRoundStreak: 0,
    roundCount: 0,
    pendingWinner: null,
    goalReachCounter: 0,
    round: null,
  };
}

function ensurePlayer(scores, userId, displayName) {
  if (!scores[userId]) {
    scores[userId] = { displayName, points: 0 };
  } else {
    scores[userId].displayName = displayName;
  }
  return scores[userId];
}

function countCorrectResponses(round) {
  return Object.values(round.responses).filter((r) => r.correct).length;
}

export function isRoundOpen(quiz) {
  if (!quiz?.round || quiz.status !== 'active') return false;
  return Date.now() < quiz.round.endsAt;
}

export function hasUserAnswered(quiz, userId) {
  return Boolean(quiz.round?.responses?.[userId]);
}

function pointsForNextCorrect(quiz) {
  return countCorrectResponses(quiz.round) === 0 ? FIRST_POINTS : OTHER_POINTS;
}

export function recordResponse(quiz, userId, displayName, { correct, choiceIndex, text }) {
  if (!isRoundOpen(quiz)) {
    return { ok: false, error: 'This round has ended.' };
  }
  if (hasUserAnswered(quiz, userId)) {
    return { ok: false, error: 'You already answered this round.' };
  }

  ensurePlayer(quiz.scores, userId, displayName);

  let points = 0;
  if (correct) {
    points = pointsForNextCorrect(quiz);
    quiz.scores[userId].points += points;
  }

  const reachedAt = Date.now();
  quiz.round.responses[userId] = {
    correct,
    at: reachedAt,
    points,
    choiceIndex: choiceIndex ?? null,
    text: text ?? null,
  };

  const totalPoints = quiz.scores[userId].points;
  const scoreGoal = quiz.scoreGoal ?? DEFAULT_SCORE_GOAL;
  if (correct && totalPoints >= scoreGoal && !quiz.scores[userId].reachedGoalAt) {
    quiz.goalReachCounter = (quiz.goalReachCounter || 0) + 1;
    quiz.scores[userId].reachedGoalAt = quiz.goalReachCounter;
  }
  if (correct && totalPoints >= scoreGoal) {
    if (!quiz.pendingWinner || reachedAt < quiz.pendingWinner.reachedAt) {
      quiz.pendingWinner = {
        userId,
        displayName: quiz.scores[userId].displayName,
        points: totalPoints,
        reachedAt,
      };
    }
  }

  return {
    ok: true,
    correct,
    points,
    isFirstCorrect: correct && points === FIRST_POINTS,
    totalPoints,
    reachedWinTarget: correct && totalPoints >= scoreGoal,
  };
}

export function processMcqAnswer(quiz, question, userId, displayName, choiceIndex) {
  if (!question || question.type !== 'mcq') {
    return { ok: false, error: 'Invalid question.' };
  }
  const answers = quiz.round?.shuffledAnswers || question.answers || [];
  if (choiceIndex < 0 || choiceIndex >= answers.length) {
    return { ok: false, error: 'Invalid choice.' };
  }

  const correct = isMcqChoiceCorrect(quiz.round, choiceIndex);
  return recordResponse(quiz, userId, displayName, { correct, choiceIndex });
}

export function startRoundState(quiz, question, messageId) {
  const roundNumber = (quiz.roundCount || 0) + 1;
  quiz.roundCount = roundNumber;
  const roundSeconds = getRoundSeconds(quiz, question);
  quiz.round = {
    number: roundNumber,
    questionId: question.id,
    type: question.type,
    messageId,
    startedAt: Date.now(),
    endsAt: Date.now() + roundSeconds * 1000,
    roundSeconds,
    responses: {},
  };

  const { choices, correctIndex } = buildMcqChoiceSet(question);
  const { shuffledAnswers, correctIndex: shuffledCorrectIndex } = shuffleMcqAnswers(
    choices,
    correctIndex,
  );
  quiz.round.shuffledAnswers = shuffledAnswers;
  quiz.round.correctIndex = shuffledCorrectIndex;

  if (!quiz.usedQuestionIds.includes(question.id)) {
    quiz.usedQuestionIds.push(question.id);
  }
  return quiz.round;
}

export function clearRound(quiz) {
  quiz.round = null;
}

export function getScoreboardLines(scores, { scoreGoal = null } = {}) {
  const goal = scoreGoal ?? DEFAULT_SCORE_GOAL;
  const entries = Object.entries(scores)
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      const aReached = a.points >= goal && a.reachedGoalAt;
      const bReached = b.points >= goal && b.reachedGoalAt;
      if (aReached && bReached) return a.reachedGoalAt - b.reachedGoalAt;
      if (aReached) return -1;
      if (bReached) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

  if (!entries.length) return ['_No scores yet._'];
  return entries.map((entry, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
    return `${medal} **${entry.displayName}** — ${entry.points} pt${entry.points === 1 ? '' : 's'}`;
  });
}

function formatRoundSummary(quiz, question) {
  const responses = Object.entries(quiz.round?.responses || {})
    .map(([userId, r]) => ({
      userId,
      displayName: quiz.scores[userId]?.displayName || userId,
      ...r,
    }))
    .sort((a, b) => a.at - b.at);

  const correctLines = responses
    .filter((r) => r.correct)
    .map((r) => {
      const bonus = r.points === FIRST_POINTS ? ` (+${FIRST_POINTS}, first!)` : ' (+1)';
      return `✅ **${r.displayName}**${bonus}`;
    });

  const wrongResponses = responses.filter((r) => !r.correct);
  const wrongLines = wrongResponses.map((r) => {
    const picked = getResponseChoiceLabel(quiz.round, r);
    return picked
      ? `❌ **${r.displayName}** picked **${picked}**`
      : `❌ **${r.displayName}**`;
  });

  const answerLine = `**Answer:** ${getMcqAnswerText(quiz.round, question)}`;
  const wrongSection =
    responses.length > 10 && wrongResponses.length
      ? [`❌ **${wrongResponses.length}** wrong answer${wrongResponses.length === 1 ? '' : 's'}`]
      : wrongLines;

  const scoredSection = [
    correctLines.length ? '**Scored this round:**' : '**Nobody scored this round.**',
    ...correctLines,
    ...wrongSection,
  ].join('\n');
  const scoreboardSection = [
    '**Scoreboard**',
    ...getScoreboardLines(quiz.scores, { scoreGoal: quiz.scoreGoal }),
  ].join('\n');

  return [
    `**Round ${quiz.round.number}** — time's up!`,
    '',
    answerLine,
    '',
    '───',
    '',
    scoredSection,
    '',
    '───',
    '',
    scoreboardSection,
  ].join('\n');
}

function buildQuestionEmbed(question, quiz) {
  const endsAt = Math.floor(quiz.round.endsAt / 1000);
  return {
    color: 0xf1c40f,
    title: `Quiz Round ${quiz.round.number}`,
    description: `**${question.prompt}**\n\nEnds <t:${endsAt}:R>`,
    footer: { text: getCategoryFooterText(question) },
  };
}

export function buildMcqRows(guildId, round) {
  const answers = round.shuffledAnswers || [];
  return [{
    type: 1,
    components: answers.map((answer, i) => ({
      type: 2,
      style: 1,
      custom_id: `quiz-answer:${guildId}:${round.number}:${i}`,
      label: truncateLabel(answer, `Answer ${i + 1}`),
    })),
  }];
}

export function buildDisabledMcqRows(round) {
  const answers = round.shuffledAnswers || [];
  const correct = round.correctIndex;
  return [{
    type: 1,
    components: answers.map((answer, i) => ({
      type: 2,
      style: i === correct ? 3 : 2,
      custom_id: `quiz-ended:${i}`,
      label: truncateLabel(answer, `Answer ${i + 1}`),
      disabled: true,
    })),
  }];
}

export function syncRoundClock(quiz, question) {
  const roundSeconds = getRoundSeconds(quiz, question);
  const startedAt = Date.now();
  quiz.round.startedAt = startedAt;
  quiz.round.endsAt = startedAt + roundSeconds * 1000;
  quiz.round.roundSeconds = roundSeconds;
}

export async function buildQuestionMediaFiles(question, quiz) {
  const files = [];
  const media = {
    files,
    embedImage: null,
    embedImageFallback: null,
    audioNote: null,
    audioUrl: null,
  };

  if (question.audioUrl) {
    const clipSeconds = getRoundSeconds(quiz, question);
    try {
      files.push(await createQuizAudioFile(question.audioUrl, clipSeconds));
      if (!question.imageUrl) media.audioNote = 'clip';
    } catch (err) {
      console.error('Failed to trim quiz audio, sending URL fallback:', err.message);
      media.audioNote = 'link';
      media.audioUrl = question.audioUrl;
    }
  }

  if (question.imageUrl) {
    if (question.silhouette) {
      try {
        const silhouette = await createSilhouetteFile(question.imageUrl);
        files.push(silhouette);
        media.embedImage = { url: `attachment://${silhouette.filename}` };
      } catch (err) {
        console.error('Failed to create quiz silhouette, using image URL:', err.message);
        media.embedImage = { url: question.imageUrl };
      }
    } else {
      media.embedImage = { url: question.imageUrl };
    }
  }

  return media;
}

export function assembleQuestionPayload(question, quiz, media) {
  const embed = buildQuestionEmbed(question, quiz);
  if (media.audioNote === 'clip' && !question.imageUrl) {
    embed.description = `${embed.description}\n\n🔊 Listen to the attached audio clip.`;
  } else if (media.audioNote === 'link' && media.audioUrl) {
    embed.description = `${embed.description}\n\n🔊 [Listen to audio](${media.audioUrl})`;
  }

  if (media.embedImage) {
    embed.image = media.embedImage;
  } else if (media.embedImageFallback) {
    embed.image = { url: media.embedImageFallback };
  }

  const payload = { embeds: [embed], components: buildMcqRows(quiz.guildId, quiz.round) };
  if (media.files.length) payload.files = media.files;
  return payload;
}

export async function buildQuestionPayload(question, quiz) {
  const media = await buildQuestionMediaFiles(question, quiz);
  syncRoundClock(quiz, question);
  return assembleQuestionPayload(question, quiz, media);
}

export function buildWinnerEmbed(winner, scores, { coinReward = 0, scoreGoal = DEFAULT_SCORE_GOAL } = {}) {
  const lines = [`🏆 **${winner.displayName}** wins with **${winner.points}** points!`];
  if (coinReward > 0) {
    lines.push('', `💰 **+${coinReward.toLocaleString('en-US')}** GambaCoins`);
  } else {
    lines.push('', '_No coin reward — need at least 3 participants._');
  }
  lines.push('', `**Final scoreboard** (goal: ${scoreGoal})`, ...getScoreboardLines(scores, { scoreGoal }));

  return {
    color: 0x57f287,
    title: 'Quiz finished!',
    description: lines.join('\n'),
    footer: { text: 'Use /quiz notify to get notifications for a quiz.' },
  };
}

export function buildRoundEndEmbed(quiz, question) {
  return {
    color: 0x5865f2,
    title: `Round ${quiz.round.number} over`,
    description: formatRoundSummary(quiz, question),
    footer: { text: getCategoryFooterText(question) },
  };
}

export function resolveWinnerAfterRound(quiz) {
  if (quiz.pendingWinner) return quiz.pendingWinner;

  const scoreGoal = quiz.scoreGoal ?? DEFAULT_SCORE_GOAL;
  const leaders = Object.entries(quiz.scores)
    .map(([userId, data]) => ({ userId, ...data }))
    .filter((entry) => entry.points >= scoreGoal)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (a.reachedGoalAt && b.reachedGoalAt) return a.reachedGoalAt - b.reachedGoalAt;
      return a.displayName.localeCompare(b.displayName);
    });

  return leaders[0] ?? null;
}
