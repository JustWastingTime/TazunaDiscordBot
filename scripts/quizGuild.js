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

const roleSetupLocks = new Map();

function findQuizRoles(roles, roleName) {
  const target = roleName.toLowerCase();
  return roles.filter((item) => item.name.toLowerCase() === target);
}

function pickQuizRole(matches, preferredRoleId = null) {
  if (!matches.length) return null;
  if (preferredRoleId) {
    const saved = matches.find((role) => String(role.id) === String(preferredRoleId));
    if (saved) return saved;
  }
  return [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
}

async function resolveGuildQuizRole(guildId) {
  const existing = loadQuizGuildConfig(guildId);
  const roleName = getQuizRoleName();
  const roles = await getGuildRoles(guildId);
  const matches = findQuizRoles(roles, roleName);

  if (existing?.roleId && roles.some((role) => String(role.id) === String(existing.roleId))) {
    return existing;
  }

  let role = pickQuizRole(matches, existing?.roleId);
  if (matches.length > 1) {
    console.warn(
      `Multiple quiz roles named "${roleName}" in guild ${guildId}; using ${role?.id ?? 'new role'}.`,
    );
  }

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

export async function ensureGuildQuizRole(guildId) {
  const key = String(guildId);
  if (roleSetupLocks.has(key)) {
    return roleSetupLocks.get(key);
  }

  const setup = resolveGuildQuizRole(guildId).finally(() => {
    roleSetupLocks.delete(key);
  });
  roleSetupLocks.set(key, setup);
  return setup;
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
