import {
  InteractionResponseFlags,
  InteractionResponseType,
} from 'discord-interactions';
import {
  getGuildClubs,
  getUserLink,
  isPremiumGuild,
  registerGuildClub,
  setGuildPremium,
  unregisterGuildClub,
  upsertLeaderboardChannel,
  upsertUserLink,
} from './clubDatabase.js';
import {
  buildAllLeaderboardPackage,
  buildAllLeaderboardPageButtons,
  buildAllLeaderboardPageResponse,
  buildClubDatasets,
  buildLeaderboardSelectRow,
  buildProfileEmbed,
  buildProfileEmbedForViewerId,
  buildProfileSelectRow,
  buildTrainerRanks,
  fetchCircleData,
  fetchUserProfile,
  findClubsByName,
  findTrainerCandidates,
  buildLeaderboardPackage,
  isAllClubsLeaderboardQuery,
  isTop100Circle,
  resolveLeaderboardFromCircleId,
  resolveProfileFromPick,
} from './clubService.js';
import { DiscordRequest } from './utils.js';

const ADMINISTRATOR = 0x8n;

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

const ALL_CLUBS_AUTOCOMPLETE = { name: 'All Clubs', value: 'all' };
const LB_ALL_PAGE_RE = /^lb_all_(prev|next):([^:]+):([^:]+):(\d+)$/;

function resolveInteractionOptions(req) {
  const data = req.body.data;
  if (data.name === 'club') {
    const subcommand = data.options?.find((opt) => opt.type === 1);
    return subcommand?.options ?? [];
  }
  return data.options ?? [];
}

function getOptionValue(req, name) {
  const value = resolveInteractionOptions(req).find((opt) => opt.name === name)?.value;
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value : String(value);
}

function getBooleanOption(req, name) {
  const value = resolveInteractionOptions(req).find((opt) => opt.name === name)?.value;
  return typeof value === 'boolean' ? value : undefined;
}

function getOptionUserId(req, name) {
  const opt = resolveInteractionOptions(req).find((o) => o.name === name);
  return opt?.value ?? null;
}

export function isGuildAdmin(member) {
  if (!member?.permissions) return false;
  try {
    return (BigInt(member.permissions) & ADMINISTRATOR) === ADMINISTRATOR;
  } catch {
    return false;
  }
}

function ephemeral(content) {
  return {
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: { flags: InteractionResponseFlags.EPHEMERAL, content },
  };
}

function defer(ephemeralReply = false) {
  return {
    type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
    data: ephemeralReply ? { flags: InteractionResponseFlags.EPHEMERAL } : undefined,
  };
}

function guildRequiredResponse() {
  return ephemeral('❌ This command can only be used in a server.');
}

export function resolveAutocompleteFocus(data) {
  const topOptions = data.options ?? [];
  const subcommand = topOptions.find((opt) => opt.type === 1);
  if (subcommand) {
    const focused = subcommand.options?.find((opt) => opt.focused);
    return {
      subcommand: subcommand.name,
      optionName: focused?.name ?? null,
      value: typeof focused?.value === 'string' ? focused.value : '',
    };
  }

  const focused = topOptions.find((opt) => opt.focused);
  return {
    subcommand: null,
    optionName: focused?.name ?? null,
    value: typeof focused?.value === 'string' ? focused.value : '',
  };
}

export function buildRegisteredClubAutocompleteChoices(guildId, rawQuery) {
  if (!guildId) return [];

  const query = rawQuery.trim().toLowerCase();
  const clubs = getGuildClubs(guildId);

  return clubs
    .map((club) => {
      const name = String(club.circleName || club.circleId || '').trim();
      if (!name) return null;
      return { name: name.slice(0, 100), value: name.slice(0, 100) };
    })
    .filter(Boolean)
    .filter((choice) => !query || choice.name.toLowerCase().includes(query))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(query) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(query) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return a.name.localeCompare(b.name);
    })
    .slice(0, 25);
}

export function buildLeaderboardAutocompleteChoices(guildId, rawQuery) {
  if (!guildId) return [];

  const query = rawQuery.trim().toLowerCase();
  const choices = [];

  if (
    !query
    || query === 'all'
    || 'all clubs'.includes(query)
    || 'all clubs'.startsWith(query)
  ) {
    choices.push(ALL_CLUBS_AUTOCOMPLETE);
  }

  const clubChoices = buildRegisteredClubAutocompleteChoices(guildId, rawQuery);
  const seen = new Set(choices.map((choice) => choice.value.toLowerCase()));
  for (const choice of clubChoices) {
    const key = choice.value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(choice);
    if (choices.length >= 25) break;
  }

  return choices.slice(0, 25);
}

function resolveGuildClubFromName(guildId, clubNameArg) {
  const guildClubs = getGuildClubs(guildId);
  if (!guildClubs.length) {
    return {
      error: '❌ No clubs are registered on this server. Run `/club registerclub` first.',
    };
  }

  const matches = findClubsByName(guildClubs, clubNameArg);
  if (!matches.length) {
    return {
      error: `❌ No registered club matching \`${clubNameArg}\` on this server.`,
    };
  }
  if (matches.length > 1) {
    const names = matches.map((club) => club.circleName || club.circleId).join(', ');
    return {
      error:
        `❌ Multiple clubs match \`${clubNameArg}\` (${names}). ` +
        'Pick a more specific name from autocomplete.',
    };
  }

  return { club: matches[0], circleId: String(matches[0].circleId) };
}

export function handleClubComponent(customId, values) {
  if (customId.startsWith('profile_pick:')) {
    const ownerUserId = customId.slice('profile_pick:'.length);
    return { kind: 'profile_pick', value: values?.[0], ownerUserId };
  }
  if (customId.startsWith('leaderboard_pick:')) {
    const ownerUserId = customId.slice('leaderboard_pick:'.length);
    return { kind: 'leaderboard_pick', value: values?.[0], ownerUserId };
  }

  const pageMatch = customId.match(LB_ALL_PAGE_RE);
  if (pageMatch) {
    const [, direction, ownerUserId, guildId, pageStr] = pageMatch;
    const currentPage = Number.parseInt(pageStr, 10) || 0;
    const pageIdx = direction === 'prev' ? currentPage - 1 : currentPage + 1;
    return { kind: 'leaderboard_all_page', ownerUserId, guildId, pageIdx };
  }

  return null;
}

export async function runClubComponentAction(action) {
  if (action.kind === 'profile_pick') {
    const embed = await resolveProfileFromPick(action.value);
    return { embeds: [embed], components: [] };
  }
  if (action.kind === 'leaderboard_pick') {
    const embed = await resolveLeaderboardFromCircleId(action.value);
    return { embeds: [embed], components: [] };
  }
  if (action.kind === 'leaderboard_all_page') {
    const guildClubs = getGuildClubs(action.guildId);
    return buildAllLeaderboardPageResponse(
      guildClubs,
      action.pageIdx,
      action.ownerUserId,
      action.guildId,
    );
  }
  throw new Error('Unknown club component action.');
}

export async function handleRegisterClub(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/club registerclub`.');
  }

  const circleId = String(getOptionValue(req, 'id') ?? '').trim();
  if (!circleId) return ephemeral('❌ Please provide a club ID.');

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const data = await fetchCircleData(circleId);
        const circleName = data?.circle?.name;
        if (!circleName) {
          await sendFollowup({
            flags: InteractionResponseFlags.EPHEMERAL,
            content: `❌ Could not find a club with ID \`${circleId}\` on uma.moe.`,
          });
          return;
        }

        registerGuildClub(guildId, circleId, circleName);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `✅ Registered **${circleName}** (\`${circleId}\`) for this server.`,
        });
      } catch (err) {
        console.error('registerclub failed:', err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ Failed to register club: ${err.message}`,
        });
      }
    },
  };
}

export async function handleUnregisterClub(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/club unregisterclub`.');
  }

  const circleId = String(getOptionValue(req, 'id') ?? '').trim();
  if (!circleId) return ephemeral('❌ Please provide a club ID.');

  const removed = unregisterGuildClub(guildId, circleId);
  if (!removed) {
    return ephemeral(`❌ Club \`${circleId}\` is not registered on this server.`);
  }
  return ephemeral(`✅ Unregistered club \`${circleId}\` from this server.`);
}

export async function handleRegister(req) {
  const accountId = String(getOptionValue(req, 'id') ?? '').trim();
  if (!accountId) return ephemeral('❌ Please provide your trainer account ID.');

  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!userId) return ephemeral('❌ Could not determine your Discord user ID.');

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const profile = await fetchUserProfile(accountId);
        const { isNewUser } = upsertUserLink({
          discordUserId: userId,
          viewerId: profile.viewerId,
          trainerName: profile.trainerName,
          circleId: profile.circleId ?? '',
          circleName: profile.circleName,
        });
        const clubLine = profile.circleName
          ? ` in **${profile.circleName}**`
          : profile.circleId
            ? ` (club ID \`${profile.circleId}\`)`
            : '';
        const gambaLine = isNewUser ? '\n🎰 You received **1,000** starting GambaCoins.' : '';
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content:
            `✅ Linked your Discord account to **${profile.trainerName}**` +
            `${clubLine} (ID \`${profile.viewerId}\`).${gambaLine}`,
        });
      } catch (err) {
        console.error('register failed:', err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ ${err.message}`,
        });
      }
    },
  };
}

export async function handleRegisterForced(req) {
  const guildId = req.body.guild_id;
  if (!guildId) return guildRequiredResponse();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/club registerforced`.');
  }

  const targetUserId = getOptionUserId(req, 'user');
  const viewerId = String(getOptionValue(req, 'id') ?? '').trim();
  if (!targetUserId) return ephemeral('❌ Please mention a user to register.');
  if (!viewerId) return ephemeral('❌ Please provide a trainer ID.');

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const profile = await fetchUserProfile(viewerId);
        const { isNewUser } = upsertUserLink({
          discordUserId: targetUserId,
          viewerId: profile.viewerId,
          trainerName: profile.trainerName,
          circleId: profile.circleId ?? '',
          circleName: profile.circleName,
        });
        const clubLine = profile.circleName
          ? ` in **${profile.circleName}**`
          : profile.circleId
            ? ` (club ID \`${profile.circleId}\`)`
            : '';
        const gambaLine = isNewUser ? '\n🎰 They received **1,000** starting GambaCoins.' : '';
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content:
            `✅ Force-linked <@${targetUserId}> to **${profile.trainerName}**` +
            `${clubLine} (ID \`${profile.viewerId}\`).${gambaLine}`,
        });
      } catch (err) {
        console.error('registerforced failed:', err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ ${err.message}`,
        });
      }
    },
  };
}

export async function handleProfile(req) {
  const userId = req.body.member?.user?.id || req.body.user?.id;
  const guildId = req.body.guild_id ?? null;
  const nameArg = getOptionValue(req, 'name');

  return {
    deferred: true,
    ephemeral: false,
    run: async (sendFollowup) => {
      try {
        if (nameArg) {
          if (!guildId) {
            await sendFollowup({
              content: '❌ Name lookups only work in a server with registered clubs.',
            });
            return;
          }

          const guildClubs = getGuildClubs(guildId);
          if (!guildClubs.length) {
            await sendFollowup({
              content: '❌ No clubs are registered on this server. An admin must run `/club registerclub` first.',
            });
            return;
          }

          const datasets = await buildClubDatasets(guildClubs.map((c) => c.circleId));
          const candidates = findTrainerCandidates(nameArg, datasets);
          if (!candidates.length) {
            await sendFollowup({
              content: `❌ Could not find trainer \`${nameArg}\` in this server's registered clubs.`,
            });
            return;
          }

          if (candidates.length === 1) {
            const selected = candidates[0];
            const ranks = buildTrainerRanks(
              selected.circle,
              selected.members,
              selected.member.viewer_id,
            );
            await sendFollowup({
              embeds: [buildProfileEmbed({
                member: selected.member,
                circle: selected.circle,
                ranks,
              })],
            });
            return;
          }

          await sendFollowup({
            content: `Found multiple matches for \`${nameArg}\`. Choose one:`,
            components: [buildProfileSelectRow(candidates, userId)],
          });
          return;
        }

        const link = getUserLink(userId);
        if (!link) {
          await sendFollowup({
            content:
              'You have not linked a trainer yet. Use `/register` with your uma.moe account ID.',
          });
          return;
        }

        const embed = await buildProfileEmbedForViewerId(link.viewerId, {
          circleIdHint: link.circleId || undefined,
          festa: {
            gambaCoins: link.gambaCoins,
            gambaWr: link.gambaWr,
            quizAccuracy: link.quizAccuracy,
          },
        });
        await sendFollowup({ embeds: [embed] });
      } catch (err) {
        console.error('profile failed:', err);
        await sendFollowup({ content: `❌ Failed: ${err.message}` });
      }
    },
  };
}

export async function handleLeaderboard(req) {
  const userId = req.body.member?.user?.id || req.body.user?.id;
  const guildId = req.body.guild_id ?? null;
  const clubNameArg = getOptionValue(req, 'clubname');

  return {
    deferred: true,
    ephemeral: false,
    run: async (sendFollowup) => {
      try {
        if (clubNameArg) {
          if (!guildId) {
            await sendFollowup({
              content: '❌ Club name lookups only work in a server with registered clubs.',
            });
            return;
          }

          const guildClubs = getGuildClubs(guildId);
          if (!guildClubs.length) {
            await sendFollowup({
              content: '❌ No clubs are registered on this server. An admin must run `/club registerclub` first.',
            });
            return;
          }

          if (isAllClubsLeaderboardQuery(clubNameArg)) {
            const { embeds } = await buildAllLeaderboardPackage(guildClubs);
            const totalPages = embeds.length;
            await sendFollowup({
              embeds: [embeds[0]],
              components:
                totalPages > 1
                  ? [buildAllLeaderboardPageButtons(0, totalPages, userId, guildId)]
                  : [],
            });
            return;
          }

          const matches = findClubsByName(guildClubs, clubNameArg);
          if (!matches.length) {
            await sendFollowup({
              content: `❌ No registered club matching \`${clubNameArg}\` on this server.`,
            });
            return;
          }

          if (matches.length === 1) {
            const embed = await resolveLeaderboardFromCircleId(matches[0].circleId);
            await sendFollowup({ embeds: [embed] });
            return;
          }

          const datasets = await buildClubDatasets(matches.map((c) => c.circleId));
          const circleDataById = new Map(datasets.map((d) => [String(d.circleId), d]));
          await sendFollowup({
            content: `Multiple clubs match \`${clubNameArg}\`. Choose one:`,
            components: [buildLeaderboardSelectRow(matches, circleDataById, userId)],
          });
          return;
        }

        const link = getUserLink(userId);
        if (!link?.circleId) {
          await sendFollowup({
            content:
              'You have not linked a trainer yet. Use `/register`, or specify a club with `/club leaderboard clubname:...`.',
          });
          return;
        }

        const embed = await resolveLeaderboardFromCircleId(link.circleId);
        await sendFollowup({ embeds: [embed] });
      } catch (err) {
        console.error('leaderboard failed:', err);
        await sendFollowup({ content: `❌ Failed: ${err.message}` });
      }
    },
  };
}

function describeRefreshSchedule(guildId, circleData) {
  const top100 = isTop100Circle(circleData?.circle);
  if (!top100) return 'daily at **00:10 JST**';
  return isPremiumGuild(guildId)
    ? 'every **5 minutes** (premium server)'
    : 'every **15 minutes**';
}

export async function handleSetLeaderboardChannel(req) {
  const guildId = req.body.guild_id;
  const channelId = req.body.channel_id;
  if (!guildId) return guildRequiredResponse();
  if (!isGuildAdmin(req.body.member)) {
    return ephemeral('❌ Only server administrators can use `/club setleaderboardchannel`.');
  }

  const clubNameArg = String(getOptionValue(req, 'clubname') ?? '').trim();
  if (!clubNameArg) return ephemeral('❌ Please provide a club name.');

  const resolved = resolveGuildClubFromName(guildId, clubNameArg);
  if (resolved.error) return ephemeral(resolved.error);

  const { circleId } = resolved;

  return {
    deferred: true,
    ephemeral: true,
    run: async (sendFollowup) => {
      try {
        const pkg = await buildLeaderboardPackage(circleId);
        const response = await DiscordRequest(`channels/${channelId}/messages`, {
          method: 'POST',
          body: { embeds: [pkg.embed] },
        });
        const message = await response.json();

        upsertLeaderboardChannel({
          guildId,
          circleId,
          channelId,
          messageId: message.id,
        });

        const schedule = describeRefreshSchedule(guildId, pkg.data);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content:
            `✅ Leaderboard posted in <#${channelId}> for **${pkg.data.circle?.name ?? circleId}**. ` +
            `It will auto-update ${schedule}.`,
        });
      } catch (err) {
        console.error('setleaderboardchannel failed:', err);
        await sendFollowup({
          flags: InteractionResponseFlags.EPHEMERAL,
          content: `❌ Failed to set leaderboard channel: ${err.message}`,
        });
      }
    },
  };
}

export async function handleSetPremium(req) {
  const guildId = req.body.guild_id;
  const userId = req.body.member?.user?.id || req.body.user?.id;
  if (!guildId) return guildRequiredResponse();
  if (!userId || !BOT_OWNER_IDS.has(userId)) {
    return ephemeral('❌ Only the bot owner can use `/club setpremium`.');
  }

  const enabled = getBooleanOption(req, 'enabled');
  if (typeof enabled !== 'boolean') {
    return ephemeral('❌ Please choose whether premium is enabled or disabled.');
  }

  setGuildPremium(guildId, enabled);
  return ephemeral(
    enabled
      ? '✅ This server now has **premium** leaderboard refresh (top-100 clubs update every 5 minutes).'
      : '✅ Premium leaderboard refresh removed. Top-100 clubs on this server will update every 15 minutes.',
  );
}

function resolveClubSubcommand(req) {
  if (req.body.data.name !== 'club') return req.body.data.name;
  return req.body.data.options?.find((opt) => opt.type === 1)?.name ?? null;
}

export function dispatchClubCommand(name, req) {
  const subcommand = name === 'club' ? resolveClubSubcommand(req) : name;

  switch (subcommand) {
    case 'registerclub':
      return handleRegisterClub(req);
    case 'unregisterclub':
      return handleUnregisterClub(req);
    case 'register':
      return handleRegister(req);
    case 'registerforced':
      return handleRegisterForced(req);
    case 'profile':
      return handleProfile(req);
    case 'leaderboard':
      return handleLeaderboard(req);
    case 'setleaderboardchannel':
      return handleSetLeaderboardChannel(req);
    case 'setpremium':
      return handleSetPremium(req);
    default:
      return null;
  }
}

export function isClubCommand(name) {
  return name === 'club' || name === 'register' || name === 'profile';
}
