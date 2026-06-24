import { addGambaCoins, ensureQuizUser, recordQuizAnswer } from './clubDatabase.js';
import {
  clearQuiz,
  getActiveQuiz,
  loadQuizQuestions,
  loadQuizSettings,
  loadQuizState,
  updateQuizState,
} from './quizStorage.js';
import {
  deleteChannelMessage,
  editChannelMessage,
  isTransientDiscordError,
  sendChannelMessage,
  summarizeDiscordError,
} from './quizDiscord.js';
import { getGuildQuizRoleId } from './quizGuild.js';
import * as quiz from './quizService.js';

const roundTimers = new Map();
const betweenRoundTimers = new Map();
const QUIZ_ROLE_SETUP_TIMEOUT_MS = 8_000;
const QUIZ_CHANNEL_PERMISSIONS_HELP =
  'Give me **View Channel**, **Send Messages**, **Embed Links**, and **Use External Apps** in that channel (check channel overrides too).';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelTimer(map, guildId) {
  const existing = map.get(guildId);
  if (existing) {
    clearTimeout(existing);
    map.delete(guildId);
  }
}

export function cancelAllTimers(guildId) {
  cancelTimer(roundTimers, guildId);
  cancelTimer(betweenRoundTimers, guildId);
}

function isChannelUnavailableError(err) {
  const message = String(err?.message || err || '');
  return message.includes('50001') || message.includes('50013') || message.includes('10003');
}

function revertPendingRound(guildId) {
  return updateQuizState((state) => {
    const current = state[guildId];
    if (!current?.round) return true;

    const questionId = current.round.questionId;
    if (questionId) {
      current.usedQuestionIds = (current.usedQuestionIds || []).filter((id) => id !== questionId);
    }
    current.roundCount = Math.max(0, (current.roundCount || 1) - 1);
    current.round = null;
    return true;
  });
}

function scheduleNextRound(guildId, delayMs = quiz.BETWEEN_ROUNDS_MS) {
  cancelTimer(betweenRoundTimers, guildId);
  const timer = setTimeout(() => {
    beginRound(guildId).catch((err) => {
      console.error('Failed to start next quiz round:', summarizeDiscordError(err));
      scheduleRoundRecovery(guildId);
    });
  }, delayMs);
  betweenRoundTimers.set(guildId, timer);
}

function scheduleRoundRecovery(guildId, attempt = 0) {
  const active = getActiveQuiz(guildId);
  if (!active || active.status !== 'active') return;

  if (attempt >= 5) {
    abortQuiz(guildId, 'too many Discord failures while posting quiz rounds').catch((err) => {
      console.error('Failed to abort quiz after recovery attempts:', summarizeDiscordError(err));
    });
    return;
  }

  cancelTimer(betweenRoundTimers, guildId);
  const delayMs = Math.min(30_000, 3000 * (attempt + 1));
  console.warn(`Scheduling quiz round recovery for guild ${guildId} in ${delayMs}ms (attempt ${attempt + 1})`);

  const timer = setTimeout(() => {
    beginRound(guildId).catch((err) => {
      console.error('Quiz round recovery failed:', summarizeDiscordError(err));
      scheduleRoundRecovery(guildId, attempt + 1);
    });
  }, delayMs);
  betweenRoundTimers.set(guildId, timer);
}

async function safeChannelSend(channelId, payload, context) {
  try {
    return await sendChannelMessage(channelId, payload);
  } catch (err) {
    if (isChannelUnavailableError(err)) {
      console.warn(`${context}: channel unavailable (${summarizeDiscordError(err)})`);
      return null;
    }
    if (isTransientDiscordError(err)) {
      console.warn(`${context}: transient Discord error (${summarizeDiscordError(err)})`);
      return null;
    }
    throw err;
  }
}

function formatQuizChannelError(prefix) {
  return `${prefix} ${QUIZ_CHANNEL_PERMISSIONS_HELP}`;
}

async function validateQuizChannel(channelId) {
  try {
    const probe = await sendChannelMessage(channelId, {
      content: '\u200b',
      embeds: [{ description: 'Quiz channel check', color: 0xf1c40f }],
      components: [{
        type: 1,
        components: [{
          type: 2,
          style: 2,
          custom_id: 'quiz-probe:0',
          label: 'Check',
          disabled: true,
        }],
      }],
      flags: 4096,
    });
    if (probe?.id) {
      await deleteChannelMessage(channelId, probe.id);
    }
    return { ok: true };
  } catch (err) {
    if (isChannelUnavailableError(err)) {
      return {
        ok: false,
        error: formatQuizChannelError('I cannot post quiz rounds in this channel.'),
      };
    }
    if (isTransientDiscordError(err)) {
      console.warn(`Quiz channel probe transient failure: ${summarizeDiscordError(err)}`);
      return { ok: true };
    }
    return {
      ok: false,
      error: `Could not verify quiz channel: ${summarizeDiscordError(err)}`,
    };
  }
}

async function abortQuiz(guildId, reason) {
  cancelAllTimers(guildId);
  await clearQuiz(guildId);
  console.warn(`Quiz aborted for guild ${guildId}: ${reason}`);
}

function formatQuizLoadError(gamemode) {
  const settings = loadQuizSettings();
  const enabled = settings.enabledCategories || [];
  if (!enabled.length) {
    return 'No quiz categories enabled.';
  }
  const categories = quiz.getGamemodeCategories(gamemode, enabled);
  if (!categories.length) {
    return `No enabled categories for **${quiz.getGamemodeLabel(gamemode)}** mode.`;
  }
  return `No MCQ questions loaded for **${quiz.getGamemodeLabel(gamemode)}** (${categories.join(', ')}).`;
}

function loadSessionQuestions(quizState) {
  const enabled = loadQuizSettings().enabledCategories || [];
  const categories = quiz.getGamemodeCategories(quizState?.gamemode, enabled);
  const questions = quiz.filterSessionQuestions(loadQuizQuestions(categories), {
    gamemode: quizState.gamemode,
    allowAudio: quizState.allowAudio,
    allowPicture: quizState.allowPicture,
  });
  return { categories, questions };
}

async function runStartCountdown(channelId, seconds) {
  let message = await safeChannelSend(
    channelId,
    { content: `⏳ First question in **${seconds}**...` },
    'quiz countdown',
  );

  for (let remaining = seconds - 1; remaining >= 1; remaining -= 1) {
    await sleep(1000);
    if (!message?.id) continue;
    try {
      await editChannelMessage(channelId, message.id, {
        content: `⏳ First question in **${remaining}**...`,
      });
    } catch {
      // Ignore edit failures during countdown.
    }
  }

  await sleep(1000);
  if (message?.id) {
    await deleteChannelMessage(channelId, message.id);
  }
}

async function awardQuizWinCoins(winner, participantCount) {
  const coinReward = quiz.calculateQuizWinReward(participantCount);
  if (coinReward <= 0) return { coinReward: 0 };

  addGambaCoins(winner.userId, coinReward);
  return { coinReward };
}

export async function finishQuiz(guildId, winner) {
  cancelAllTimers(guildId);

  const active = getActiveQuiz(guildId);
  if (!active) return;

  const participantCount = quiz.getQuizParticipantCount(active.scores);
  const reward = await awardQuizWinCoins(winner, participantCount);

  await safeChannelSend(
    active.channelId,
    {
      embeds: [
        quiz.buildWinnerEmbed(winner, active.scores, {
          coinReward: reward.coinReward,
          scoreGoal: active.scoreGoal,
        }),
      ],
    },
    'finishQuiz',
  );

  await clearQuiz(guildId);
}

export async function finishRound(guildId) {
  cancelTimer(roundTimers, guildId);

  const outcome = await updateQuizState((state) => {
    const active = state[guildId];
    if (!active?.round || active.status !== 'active') return { done: false };

    const { questions } = loadSessionQuestions(active);
    const question = quiz.getQuestionById(questions, active.round.questionId);
    if (!question) {
      active.status = 'finished';
      return { done: true, error: 'Question missing from quiz category files.', active };
    }

    return { done: true, active, question };
  });

  if (!outcome?.done) return;

  if (outcome.error) {
    await safeChannelSend(
      outcome.active.channelId,
      { content: `❌ Quiz ended: ${outcome.error}` },
      'finishRound',
    );
    await clearQuiz(guildId);
    return;
  }

  const { active, question } = outcome;
  try {
    await editChannelMessage(active.channelId, active.round.messageId, {
      components: quiz.buildDisabledMcqRows(active.round),
    });
    await safeChannelSend(
      active.channelId,
      { embeds: [quiz.buildRoundEndEmbed(active, question)] },
      'finishRound summary',
    );
  } catch (err) {
    console.error('Failed to edit quiz round message:', summarizeDiscordError(err));
    await safeChannelSend(
      active.channelId,
      { embeds: [quiz.buildRoundEndEmbed(active, question)] },
      'finishRound fallback',
    );
  }

  const hadAnswers = Object.keys(active.round.responses).length > 0;
  const pendingWinner = active.pendingWinner;
  quiz.clearRound(active);

  let emptyRoundStreak = 0;
  await updateQuizState((state) => {
    const current = state[guildId];
    if (!current) return true;
    if (hadAnswers) current.emptyRoundStreak = 0;
    else current.emptyRoundStreak = (current.emptyRoundStreak || 0) + 1;
    emptyRoundStreak = current.emptyRoundStreak;
    current.round = null;
    return true;
  });

  if (emptyRoundStreak >= quiz.EMPTY_ROUND_LIMIT) {
    await stopQuiz(guildId, {
      reason: `⏹️ **Quiz auto-stopped** — no answers for **${quiz.EMPTY_ROUND_LIMIT}** rounds in a row.`,
    });
    return;
  }

  const winner = pendingWinner || quiz.resolveWinnerAfterRound(active);
  if (winner && winner.points >= (active.scoreGoal ?? quiz.DEFAULT_SCORE_GOAL)) {
    await finishQuiz(guildId, winner);
    return;
  }

  scheduleNextRound(guildId);
}

function scheduleRoundEnd(guildId) {
  cancelTimer(roundTimers, guildId);

  const active = getActiveQuiz(guildId);
  if (!active?.round) return;

  const remaining = active.round.endsAt - Date.now();
  const delay = Math.max(0, remaining);
  const timer = setTimeout(() => {
    finishRound(guildId).catch((err) => {
      console.error('Failed to finish quiz round:', summarizeDiscordError(err));
      scheduleRoundRecovery(guildId);
    });
  }, delay);
  roundTimers.set(guildId, timer);
}

async function prepareRoundContent(guildId) {
  const activeQuiz = getActiveQuiz(guildId);
  if (!activeQuiz) return { ok: false, error: 'No active quiz.' };

  const { questions } = loadSessionQuestions(activeQuiz);
  if (!questions.length) {
    const error = formatQuizLoadError(activeQuiz.gamemode);
    await updateQuizState((state) => {
      delete state[guildId];
      return { error };
    });
    return { ok: false, error };
  }

  const setup = await updateQuizState((state) => {
    const active = state[guildId];
    if (!active || active.status !== 'active') return { ok: false, error: 'No active quiz.' };

    const question = quiz.pickQuestion(questions, {
      selectedDifficulty: active.difficulty,
      usedIds: active.usedQuestionIds,
      gamemode: active.gamemode,
      enabledCategories: loadQuizSettings().enabledCategories || [],
    });
    if (!question) {
      return {
        ok: false,
        error: `No questions available for **${quiz.getGamemodeLabel(active.gamemode)}** mode.`,
      };
    }

    quiz.startRoundState(active, question, null);
    return { ok: true, question };
  });

  if (!setup.ok) return setup;

  const active = getActiveQuiz(guildId);
  const media = await quiz.buildQuestionMediaFiles(setup.question, active);
  return { ok: true, question: setup.question, media };
}

async function publishRound(guildId, prep) {
  const active = getActiveQuiz(guildId);
  if (!active?.round) {
    await revertPendingRound(guildId);
    return { ok: false, error: 'Quiz round was cancelled before posting.' };
  }

  await updateQuizState((state) => {
    const current = state[guildId];
    if (!current?.round) return true;
    quiz.syncRoundClock(current, prep.question);
    return true;
  });

  const synced = getActiveQuiz(guildId);
  const payload = quiz.assembleQuestionPayload(prep.question, synced, prep.media);

  let message;
  try {
    message = await sendChannelMessage(synced.channelId, payload);
  } catch (err) {
    await revertPendingRound(guildId);

    if (isChannelUnavailableError(err)) {
      await abortQuiz(guildId, 'missing access when posting round');
      return {
        ok: false,
        error: formatQuizChannelError('I lost access while posting the round, so the quiz ended.'),
      };
    }

    console.error('Failed to post quiz round:', summarizeDiscordError(err));
    scheduleRoundRecovery(guildId);
    return { ok: false, error: 'Could not post this round — retrying shortly.' };
  }

  await updateQuizState((state) => {
    const current = state[guildId];
    if (current?.round) current.round.messageId = message.id;
    return true;
  });

  scheduleRoundEnd(guildId);
  return { ok: true };
}

export async function beginRound(guildId) {
  cancelTimer(betweenRoundTimers, guildId);

  const activeQuiz = getActiveQuiz(guildId);
  if (!activeQuiz) return { ok: false, error: 'No active quiz.' };

  if (activeQuiz.round) {
    if (quiz.isRoundOpen(activeQuiz)) {
      scheduleRoundEnd(guildId);
      return { ok: true };
    }
    await finishRound(guildId);
    return { ok: true };
  }

  const prep = await prepareRoundContent(guildId);
  if (!prep.ok) return prep;
  return publishRound(guildId, prep);
}

export async function startQuiz({
  guildId,
  channelId,
  userId,
  userName,
  gamemode,
  difficulty,
  roundSeconds,
  scoreGoal,
  audio,
  picture,
}) {
  const existing = getActiveQuiz(guildId);
  if (existing) {
    return { ok: false, error: 'A quiz is already running in this server.' };
  }

  const quizGamemode = quiz.normalizeGamemode(gamemode);
  const quizDifficulty = quiz.normalizeDifficulty(difficulty);
  const quizRoundSeconds = quiz.normalizeRoundSeconds(roundSeconds);
  const quizScoreGoal = quiz.normalizeScoreGoal(scoreGoal);
  const allowAudio = quizGamemode === 'umadol' ? true : quiz.parseYesNo(audio, true);
  const allowPicture = quizGamemode === 'umaguesser' || quizGamemode === 'testing'
    ? true
    : quiz.parseYesNo(picture, true);

  const enabled = loadQuizSettings().enabledCategories || [];
  const categories = quiz.getGamemodeCategories(quizGamemode, enabled);
  const questions = quiz.filterSessionQuestions(loadQuizQuestions(categories), {
    gamemode: quizGamemode,
    allowAudio,
    allowPicture,
  });

  if (!questions.length) {
    return {
      ok: false,
      error: `No questions found for **${quiz.getGamemodeLabel(quizGamemode)}** (${categories.join(', ') || 'none'}).`,
    };
  }

  const channelCheck = await validateQuizChannel(channelId);
  if (!channelCheck.ok) {
    return channelCheck;
  }

  await updateQuizState((state) => {
    state[guildId] = quiz.createQuizState({
      guildId,
      channelId,
      startedBy: userId,
      starterName: userName,
      gamemode: quizGamemode,
      difficulty: quizDifficulty,
      roundSeconds: quizRoundSeconds,
      scoreGoal: quizScoreGoal,
      allowAudio,
      allowPicture,
    });
    return true;
  });

  let roleId = null;
  let permissionsWarning = null;
  const roleSetup = getGuildQuizRoleId(guildId)
    .then((resolvedRoleId) => ({ roleId: resolvedRoleId, timedOut: false, err: null }))
    .catch((err) => ({ roleId: null, timedOut: false, err }));
  const roleResult = await Promise.race([
    roleSetup,
    sleep(QUIZ_ROLE_SETUP_TIMEOUT_MS).then(() => ({ roleId: null, timedOut: true, err: null })),
  ]);

  if (roleResult.timedOut) {
    permissionsWarning =
      '⚠️ Quiz started, but quiz notification role setup timed out. ' +
      'Please check bot role permissions if `/quiz notify` does not work.';
    console.warn(`Quiz role setup timed out for guild ${guildId}`);
  } else if (roleResult.err) {
    permissionsWarning =
      '⚠️ Quiz started, but I could not manage the quiz notification role. ' +
      'Please grant me **Manage Roles** (and keep my role above quiz roles) to enable `/quiz notify` pings.';
    console.warn(`Quiz role setup skipped for guild ${guildId}: ${summarizeDiscordError(roleResult.err)}`);
  } else {
    roleId = roleResult.roleId;
  }
  const rolePing = roleId ? `<@&${roleId}>` : '';
  const startMessage =
    `🎯 **Quiz started** by **${userName}** ` +
    `(${quiz.getGamemodeLabel(quizGamemode)} · ${quiz.getDifficultyLabel(quizDifficulty)} · ${quizRoundSeconds}s/round). ` +
    `First to **${quizScoreGoal}** points wins!`;

  await safeChannelSend(
    channelId,
    {
      content: rolePing ? `${rolePing}\n${startMessage}` : startMessage,
      allowed_mentions: roleId ? { roles: [roleId] } : undefined,
    },
    'startQuiz',
  );

  let prepReady = false;
  const prepPromise = prepareRoundContent(guildId).then((result) => {
    prepReady = true;
    return result;
  });
  await runStartCountdown(channelId, quiz.QUIZ_START_COUNTDOWN_SECONDS);

  if (!getActiveQuiz(guildId)) {
    return { ok: false, error: 'Quiz was stopped before the first round.' };
  }

  let loadingMessage = null;
  if (!prepReady) {
    loadingMessage = await safeChannelSend(
      channelId,
      { content: '⏳ Preparing question...' },
      'quiz prepare',
    );
  }

  const resolvedPrep = await prepPromise;
  if (loadingMessage?.id) {
    await deleteChannelMessage(channelId, loadingMessage.id);
  }

  if (!resolvedPrep.ok) return resolvedPrep;
  const published = await publishRound(guildId, resolvedPrep);
  if (!published.ok) return published;
  return permissionsWarning ? { ok: true, warning: permissionsWarning } : published;
}

export async function stopQuiz(guildId, { reason } = {}) {
  const active = getActiveQuiz(guildId);
  if (!active) return { ok: false, error: 'No active quiz in this server.' };

  cancelAllTimers(guildId);
  const lines = quiz.getScoreboardLines(active.scores, { scoreGoal: active.scoreGoal });
  const heading = reason || '⏹️ **Quiz stopped.**';
  await safeChannelSend(
    active.channelId,
    { content: [heading, '', '**Current scoreboard**', ...lines].join('\n') },
    'stopQuiz',
  );
  await clearQuiz(guildId);
  return { ok: true };
}

export async function handleMcqClick({
  guildId,
  userId,
  displayName,
  roundNumber,
  choiceIndex,
}) {
  const userSetup = ensureQuizUser(userId, displayName, guildId);

  const result = await updateQuizState((state) => {
    const active = state[guildId];
    if (!active || active.status !== 'active') {
      return { ok: false, error: 'No active quiz.' };
    }
    if (!active.round || active.round.number !== roundNumber) {
      return { ok: false, error: 'This round has ended.' };
    }
    if (active.round.type !== 'mcq') {
      return { ok: false, error: 'This is not an MCQ round.' };
    }

    const { questions } = loadSessionQuestions(active);
    const question = quiz.getQuestionById(questions, active.round.questionId);
    const answer = quiz.processMcqAnswer(active, question, userId, displayName, choiceIndex);
    return { ...answer, active, question, umaLinked: userSetup.umaLinked };
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  recordQuizAnswer(userId, result.correct);

  let content;
  if (result.correct) {
    const bonus = result.isFirstCorrect
      ? `First correct — **+${quiz.FIRST_POINTS}**!`
      : `Correct — **+${quiz.OTHER_POINTS}**!`;
    content = `✅ ${bonus} (${result.totalPoints} pts total)`;
  } else {
    content = '❌ Wrong answer.';
  }

  if (!result.umaLinked) {
    content += '\n\n⚠️ You are **unlinked** — use `/register` to show club and fan stats on `/profile`.';
  }

  return { ok: true, content, reachedWinTarget: result.reachedWinTarget };
}

export async function resumeActiveQuizzes() {
  const state = loadQuizState();

  for (const guildId of Object.keys(state)) {
    const active = state[guildId];
    if (!active || active.status !== 'active') continue;

    try {
      if (active.round && quiz.isRoundOpen(active)) {
        scheduleRoundEnd(guildId);
        continue;
      }

      if (active.round && !quiz.isRoundOpen(active)) {
        await finishRound(guildId);
        continue;
      }

      if (!active.round) {
        await beginRound(guildId);
      }
    } catch (err) {
      console.error(`Failed to resume quiz for guild ${guildId}:`, summarizeDiscordError(err));
      await abortQuiz(guildId, 'resume failed');
    }
  }
}
