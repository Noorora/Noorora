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

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimText(text, maxLength = 800) {
    const body = text?.trim() || '';

    if (body.length <= maxLength) {
        return body || '（本文なし）';
    }

    return `${body.slice(0, maxLength)}\n...（長文のため省略）`;
}

async function canForwardMessage(message, context) {
    const { client, kv } = context;

    if (!message.guild) return false;
    if (!message.author) return false;
    if (message.author.id === client.user.id) return false;

    const channelAllowedBotIds = await kv.sMembers(
        forwardAllowedBotsKey(message.guildId, message.channelId),
    );

    const serverAllowedBotIds = await kv.sMembers(
        forwardAllowedBotsKey(message.guildId, FORWARD_ALL_CHANNELS),
    );

    const allowedBotIds = [
        ...(channelAllowedBotIds || []),
        ...(serverAllowedBotIds || []),
    ];

    const channelAllowedWebhookIds = await kv.sMembers(
        forwardAllowedWebhooksKey(message.guildId, message.channelId),
    );

    const serverAllowedWebhookIds = await kv.sMembers(
        forwardAllowedWebhooksKey(message.guildId, FORWARD_ALL_CHANNELS),
    );

    const allowedWebhookIds = [
        ...(channelAllowedWebhookIds || []),
        ...(serverAllowedWebhookIds || []),
    ];

    if (message.webhookId) {
        return allowedWebhookIds.includes(message.webhookId);
    }

    if (message.author.bot) {
        return allowedBotIds.includes(message.author.id);
    }

    return true;
}

async function getForwardWebhookUrls(message, context) {
    const { kv } = context;

    const channelWebhookUrls = await kv.sMembers(
        forwardWebhookTargetsKey(message.guildId, message.channelId),
    );

    const excludedChannelIds = await kv.sMembers(
        forwardExcludeChannelsKey(message.guildId),
    );

    const isExcludedForServerForward = excludedChannelIds.includes(
        message.channelId,
    );

    const serverWebhookUrls = isExcludedForServerForward
        ? []
        : await kv.sMembers(
            forwardWebhookTargetsKey(message.guildId, FORWARD_ALL_CHANNELS),
        );

    return [
        ...new Set([
            ...(channelWebhookUrls || []),
            ...(serverWebhookUrls || []),
        ]),
    ];
}

async function buildWebhookProfile(message) {
    const displayName =
        message.member?.displayName ||
        message.author.globalName ||
        message.author.username;

    const authorMember =
        message.member ||
        await message.guild.members.fetch(message.author.id).catch(() => null);

    const newcomerMarkForName = buildNewcomerMark(authorMember).trim();

    const webhookDisplayName = newcomerMarkForName
        ? `${newcomerMarkForName} ${displayName}`
        : displayName;

    const webhookUsername =
        `${webhookDisplayName} | #${message.channel.name || message.channelId}`
            .slice(0, 80);

    const avatarURL =
        message.member?.displayAvatarURL({ extension: 'png', size: 128 }) ||
        message.author.displayAvatarURL({ extension: 'png', size: 128 });

    return {
        webhookUsername,
        avatarURL,
    };
}

async function sendToForwardWebhooks(webhookUrls, payload) {
    for (const webhookUrl of webhookUrls) {
        const webhookClient = new WebhookClient({
            url: webhookUrl,
        });

        await webhookClient.send(payload);
    }
}

async function findForwardedMessageLink(client, webhookUrl, originalMessageUrl, maxFetch = 500) {
    const webhookResponse = await fetch(webhookUrl).catch(() => null);

    if (!webhookResponse || !webhookResponse.ok) {
        return null;
    }

    const webhook = await webhookResponse.json().catch(() => null);

    if (!webhook || !webhook.channel_id) {
        return null;
    }

    const targetChannel = await client.channels.fetch(webhook.channel_id).catch(() => null);

    if (!targetChannel || typeof targetChannel.messages?.fetch !== 'function') {
        return null;
    }

    let before;
    let fetchedCount = 0;

    while (fetchedCount < maxFetch) {
        const limit = Math.min(100, maxFetch - fetchedCount);
        const options = { limit };

        if (before) {
            options.before = before;
        }

        const batch = await targetChannel.messages.fetch(options).catch(() => null);

        if (!batch || batch.size === 0) {
            break;
        }

        const found = [...batch.values()].find((targetMessage) => {
            return targetMessage.content?.includes(originalMessageUrl);
        });

        if (found) {
            return found.url;
        }

        const lastMessage = batch.last();

        if (!lastMessage) {
            break;
        }

        before = lastMessage.id;
        fetchedCount += batch.size;

        if (batch.size < limit) {
            break;
        }

        await sleep(150);
    }

    return null;
}

async function handleForwardRelay(message, context) {
    try {
        if (!await canForwardMessage(message, context)) return;

        const uniqueWebhookUrls = await getForwardWebhookUrls(message, context);
        if (uniqueWebhookUrls.length === 0) return;

        let body = message.content?.trim() || '';
        body = await normalizeCustomEmojiText(message, body);
        body = `${body}${body ? '\n' : ''}${message.url}`;

        const files = message.attachments.size > 0
            ? [...message.attachments.values()].map((attachment) => ({
                attachment: attachment.url,
                name: attachment.name || 'attachment',
            }))
            : [];

        const {
            webhookUsername,
            avatarURL,
        } = await buildWebhookProfile(message);

        await sendToForwardWebhooks(uniqueWebhookUrls, {
            content: body || undefined,
            username: webhookUsername,
            avatarURL,
            files,
            allowedMentions: {
                parse: [],
            },
        });
    } catch (error) {
        console.error('Webhook転送でエラー:', error);
    }
}

async function handleForwardEditRelay(oldMessage, newMessage, context) {
    try {
        const { client } = context;

        if (newMessage?.partial) {
            newMessage = await newMessage.fetch().catch(() => null);
        }

        if (oldMessage?.partial) {
            oldMessage = await oldMessage.fetch().catch(() => oldMessage);
        }

        if (!newMessage) return;
        if (!newMessage.guild) return;
        if (!newMessage.author) return;

        if (!await canForwardMessage(newMessage, context)) return;

        const oldContent = oldMessage?.content ?? '';
        const newContent = newMessage.content ?? '';

        // 本文が変わっていない編集は無視
        // リンクプレビュー更新や埋め込み更新などのノイズ対策
        if (oldContent === newContent) return;

        const uniqueWebhookUrls = await getForwardWebhookUrls(newMessage, context);
        if (uniqueWebhookUrls.length === 0) return;

        let afterText = trimText(newContent);
        afterText = await normalizeCustomEmojiText(newMessage, afterText);

        const {
            webhookUsername,
            avatarURL,
        } = await buildWebhookProfile(newMessage);

        const editWebhookUsername = `✏️ ${webhookUsername}`.slice(0, 80);

        for (const webhookUrl of uniqueWebhookUrls) {
            const forwardedMessageLink = await findForwardedMessageLink(
                client,
                webhookUrl,
                newMessage.url,
            );

            const sourceLink = `${newMessage.url}`;

            const beforeLink = forwardedMessageLink
                ? `${forwardedMessageLink}`
                : '＜編集前へ: 見つかりませんでした＞';

            const content = [
                afterText,
                `${sourceLink} ${beforeLink}`,
            ].join('\n');

            const webhookClient = new WebhookClient({
                url: webhookUrl,
            });

            await webhookClient.send({
                content,
                username: editWebhookUsername,
                avatarURL,
                allowedMentions: {
                    parse: [],
                },
            });
        }
    } catch (error) {
        console.error('Webhook編集通知でエラー:', error);
    }
}

module.exports = {
    handleForwardRelay,
    handleForwardEditRelay,
};