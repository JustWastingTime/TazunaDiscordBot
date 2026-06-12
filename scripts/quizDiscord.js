import 'dotenv/config';

async function discordFetch(endpoint, options = {}) {
  const url = `https://discord.com/api/v10/${endpoint}`;
  const headers = {
    Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
    ...options.headers,
  };
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json; charset=UTF-8';
  }

  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.stringify(JSON.parse(detail));
    } catch {
      // keep text
    }
    throw new Error(detail || `Discord API ${res.status}`);
  }

  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
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
