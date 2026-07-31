import { createGuildRole, getGuildRoles } from './quizDiscord.js';

export const TAZUNA_ADMIN_ROLE_NAME = 'tazuna-admin-role';

const BOT_OWNER_IDS = new Set(
  String(process.env.BOT_OWNER_IDS || process.env.BOT_OWNER_ID || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
);

const roleSetupLocks = new Map();

export function isBotOwner(userId) {
  return Boolean(userId && BOT_OWNER_IDS.has(String(userId)));
}

export function tazunaAdminDenied(actionLabel) {
  if (actionLabel) {
    return `❌ You need the **${TAZUNA_ADMIN_ROLE_NAME}** role to ${actionLabel}.`;
  }
  return `❌ You need the **${TAZUNA_ADMIN_ROLE_NAME}** role to do that.`;
}

async function resolveTazunaAdminRole(guildId) {
  const roles = await getGuildRoles(guildId);
  const target = TAZUNA_ADMIN_ROLE_NAME.toLowerCase();
  const matches = roles.filter((role) => String(role.name || '').toLowerCase() === target);

  let role = matches[0] ?? null;
  if (matches.length > 1) {
    role = [...matches].sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    console.warn(
      `Multiple roles named "${TAZUNA_ADMIN_ROLE_NAME}" in guild ${guildId}; using ${role.id}.`,
    );
  }

  if (!role) {
    role = await createGuildRole(guildId, TAZUNA_ADMIN_ROLE_NAME, 'Tazuna admin access');
  }

  return {
    roleId: String(role.id),
    roleName: role.name || TAZUNA_ADMIN_ROLE_NAME,
  };
}

/** Ensure **tazuna-admin-role** exists in the guild (create if missing). */
export async function ensureTazunaAdminRole(guildId) {
  const key = String(guildId);
  if (roleSetupLocks.has(key)) {
    return roleSetupLocks.get(key);
  }

  const setup = resolveTazunaAdminRole(guildId).finally(() => {
    roleSetupLocks.delete(key);
  });
  roleSetupLocks.set(key, setup);
  return setup;
}

/** True if the member has **tazuna-admin-role** (role is auto-created if missing). */
export async function hasTazunaAdminRole(guildId, member) {
  if (!guildId || !member) return false;

  try {
    const { roleId } = await ensureTazunaAdminRole(guildId);
    const roles = Array.isArray(member.roles) ? member.roles.map(String) : [];
    return roles.includes(String(roleId));
  } catch (err) {
    console.error(`[adminRole] ensure/check failed for guild ${guildId}:`, err.message);
    return false;
  }
}

/**
 * Staff gate used by club/application/admin commands.
 * @param {{ allowBotOwner?: boolean, userId?: string }} [opts]
 */
export async function isTazunaAdmin(guildId, member, opts = {}) {
  const userId = opts.userId ?? member?.user?.id;
  if (opts.allowBotOwner && isBotOwner(userId)) return true;
  return hasTazunaAdminRole(guildId, member);
}
