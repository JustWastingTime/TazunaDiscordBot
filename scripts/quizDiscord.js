import 'dotenv/config';

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 25_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(res) {
  const header = res.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number.parseFloat(header);
  if (!Number.isFinite(seconds)) return null;
  return Math.max(0, Math.ceil(seconds * 1000));
}

export function isTransientDiscordError(err) {
  const status = err?.status;
  if (status && RETRYABLE_STATUSES.has(status)) return true;

  const message = String(err?.message || err || '');
  if (/gateway time-out/i.test(message)) return true;
  if (/"code":\s*(429|500|502|503|504)/.test(message)) return true;
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return true;
  return false;
}

export function summarizeDiscordError(err) {
  const status = err?.status;
  if (status === 504 || /gateway time-out/i.test(String(err?.message || ''))) {
    return 'Discord gateway timeout (504)';
  }
  const message = String(err?.message || err || 'Unknown Discord error');
  if (message.startsWith('<!DOCTYPE html>') || message.includes('cf-error-details')) {
    return status ? `Discord HTTP ${status}` : 'Discord gateway error';
  }
  return message.length > 240 ? `${message.slice(0, 240)}…` : message;
}

async function discordFetch(endpoint, options = {}) {
  const url = `https://discord.com/api/v10/${endpoint}`;
  const headers = {
    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    ...options.headers,
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        let detail = await res.text();
        try {
          detail = JSON.stringify(JSON.parse(detail));
        } catch {
          // keep text
        }
        const error = new Error(detail || `Discord API ${res.status}`);
        error.status = res.status;
        lastError = error;

        if (!RETRYABLE_STATUSES.has(res.status) || attempt === MAX_ATTEMPTS) {
          throw error;
        }

        const delay = parseRetryAfterMs(res) ?? 1000 * attempt;
        console.warn(
          `Discord ${res.status} on ${endpoint} — retry ${attempt}/${MAX_ATTEMPTS} in ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      if (res.status === 204) return null;
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (err) {
      lastError = err;
      const transient = isTransientDiscordError(err);
      if (!transient || attempt === MAX_ATTEMPTS) {
        throw err;
      }

      const delay = 1000 * attempt;
      console.warn(
        `Discord request failed on ${endpoint} — retry ${attempt}/${MAX_ATTEMPTS} in ${delay}ms (${summarizeDiscordError(err)})`,
      );
      await sleep(delay);
    }
  }

  throw lastError || new Error(`Discord request failed: ${endpoint}`);
}

function buildMessageBody(payload) {
  const { files, ...json } = payload;
  return { json, files: files || [] };
}

export async function sendChannelMessage(channelId, payload) {
  const { json, files } = buildMessageBody(payload);

  if (files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(json));
    files.forEach((file, index) => {
      form.append(
        `files[${index}]`,
        new Blob([file.buffer], { type: file.mime || 'application/octet-stream' }),
        file.filename,
      );
    });
    return discordFetch(`channels/${channelId}/messages`, { method: 'POST', body: form });
  }

  return discordFetch(`channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(json),
  });
}

export async function editChannelMessage(channelId, messageId, payload) {
  const { json, files } = buildMessageBody(payload);

  if (files.length) {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(json));
    files.forEach((file, index) => {
      form.append(
        `files[${index}]`,
        new Blob([file.buffer], { type: file.mime || 'application/octet-stream' }),
        file.filename,
      );
    });
    return discordFetch(`channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: form });
  }

  return discordFetch(`channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(json),
  });
}

export async function deleteChannelMessage(channelId, messageId) {
  try {
    await discordFetch(`channels/${channelId}/messages/${messageId}`, { method: 'DELETE' });
  } catch {
    // Ignore delete failures.
  }
}

export async function getGuildRoles(guildId) {
  return discordFetch(`guilds/${guildId}/roles`, { method: 'GET' });
}

export async function createGuildRole(guildId, name) {
  return discordFetch(`guilds/${guildId}/roles`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      mentionable: true,
      reason: 'Tazuna quiz notifications',
    }),
  });
}

export async function addMemberRole(guildId, userId, roleId) {
  await discordFetch(`guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: 'PUT',
    body: null,
  });
}

export async function removeMemberRole(guildId, userId, roleId) {
  await discordFetch(`guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: 'DELETE',
  });
}
