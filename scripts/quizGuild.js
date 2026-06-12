import { loadQuizSettings, loadQuizGuildConfig, saveQuizGuildConfig } from './quizStorage.js';
import {
  addMemberRole,
  createGuildRole,
  getGuildRoles,
  removeMemberRole,
} from './quizDiscord.js';

export const DEFAULT_QUIZ_ROLE_NAME = 'tazuna-quiz-role';

export function getQuizRoleName() {
  return loadQuizSettings().quizNotificationRole || DEFAULT_QUIZ_ROLE_NAME;
}

export async function ensureGuildQuizRole(guildId) {
  const existing = loadQuizGuildConfig(guildId);
  if (existing?.roleId) {
    return existing;
  }

  const roleName = getQuizRoleName();
  const roles = await getGuildRoles(guildId);
  let role = roles.find((item) => item.name.toLowerCase() === roleName.toLowerCase());

  if (!role) {
    role = await createGuildRole(guildId, roleName);
  }

  const config = {
    roleId: role.id,
    roleName: role.name,
    ensuredAt: new Date().toISOString(),
  };
  await saveQuizGuildConfig(guildId, config);
  return config;
}

export async function getGuildQuizRoleId(guildId) {
  const config = await ensureGuildQuizRole(guildId);
  return config?.roleId ?? null;
}

export async function toggleQuizNotification(guildId, userId, memberRoleIds = []) {
  const config = await ensureGuildQuizRole(guildId);
  if (!config?.roleId) {
    return {
      ok: false,
      error: `Could not create quiz role **${getQuizRoleName()}**. Check that I have **Manage Roles** and my role is high enough.`,
    };
  }

  const hasRole = memberRoleIds.map(String).includes(String(config.roleId));
  try {
    if (hasRole) {
      await removeMemberRole(guildId, userId, config.roleId);
      return { ok: true, enabled: false, roleName: config.roleName || getQuizRoleName() };
    }
    await addMemberRole(guildId, userId, config.roleId);
    return { ok: true, enabled: true, roleName: config.roleName || getQuizRoleName() };
  } catch (err) {
    return {
      ok: false,
      error:
        'Could not update your quiz notification role. Make sure my role is above **tazuna-quiz-role** and I have **Manage Roles**.',
    };
  }
}
