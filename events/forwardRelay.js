const { WebhookClient } = require('discord.js');
const { FORWARD_ALL_CHANNELS } = require('../config/constants');
const { normalizeCustomEmojiText } = require('../utils/emoji');
const { buildNewcomerMark } = require('../utils/member');
const {
    forwardWebhookTargetsKey,
    forwardAllowedBotsKey,
    forwardAllowedWebhooksKey,
    forwardExcludeChannelsKey,
} = require('../keys/redisKeys');

async function handleForwardRelay(message, context) {
    const { client, kv } = context;

    try {
        if (!message.guild) return;
        if (message.author.id === client.user.id) return;

        const channelAllowedBotIds = await kv.sMembers(forwardAllowedBotsKey(message.guildId, message.channelId));
        const serverAllowedBotIds = await kv.sMembers(forwardAllowedBotsKey(message.guildId, FORWARD_ALL_CHANNELS));
        const allowedBotIds = [...(channelAllowedBotIds || []), ...(serverAllowedBotIds || [])];

        const channelAllowedWebhookIds = await kv.sMembers(forwardAllowedWebhooksKey(message.guildId, message.channelId));
        const serverAllowedWebhookIds = await kv.sMembers(forwardAllowedWebhooksKey(message.guildId, FORWARD_ALL_CHANNELS));
        const allowedWebhookIds = [...(channelAllowedWebhookIds || []), ...(serverAllowedWebhookIds || [])];

        if (message.webhookId) {
            if (!allowedWebhookIds.includes(message.webhookId)) return;
        } else if (message.author.bot) {
            if (!allowedBotIds.includes(message.author.id)) return;
        }

        const channelWebhookUrls = await kv.sMembers(forwardWebhookTargetsKey(message.guildId, message.channelId));
        const excludedChannelIds = await kv.sMembers(forwardExcludeChannelsKey(message.guildId));
        const isExcludedForServerForward = excludedChannelIds.includes(message.channelId);
        const serverWebhookUrls = isExcludedForServerForward
            ? []
            : await kv.sMembers(forwardWebhookTargetsKey(message.guildId, FORWARD_ALL_CHANNELS));

        const uniqueWebhookUrls = [...new Set([...(channelWebhookUrls || []), ...(serverWebhookUrls || [])])];
        if (uniqueWebhookUrls.length === 0) return;

        let body = message.content?.trim() || '';
        body = await normalizeCustomEmojiText(message, body);
        body = `${body}${body ? '\n' : ''}[<元投稿へ>](${message.url})`;

        const files = message.attachments.size > 0
            ? [...message.attachments.values()].map((attachment) => ({
                attachment: attachment.url,
                name: attachment.name || 'attachment',
            }))
            : [];

        const displayName =
            message.member?.displayName ||
            message.author.globalName ||
            message.author.username;
        const authorMember = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
        const newcomerMarkForName = buildNewcomerMark(authorMember).trim();
        const webhookDisplayName = newcomerMarkForName
            ? `${newcomerMarkForName} ${displayName}`
            : displayName;
        const webhookUsername = `${webhookDisplayName} | #${message.channel.name || message.channelId}`.slice(0, 80);
        const avatarURL =
            message.member?.displayAvatarURL({ extension: 'png', size: 128 }) ||
            message.author.displayAvatarURL({ extension: 'png', size: 128 });

        for (const webhookUrl of uniqueWebhookUrls) {
            const webhookClient = new WebhookClient({ url: webhookUrl });
            await webhookClient.send({
                content: body || undefined,
                username: webhookUsername,
                avatarURL,
                files,
                allowedMentions: {
                    parse: [],
                },
            });
        }
    } catch (error) {
        console.error('Webhook転送でエラー:', error);
    }
}

module.exports = {
    handleForwardRelay,
};
