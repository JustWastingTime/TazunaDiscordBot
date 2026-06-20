import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import { isGuildAdmin } from './clubHandlers.js';
import { ensureGuildQuizRole, toggleQuizNotification } from './quizGuild.js';
import * as quiz from './quizService.js';
import {
  beginRound,
  cancelAllTimers,
  finishRound,
  handleMcqClick,
  startQuiz,
  stopQuiz,
} from './quizRunner.js';

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function guildRequiredResponse() {
  return ephemeral('❌ This command can only be used in a server.');
}

function getSubcommand(req) {
  return req.body.data.options?.find((opt) => opt.type === 1)?.name ?? null;
}

function getSubcommandOptions(req) {
  const subcommand = req.body.data.options?.find((opt) => opt.type === 1);
  return subcommand?.options ?? [];
}

function getOptionValue(req, name) {
  const value = getSubcommandOptions(req).find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return value;
}

const QUIZ_START_TIMEOUT_MS = 90_000;

async function withTimeout(task, timeoutMs, timeoutMessage) {
  let timer = null;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureQuizGuildSetup(guildId) {
  if (!guildId) return;
  try {
    await ensureGuildQuizRole(guildId);
  } catch (err) {
    console.warn(`Failed to ensure quiz role for guild ${guildId}:`, err.message);
  }
}

export async function handleQuizStart(req) {
  const guildId = req.body.guild_id;
  const channelId = req.body.channel_id;
  if (!guildId || !channelId) return guildRequiredResponse();

  const userId = req.body.member?.user?.id || req.body.user?.id;
  const userName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';

  const gamemode = getOptionValue(req, 'mode') ?? quiz.DEFAULT_GAMEMODE;
  const timer = getOptionValue(req, 'timer');
  const difficulty = getOptionValue(req, 'difficulty');
  const scoregoal = getOptionValue(req, 'scoregoal');
  const audio = getOptionValue(req, 'audio') ?? 'yes';
  const picture = getOptionValue(req, 'picture') ?? 'yes';

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const result = await withTimeout(
          startQuiz({
            guildId,
            channelId,
            userId,
            userName,
            gamemode,
            difficulty,
            roundSeconds: timer,
            scoreGoal: scoregoal,
            audio,
            picture,
          }),
          QUIZ_START_TIMEOUT_MS,
          'Quiz start timed out while preparing the first round. Please try `/quiz start` again.',
        );

        if (!result.ok) {
          await sendFollowup({
            flags: InteractionResponseFlags.EPHEMERAL,
            content: `❌ ${result.error}`,
          });
          return;
        }

        await sendFollowup({
          content: result.warning
            ? `✅ Quiz started!\n\n${result.warning}`
            : '✅ Quiz started!',
        });
      } catch (err) {
        console.error('quiz start failed:', err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ Failed to start quiz: ${err.message}`,
        });
      }
    },
  };
}

export async function handleQuizStop(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/quiz stop`.');
  }

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      const result = await stopQuiz(guildId);
      await sendFollowup({
        flags: InteractionResponseFlags.EPHEMERAL,
        content: result.ok ? '✅ Quiz stopped.' : `❌ ${result.error}`,
      });
    },
  };
}

export async function handleQuizNotify(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!guildId || !userId) return guildRequiredResponse();

  try {
    const memberRoles = req.body.member?.roles ?? [];
    const result = await toggleQuizNotification(guildId, userId, memberRoles);
    if (!result.ok) return ephemeral(`❌ ${result.error}`);
    return ephemeral(
      result.enabled
        ? `✅ You will be pinged for quizzes via **${result.roleName}**.`
        : `✅ Quiz notifications removed (**${result.roleName}**).`,
    );
  } catch (err) {
    console.error('quiz notify failed:', err);
    return ephemeral(`❌ Failed to update notifications: ${err.message}`);
  }
}

export function handleQuizAnswerComponent(customId) {
  const match = customId.match(/^quiz-answer:([^:]+):(\d+):(\d+)$/);
  if (!match) return null;
  return {
    guildId: match[1],
    roundNumber: Number.parseInt(match[2], 10),
    choiceIndex: Number.parseInt(match[3], 10),
  };
}

export async function handleQuizAnswer(req, parsed) {
  const userId = req.body.member?.user?.id || req.body.user?.id;
  const displayName = req.body.member?.display_name || req.body.member?.user?.username || 'Trainer';

  const result = await handleMcqClick({
    guildId: parsed.guildId,
    userId,
    displayName,
    roundNumber: parsed.roundNumber,
    choiceIndex: parsed.choiceIndex,
  });

  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: InteractionResponseFlags.EPHEMERAL,
      content: result.ok ? result.content : `❌ ${result.error}`,
    },
  };
}

export function dispatchQuizCommand(req) {
  const subcommand = getSubcommand(req);
  switch (subcommand) {
    case 'start':
      return handleQuizStart(req);
    case 'stop':
      return handleQuizStop(req);
    case 'notify':
      return handleQuizNotify(req);
    default:
      return null;
  }
}

export function isQuizCommand(name) {
  return name === 'quiz';
}

export { cancelAllTimers, beginRound, finishRound };
