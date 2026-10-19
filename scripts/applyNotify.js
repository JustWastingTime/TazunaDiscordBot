const WEBHOOK_PATTERN = /^https:\/\/(?:discord\.com|discordapp\.com)\/api\/webhooks\/\d+\/[\w.-]+\/?$/;

export function isDiscordWebhookUrl(value) {
  return WEBHOOK_PATTERN.test(String(value || '').trim());
}

export async function notifyApplicationWebhook(webhookUrl, input) {
  const url = String(webhookUrl || '').trim();
  if (!url || !isDiscordWebhookUrl(url)) return { sent: false, reason: 'not_configured' };
  const clubs = (input.clubNames || []).filter(Boolean);
  const fields = [
    { name: 'IGN', value: String(input.ign || 'Unknown'), inline: true },
    { name: 'Discord', value: String(input.discordUsername || '—'), inline: true },
    { name: 'Uma ID', value: `\`${input.umaId}\``, inline: true },
    { name: 'Daily average', value: Number(input.dailyAverage || 0).toLocaleString('en-US'), inline: true },
    { name: 'Monthly gain', value: Number(input.monthlyGain || 0).toLocaleString('en-US'), inline: true },
    { name: 'Current club', value: String(input.currentClubName || 'Unattached'), inline: true },
  ];
  if (input.notes) fields.push({ name: 'Notes', value: String(input.notes).slice(0, 900), inline: false });
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Club applications',
        embeds: [{
          title: 'New club application',
          description: clubs.length
            ? `**${input.ign}** applied to **${clubs.join(', ')}**.`
            : `**${input.ign}** sent an application.`,
          color: 0xe57a9b,
          fields,
          url: `https://uma.moe/profile/${encodeURIComponent(input.umaId)}`,
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('Application webhook failed', response.status, body.slice(0, 300));
      return { sent: false, reason: 'http_error' };
    }
    return { sent: true };
  } catch (error) {
    console.error('Application webhook error', error.message);
    return { sent: false, reason: 'exception' };
  }
}
