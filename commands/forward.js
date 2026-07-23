const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ChannelSelectMenuBuilder,
} = require('discord.js');

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

const forwardSourceChannelTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,
    ChannelType.GuildStageVoice,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function buildForwardMenuContent() {
    return [
        '## 🔁 転送設定',
        '',
        '操作を選んでください。',
        '',
        '📋 **一覧表示**',
        '現在の転送設定、許可Bot、許可Webhookを表示します。',
        '',
        '🌐 **全体転送追加**',
        'サーバー全体の投稿をWebhookへ転送します。',
        '',
        '➕ **チャンネル転送追加**',
        '指定チャンネルの投稿をWebhookへ転送します。',
        '',
        '🗑️ **転送削除**',
        '登録済みの転送Webhook URLを削除します。',
        '',
        '✅ **許可対象追加**',
        'Bot投稿やWebhook投稿を転送対象として許可します。',
        '',
        '🚫 **許可対象削除**',
        '許可済みのBot/Webhookを削除します。',
        '',
        '🙈 **除外チャンネル追加**',
        'サーバー全体転送から除外するチャンネルを追加します。',
        '',
        '📋 **除外一覧**',
        'サーバー全体転送から除外されているチャンネルを表示します。',
        '',
        '👁️ **除外解除**',
        '除外チャンネルから削除します。',
    ].join('\n');
}

function buildForwardMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('forward_menu_show')
                .setLabel('一覧表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('forward_menu_set_all')
                .setLabel('全体転送追加')
                .setEmoji('🌐')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('forward_menu_set_channel')
                .setLabel('チャンネル転送追加')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('forward_menu_unset')
                .setLabel('転送削除')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('forward_menu_allow_add')
                .setLabel('許可追加')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('forward_menu_allow_remove')
                .setLabel('許可削除')
                .setEmoji('🚫')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('forward_menu_exclude_add')
                .setLabel('除外追加')
                .setEmoji('🙈')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('forward_menu_exclude_show')
                .setLabel('除外一覧')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Secondary),

            new ButtonBuilder()
                .setCustomId('forward_menu_exclude_remove')
                .setLabel('除外解除')
                .setEmoji('👁️')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildForwardSourceChannelSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
                .setChannelTypes(...forwardSourceChannelTypes)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildForwardSetModal(sourceChannelId) {
    return new ModalBuilder()
        .setCustomId(`forward_set_modal:${sourceChannelId}`)
        .setTitle('転送設定を追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_webhook_url')
                    .setLabel('転送先Webhook URL')
                    .setPlaceholder('https://discord.com/api/webhooks/...')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildForwardUnsetModal(sourceChannelId) {
    return new ModalBuilder()
        .setCustomId(`forward_unset_modal:${sourceChannelId}`)
        .setTitle('転送設定を削除')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_webhook_url')
                    .setLabel('削除するWebhook URL')
                    .setPlaceholder('https://discord.com/api/webhooks/...')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildForwardAllowModal(mode) {
    const title = mode === 'add'
        ? '転送許可対象を追加'
        : '転送許可対象を削除';

    return new ModalBuilder()
        .setCustomId(`forward_allow_${mode}_modal`)
        .setTitle(title)
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('type')
                    .setLabel('種類')
                    .setPlaceholder('bot または webhook')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('id')
                    .setLabel('Bot ID または Webhook ID')
                    .setPlaceholder('例: 123456789012345678')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('source_channel_id')
                    .setLabel('転送元チャンネルID')
                    .setPlaceholder('空欄ならサーバー全体')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false),
            ),
        );
}

async function execute(interaction, context) {
    const { kv } = context;

    const group = interaction.options.getSubcommandGroup(false);
    const sub = interaction.options.getSubcommand(false);

    if (!sub) {
        await interaction.reply(ephemeralOptions({
            content: buildForwardMenuContent(),
            components: buildForwardMenuComponents(),
        }));
        return;
    }

    if (sub === 'menu') {
        await interaction.reply(ephemeralOptions({
            content: buildForwardMenuContent(),
            components: buildForwardMenuComponents(),
        }));
        return;
    }

    if (group === 'exclude') {
        await handleExclude(interaction, kv, sub);
        return;
    }

    if (group === 'allow') {
        await handleAllow(interaction, context, sub);
        return;
    }

    if (sub === 'set') {
        const sourceChannel = interaction.options.getChannel('source_channel', false);
        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;

        const targetWebhookUrl = interaction.options
            .getString('target_webhook_url', true)
            .trim();

        await addForwardWebhook(
            interaction,
            kv,
            sourceChannelId,
            sourceChannel,
            targetWebhookUrl,
        );
        return;
    }

    if (sub === 'show') {
        await handleShow(interaction, kv);
        return;
    }

    if (sub === 'unset') {
        const sourceChannel = interaction.options.getChannel('source_channel', false);
        const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;

        const targetWebhookUrl = interaction.options
            .getString('target_webhook_url', true)
            .trim();

        await removeForwardWebhook(
            interaction,
            kv,
            sourceChannelId,
            sourceChannel,
            targetWebhookUrl,
        );
    }
}

async function addForwardWebhook(interaction, kv, sourceChannelId, sourceChannel, targetWebhookUrl) {
    if (!targetWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
        await interaction.reply(ephemeralOptions({
            content: 'Webhook URL の形式が正しくありません。',
        }));
        return;
    }

    await kv.sAdd(
        forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
        targetWebhookUrl,
    );

    await kv.sAdd(
        forwardWebhookIndexKey(interaction.guildId),
        sourceChannelId,
    );

    await interaction.reply(ephemeralOptions({
        content:
            `転送設定を登録しました。\n` +
            `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n` +
            `転送先: Webhook URL`,
    }));
}

async function removeForwardWebhook(interaction, kv, sourceChannelId, sourceChannel, targetWebhookUrl) {
    const removed = await kv.sRem(
        forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
        targetWebhookUrl,
    );

    if (!removed) {
        await interaction.reply(ephemeralOptions({
            content:
                `${sourceChannel ? `転送元 <#${sourceChannel.id}>` : 'サーバー全体転送'} の指定Webhook設定は見つかりませんでした。`,
        }));
        return;
    }

    const remainingTargets = await kv.sMembers(
        forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
    );

    if (!remainingTargets || remainingTargets.length === 0) {
        await kv.del(
            forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
        );

        await kv.sRem(
            forwardWebhookIndexKey(interaction.guildId),
            sourceChannelId,
        );
    }

    await interaction.reply(ephemeralOptions({
        content:
            `転送設定を削除しました。\n` +
            `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}`,
    }));
}

async function handleExclude(interaction, kv, sub) {
    if (sub === 'add') {
        const channel = interaction.options.getChannel('channel', true);

        await kv.sAdd(
            forwardExcludeChannelsKey(interaction.guildId),
            channel.id,
        );

        await interaction.reply(ephemeralOptions({
            content:
                `鯖全体転送の除外チャンネルに追加しました。\n` +
                `除外: <#${channel.id}>`,
        }));
        return;
    }

    if (sub === 'remove') {
        const channel = interaction.options.getChannel('channel', true);

        const removed = await kv.sRem(
            forwardExcludeChannelsKey(interaction.guildId),
            channel.id,
        );

        await interaction.reply(ephemeralOptions({
            content: removed
                ? `鯖全体転送の除外チャンネルから削除しました。\n解除: <#${channel.id}>`
                : `そのチャンネルは除外一覧にありませんでした。\n対象: <#${channel.id}>`,
        }));
        return;
    }

    if (sub === 'show') {
        await showExcludeChannels(interaction, kv);
    }
}

async function showExcludeChannels(interaction, kv) {
    const channelIds = await kv.sMembers(
        forwardExcludeChannelsKey(interaction.guildId),
    );

    if (!channelIds || channelIds.length === 0) {
        await interaction.reply(ephemeralOptions({
            content: '鯖全体転送の除外チャンネルはありません。',
        }));
        return;
    }

    const lines = channelIds.map((id, index) => {
        return `${index + 1}. <#${id}> (${id})`;
    });

    const chunks = splitLinesToMessages(
        '鯖全体転送の除外チャンネル一覧:\n',
        lines,
    );

    await interaction.reply(ephemeralOptions({
        content: chunks[0],
    }));

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(ephemeralOptions({
            content: chunks[i],
        }));
    }
}

async function handleAllow(interaction, context, sub) {
    const { client, kv } = context;

    const sourceChannel = interaction.options.getChannel('source_channel', false);
    const sourceChannelId = sourceChannel ? sourceChannel.id : FORWARD_ALL_CHANNELS;

    const type = interaction.options.getString('type', true);
    const id = interaction.options.getString('id', true).trim();

    await applyAllowSetting(
        interaction,
        client,
        kv,
        sub,
        type,
        id,
        sourceChannelId,
        sourceChannel,
    );
}

async function applyAllowSetting(interaction, client, kv, mode, type, id, sourceChannelId, sourceChannel) {
    if (!['bot', 'webhook'].includes(type)) {
        await interaction.reply(ephemeralOptions({
            content: 'type は `bot` または `webhook` を指定してください。',
        }));
        return;
    }

    if (!/^\d{17,20}$/.test(id)) {
        await interaction.reply(ephemeralOptions({
            content: 'IDの形式が正しくありません。17〜20桁程度のDiscord IDを指定してください。',
        }));
        return;
    }

    if (!sourceChannel && sourceChannelId !== FORWARD_ALL_CHANNELS) {
        sourceChannel = await client.channels
            .fetch(sourceChannelId)
            .catch(() => null);
    }

    const keyFactory = type === 'bot'
        ? forwardAllowedBotsKey
        : forwardAllowedWebhooksKey;

    if (mode === 'add') {
        await kv.sAdd(
            keyFactory(interaction.guildId, sourceChannelId),
            id,
        );

        await interaction.reply(ephemeralOptions({
            content:
                `転送許可${type === 'bot' ? 'Bot' : 'Webhook'}を追加しました。\n` +
                `転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n` +
                `${type === 'bot' ? 'Bot' : 'Webhook'} ID: ${id}`,
        }));
        return;
    }

    if (mode === 'remove') {
        const removed = await kv.sRem(
            keyFactory(interaction.guildId, sourceChannelId),
            id,
        );

        await interaction.reply(ephemeralOptions({
            content: removed
                ? `転送許可${type === 'bot' ? 'Bot' : 'Webhook'}を削除しました。\n転送元: ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'}\n${type === 'bot' ? 'Bot' : 'Webhook'} ID: ${id}`
                : `転送元 ${sourceChannel ? `<#${sourceChannel.id}>` : 'サーバー全体'} の許可一覧に ${id} はありませんでした。`,
        }));
    }
}

async function handleShow(interaction, kv) {
    const sourceChannelIds = await kv.sMembers(
        forwardWebhookIndexKey(interaction.guildId),
    );

    if (!sourceChannelIds || sourceChannelIds.length === 0) {
        await interaction.reply(ephemeralOptions({
            content: 'このサーバーにはまだ転送設定がありません。',
        }));
        return;
    }

    const lines = [];

    for (const sourceChannelId of sourceChannelIds) {
        const webhookUrls = await kv.sMembers(
            forwardWebhookTargetsKey(interaction.guildId, sourceChannelId),
        );

        const allowedBotIds = await kv.sMembers(
            forwardAllowedBotsKey(interaction.guildId, sourceChannelId),
        );

        const allowedWebhookIds = await kv.sMembers(
            forwardAllowedWebhooksKey(interaction.guildId, sourceChannelId),
        );

        const sourceLabel = sourceChannelId === FORWARD_ALL_CHANNELS
            ? 'サーバー全体'
            : `<#${sourceChannelId}>`;

        lines.push(`転送元: ${sourceLabel}`);

        lines.push('　転送先Webhook:');
        lines.push(...(webhookUrls && webhookUrls.length > 0
            ? webhookUrls.map((_, index) => `　　${index + 1}. 登録済み`)
            : ['　　・なし']));

        lines.push('　許可Bot:');
        lines.push(...(allowedBotIds && allowedBotIds.length > 0
            ? allowedBotIds.map((botId) => `　　・<@${botId}> (${botId})`)
            : ['　　・なし']));

        lines.push('　許可Webhook:');
        lines.push(...(allowedWebhookIds && allowedWebhookIds.length > 0
            ? allowedWebhookIds.map((webhookId) => `　　・${webhookId}`)
            : ['　　・なし']));

        lines.push('');
    }

    const chunks = splitLinesToMessages(
        '現在の転送設定一覧:\n',
        lines,
    );

    await interaction.reply(ephemeralOptions({
        content: chunks[0],
    }));

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(ephemeralOptions({
            content: chunks[i],
        }));
    }
}

async function handleComponent(interaction, context) {
    const { client, kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'forward_menu_show') {
            await handleShow(interaction, kv);
            return true;
        }

        if (interaction.customId === 'forward_menu_set_all') {
            await interaction.showModal(
                buildForwardSetModal(FORWARD_ALL_CHANNELS),
            );
            return true;
        }

        if (interaction.customId === 'forward_menu_set_channel') {
            await interaction.reply(ephemeralOptions({
                content: '転送元チャンネルを選択してください。',
                components: buildForwardSourceChannelSelectMenu(
                    'forward_set_select_source',
                    '転送元チャンネルを選択してください',
                ),
            }));
            return true;
        }

        if (interaction.customId === 'forward_menu_unset') {
            await interaction.reply(ephemeralOptions({
                content:
                    '削除対象の転送元を選択してください。\n' +
                    'サーバー全体転送を削除する場合は「全体転送削除」を押してください。',
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId('forward_unset_all')
                            .setLabel('全体転送削除')
                            .setEmoji('🌐')
                            .setStyle(ButtonStyle.Danger),
                    ),
                    ...buildForwardSourceChannelSelectMenu(
                        'forward_unset_select_source',
                        '転送元チャンネルを選択してください',
                    ),
                ],
            }));
            return true;
        }

        if (interaction.customId === 'forward_unset_all') {
            await interaction.showModal(
                buildForwardUnsetModal(FORWARD_ALL_CHANNELS),
            );
            return true;
        }

        if (interaction.customId === 'forward_menu_allow_add') {
            await interaction.showModal(
                buildForwardAllowModal('add'),
            );
            return true;
        }

        if (interaction.customId === 'forward_menu_allow_remove') {
            await interaction.showModal(
                buildForwardAllowModal('remove'),
            );
            return true;
        }

        if (interaction.customId === 'forward_menu_exclude_add') {
            await interaction.reply(ephemeralOptions({
                content: '鯖全体転送から除外するチャンネルを選択してください。',
                components: buildForwardSourceChannelSelectMenu(
                    'forward_exclude_add_select_channel',
                    '除外するチャンネルを選択してください',
                ),
            }));
            return true;
        }

        if (interaction.customId === 'forward_menu_exclude_show') {
            await showExcludeChannels(interaction, kv);
            return true;
        }

        if (interaction.customId === 'forward_menu_exclude_remove') {
            await interaction.reply(ephemeralOptions({
                content: '鯖全体転送の除外を解除するチャンネルを選択してください。',
                components: buildForwardSourceChannelSelectMenu(
                    'forward_exclude_remove_select_channel',
                    '除外解除するチャンネルを選択してください',
                ),
            }));
            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId === 'forward_set_select_source') {
            const sourceChannelId = interaction.values[0];

            await interaction.showModal(
                buildForwardSetModal(sourceChannelId),
            );
            return true;
        }

        if (interaction.customId === 'forward_unset_select_source') {
            const sourceChannelId = interaction.values[0];

            await interaction.showModal(
                buildForwardUnsetModal(sourceChannelId),
            );
            return true;
        }

        if (interaction.customId === 'forward_exclude_add_select_channel') {
            const channelId = interaction.values[0];

            await kv.sAdd(
                forwardExcludeChannelsKey(interaction.guildId),
                channelId,
            );

            await interaction.update(ephemeralOptions({
                content:
                    `鯖全体転送の除外チャンネルに追加しました。\n` +
                    `除外: <#${channelId}>`,
                components: [],
            }));
            return true;
        }

        if (interaction.customId === 'forward_exclude_remove_select_channel') {
            const channelId = interaction.values[0];

            const removed = await kv.sRem(
                forwardExcludeChannelsKey(interaction.guildId),
                channelId,
            );

            await interaction.update(ephemeralOptions({
                content: removed
                    ? `鯖全体転送の除外チャンネルから削除しました。\n解除: <#${channelId}>`
                    : `そのチャンネルは除外一覧にありませんでした。\n対象: <#${channelId}>`,
                components: [],
            }));
            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('forward_set_modal:')) {
            const sourceChannelId = interaction.customId.split(':')[1];

            const sourceChannel = sourceChannelId === FORWARD_ALL_CHANNELS
                ? null
                : await client.channels.fetch(sourceChannelId).catch(() => null);

            const targetWebhookUrl = interaction.fields
                .getTextInputValue('target_webhook_url')
                .trim();

            await addForwardWebhook(
                interaction,
                kv,
                sourceChannelId,
                sourceChannel,
                targetWebhookUrl,
            );
            return true;
        }

        if (interaction.customId.startsWith('forward_unset_modal:')) {
            const sourceChannelId = interaction.customId.split(':')[1];

            const sourceChannel = sourceChannelId === FORWARD_ALL_CHANNELS
                ? null
                : await client.channels.fetch(sourceChannelId).catch(() => null);

            const targetWebhookUrl = interaction.fields
                .getTextInputValue('target_webhook_url')
                .trim();

            await removeForwardWebhook(
                interaction,
                kv,
                sourceChannelId,
                sourceChannel,
                targetWebhookUrl,
            );
            return true;
        }

        if (interaction.customId === 'forward_allow_add_modal') {
            const type = interaction.fields
                .getTextInputValue('type')
                .trim();

            const id = interaction.fields
                .getTextInputValue('id')
                .trim();

            const sourceChannelIdRaw = interaction.fields
                .getTextInputValue('source_channel_id')
                .trim();

            const sourceChannelId = sourceChannelIdRaw || FORWARD_ALL_CHANNELS;

            const sourceChannel = sourceChannelId === FORWARD_ALL_CHANNELS
                ? null
                : await client.channels.fetch(sourceChannelId).catch(() => null);

            if (sourceChannelId !== FORWARD_ALL_CHANNELS && (!sourceChannel || sourceChannel.guildId !== interaction.guildId)) {
                await interaction.reply(ephemeralOptions({
                    content: '転送元チャンネルIDが正しくないか、このサーバーのチャンネルではありません。',
                }));
                return true;
            }

            await applyAllowSetting(
                interaction,
                client,
                kv,
                'add',
                type,
                id,
                sourceChannelId,
                sourceChannel,
            );
            return true;
        }

        if (interaction.customId === 'forward_allow_remove_modal') {
            const type = interaction.fields
                .getTextInputValue('type')
                .trim();

            const id = interaction.fields
                .getTextInputValue('id')
                .trim();

            const sourceChannelIdRaw = interaction.fields
                .getTextInputValue('source_channel_id')
                .trim();

            const sourceChannelId = sourceChannelIdRaw || FORWARD_ALL_CHANNELS;

            const sourceChannel = sourceChannelId === FORWARD_ALL_CHANNELS
                ? null
                : await client.channels.fetch(sourceChannelId).catch(() => null);

            if (sourceChannelId !== FORWARD_ALL_CHANNELS && (!sourceChannel || sourceChannel.guildId !== interaction.guildId)) {
                await interaction.reply(ephemeralOptions({
                    content: '転送元チャンネルIDが正しくないか、このサーバーのチャンネルではありません。',
                }));
                return true;
            }

            await applyAllowSetting(
                interaction,
                client,
                kv,
                'remove',
                type,
                id,
                sourceChannelId,
                sourceChannel,
            );
            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'forward',
    execute,
    handleComponent,
};