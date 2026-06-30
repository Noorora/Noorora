const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { FORWARD_ALL_CHANNELS } = require('../config/constants');
const {
    forwardWebhookTargetsKey,
    forwardWebhookIndexKey,
    forwardAllowedBotsKey,
    forwardAllowedWebhooksKey,
    forwardExcludeChannelsKey,
} = require('../keys/redisKeys');

async function execute(interaction, context) {
    const { kv } = context;
    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand();

    if (group === 'exclude') {
        await handleExclude(interaction, kv, sub);
        return;
    }

    if (group === 'allow') {
        await handleAllow(interaction, kv, sub);
        return;
    }

    if (sub === 'set') {
        const sourceChannel = interaction.options.getChannel('source_channel', false);
        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;
        const targetWebhookUrl = interaction.options.getString('target_webhook_url', true).trim();

        if (!targetWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
            await interaction.reply(ephemeralOptions({ content: 'Webhook URL の形式が正しくありません。' }));
            return;
        }

        await kv.sAdd(forwardWebhookTargetsKey(interaction.guildId, sourceChannelId), targetWebhookUrl);
        await kv.sAdd(forwardWebhookIndexKey(interaction.guildId), sourceChannelId);

        await interaction.reply(ephemeralOptions({
            content:
                `転送設定を登録しました。\n` +
                `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n` +
                `転送先: Webhook URL`,
        }));
        return;
    }

    if (sub === 'show') {
        await handleShow(interaction, kv);
        return;
    }

    if (sub === 'unset') {
        const sourceChannel = interaction.options.getChannel('source_channel', false);
        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;
        const targetWebhookUrl = interaction.options.getString('target_webhook_url', true).trim();

        const removed = await kv.sRem(forwardWebhookTargetsKey(interaction.guildId, sourceChannelId), targetWebhookUrl);
        if (!removed) {
            await interaction.reply(ephemeralOptions({
                content: `${sourceChannel ? `転送元 <#${sourceChannel.id}>` : 'サーバー全体転送'} の指定Webhook設定は見つかりませんでした。`,
            }));
            return;
        }

        const remainingTargets = await kv.sMembers(forwardWebhookTargetsKey(interaction.guildId, sourceChannelId));
        if (!remainingTargets || remainingTargets.length === 0) {
            await kv.del(forwardWebhookTargetsKey(interaction.guildId, sourceChannelId));
            await kv.sRem(forwardWebhookIndexKey(interaction.guildId), sourceChannelId);
        }

        await interaction.reply(ephemeralOptions({
            content:
                `転送設定を削除しました。\n` +
                `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}`,
        }));
    }
}

async function handleExclude(interaction, kv, sub) {
    if (sub === 'add') {
        const channel = interaction.options.getChannel('channel', true);
        await kv.sAdd(forwardExcludeChannelsKey(interaction.guildId), channel.id);
        await interaction.reply(ephemeralOptions({ content: `鯖全体転送の除外チャンネルに追加しました。\n除外: <#${channel.id}>` }));
        return;
    }

    if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel', true);
        const removed = await kv.sRem(forwardExcludeChannelsKey(interaction.guildId), channel.id);
        await interaction.reply(ephemeralOptions({
            content: removed
                ? `鯖全体転送の除外チャンネルから削除しました。\n解除: <#${channel.id}>`
                : `そのチャンネルは除外一覧にありませんでした。\n対象: <#${channel.id}>`,
        }));
        return;
    }

    if (sub === 'show') {
        const channelIds = await kv.sMembers(forwardExcludeChannelsKey(interaction.guildId));
        if (!channelIds || channelIds.length === 0) {
            await interaction.reply(ephemeralOptions({ content: '鯖全体転送の除外チャンネルはありません。' }));
            return;
        }

        const lines = channelIds.map((id, index) => `${index + 1}. <#${id}> (${id})`);
        const chunks = splitLinesToMessages('鯖全体転送の除外チャンネル一覧:\n', lines);
        await interaction.reply(ephemeralOptions({ content: chunks[0] }));
        for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
    }
}

async function handleAllow(interaction, kv, sub) {
    const sourceChannel = interaction.options.getChannel('source_channel', false);
    const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;
    const type = interaction.options.getString('type', true);
    const id = interaction.options.getString('id', true).trim();

    if (!/^\d{17,20}$/.test(id)) {
        await interaction.reply(ephemeralOptions({ content: 'IDの形式が正しくありません。17〜20桁程度のDiscord IDを指定してください。' }));
        return;
    }

    const keyFactory = type === 'bot' ? forwardAllowedBotsKey : forwardAllowedWebhooksKey;
    if (!['bot', 'webhook'].includes(type)) {
        await interaction.reply(ephemeralOptions({ content: 'type は `bot` または `webhook` を指定してください。' }));
        return;
    }

    if (sub === 'add') {
        await kv.sAdd(keyFactory(interaction.guildId, sourceChannelId), id);
        await interaction.reply(ephemeralOptions({
            content:
                `転送許可${type === 'bot' ? 'Bot' : 'Webhook'}を追加しました。\n` +
                `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n` +
                `${type === 'bot' ? 'Bot' : 'Webhook'} ID: ${id}`,
        }));
        return;
    }

    if (sub === 'remove') {
        const removed = await kv.sRem(keyFactory(interaction.guildId, sourceChannelId), id);
        await interaction.reply(ephemeralOptions({
            content: removed
                ? `転送許可${type === 'bot' ? 'Bot' : 'Webhook'}を削除しました。\n転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n${type === 'bot' ? 'Bot' : 'Webhook'} ID: ${id}`
                : `転送元 ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'} の許可一覧に ${id} はありませんでした。`,
        }));
    }
}

async function handleShow(interaction, kv) {
    const sourceChannelIds = await kv.sMembers(forwardWebhookIndexKey(interaction.guildId));
    if (!sourceChannelIds || sourceChannelIds.length === 0) {
        await interaction.reply(ephemeralOptions({ content: 'このサーバーにはまだ転送設定がありません。' }));
        return;
    }

    const lines = [];
    for (const sourceChannelId of sourceChannelIds) {
        const webhookUrls = await kv.sMembers(forwardWebhookTargetsKey(interaction.guildId, sourceChannelId));
        const allowedBotIds = await kv.sMembers(forwardAllowedBotsKey(interaction.guildId, sourceChannelId));
        const allowedWebhookIds = await kv.sMembers(forwardAllowedWebhooksKey(interaction.guildId, sourceChannelId));
        const sourceLabel = sourceChannelId === FORWARD_ALL_CHANNELS ? 'サーバー全体' : `<#${sourceChannelId}>`;

        lines.push(`転送元: ${sourceLabel}`);
        lines.push('　転送先Webhook:');
        lines.push(...(webhookUrls && webhookUrls.length > 0 ? webhookUrls.map((_, index) => `　　${index + 1}. 登録済み`) : ['　　・なし']));
        lines.push('　許可Bot:');
        lines.push(...(allowedBotIds && allowedBotIds.length > 0 ? allowedBotIds.map((botId) => `　　・<@${botId}> (${botId})`) : ['　　・なし']));
        lines.push('　許可Webhook:');
        lines.push(...(allowedWebhookIds && allowedWebhookIds.length > 0 ? allowedWebhookIds.map((webhookId) => `　　・${webhookId}`) : ['　　・なし']));
        lines.push('');
    }

    const chunks = splitLinesToMessages('現在の転送設定一覧:\n', lines);
    await interaction.reply(ephemeralOptions({ content: chunks[0] }));
    for (let i = 1; i < chunks.length; i++) await interaction.followUp(ephemeralOptions({ content: chunks[i] }));
}

module.exports = {
    name: 'forward',
    execute,
};
