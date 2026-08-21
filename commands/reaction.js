const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ChannelSelectMenuBuilder,
    UserSelectMenuBuilder,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { addAuditLog } = require('../utils/auditLog');

const {
    reactionRulesKey,
    reactionAllowedBotsKey,
    reactionRuleField,
} = require('../keys/redisKeys');

const ALL_USERS_ID = '*';

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function buildReactionMenuContent() {
    return [
        '## 😀 自動リアクション設定',
        '',
        '操作を選んでください。',
        '',
        '📋 **一覧表示**',
        '現在の自動リアクション設定を表示します。',
        '',
        '➕ **リアクション追加**',
        '指定チャンネル内のすべてのユーザーの投稿に自動リアクションを付けます。',
        '',
        '🗑️ **リアクション削除**',
        '自動リアクション設定を削除します。',
        '',
        '📋 **許可Bot一覧**',
        '許可されているBot一覧を表示します。',
        '',
        '🤖 **許可Bot追加**',
        'Bot投稿も自動リアクション対象にしたい場合、対象Botを許可します。',
        '',
        '🚫 **許可Bot削除**',
        '許可Botを削除します。',
    ].join('\n');
}

function buildReactionMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reaction_menu_show')
                .setLabel('一覧表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('reaction_menu_add')
                .setLabel('リアクション追加')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('reaction_menu_remove')
                .setLabel('リアクション削除')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reaction_menu_allow_show')
                .setLabel('許可Bot一覧')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('reaction_menu_allow_add')
                .setLabel('許可Bot追加')
                .setEmoji('🤖')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('reaction_menu_allow_remove')
                .setLabel('許可Bot削除')
                .setEmoji('🚫')
                .setStyle(ButtonStyle.Danger),
        ),
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('reaction_menu_add_by_id')
                .setLabel('IDでリアクション追加')
                .setEmoji('🔎')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('reaction_menu_allow_add_by_id')
                .setLabel('IDでBot許可')
                .setEmoji('🔎')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildReactionChannelSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
                .setChannelTypes(
                    ChannelType.GuildText,
                    ChannelType.PublicThread,
                    ChannelType.PrivateThread,
                    ChannelType.AnnouncementThread,
                )
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildReactionUserSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildReactionEmojiModal(channelId, userId) {
    return new ModalBuilder()
        .setCustomId(`reaction_add_emoji_modal:${channelId}:${userId}`)
        .setTitle('自動リアクションを追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('emoji')
                    .setLabel('付けるリアクション')
                    .setPlaceholder('例: ✅ / <:custom_emoji:123456789012345678>')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}


function buildReactionAddByIdModal() {
    return new ModalBuilder()
        .setCustomId('reaction_add_by_id_modal')
        .setTitle('IDで自動リアクションを追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_channel_id')
                    .setLabel('チャンネルまたはスレッドのID')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('emoji')
                    .setLabel('付けるリアクション')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildAllowedBotByIdModal() {
    return new ModalBuilder()
        .setCustomId('reaction_allow_add_by_id_modal')
        .setTitle('IDで許可Botを追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('bot_id')
                    .setLabel('BotのユーザーID')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function parseReactionRules(hash) {
    return Object.entries(hash).map(([field, emoji]) => {
        const sep = field.indexOf(':');

        return {
            field,
            channelId: field.slice(0, sep),
            userId: field.slice(sep + 1),
            emoji,
        };
    });
}

async function showReactionSettings(interaction, kv) {
    const rules = parseReactionRules(
        await kv.hGetAll(
            reactionRulesKey(interaction.guildId),
        ),
    );

    if (rules.length === 0) {
        await interaction.reply(
            ephemeralOptions({
                content: 'このサーバーにはまだ自動リアクション設定がありません。',
            }),
        );

        return;
    }

    const validLines = [];
    const removedLines = [];

    for (const rule of rules) {
        const targetChannel = await interaction.guild.channels
            .fetch(rule.channelId)
            .catch(() => null);

        if (!targetChannel || !allowedTargetTypes.includes(targetChannel.type)) {
            await kv.hDel(
                reactionRulesKey(interaction.guildId),
                rule.field,
            );

            const detail =
                `対象チャンネル <#${rule.channelId}> が見つからないため、` +
                `ユーザー <@${rule.userId}> / 絵文字 ${rule.emoji} の自動リアクション設定を削除しました。`;

            removedLines.push(`・${detail}`);

            await addAuditLog(
                interaction,
                kv,
                '自動リアクション設定自動削除',
                detail,
            );

            continue;
        }

        if (rule.userId === ALL_USERS_ID) {
            validLines.push(
                `${validLines.length + 1}. 対象チャンネル: <#${rule.channelId}> / 対象: すべてのユーザー / 絵文字: ${rule.emoji}`,
            );
            continue;
        }

        const user = await interaction.client.users
            .fetch(rule.userId)
            .catch(() => null);

        if (!user) {
            await kv.hDel(
                reactionRulesKey(interaction.guildId),
                rule.field,
            );

            const detail =
                `ユーザー ${rule.userId} が見つからないため、` +
                `対象チャンネル <#${rule.channelId}> / 絵文字 ${rule.emoji} の自動リアクション設定を削除しました。`;

            removedLines.push(`・${detail}`);

            await addAuditLog(
                interaction,
                kv,
                '自動リアクション設定自動削除',
                detail,
            );

            continue;
        }

        validLines.push(
            `${validLines.length + 1}. 対象チャンネル: <#${rule.channelId}> / ユーザー: <@${rule.userId}> / 絵文字: ${rule.emoji}`,
        );
    }

    const lines = [];

    if (removedLines.length > 0) {
        lines.push('## 自動削除した設定');
        lines.push(...removedLines);
        lines.push('');
    }

    if (validLines.length > 0) {
        lines.push('## 現在の自動リアクション設定一覧');
        lines.push(...validLines);
    } else {
        lines.push('現在有効な自動リアクション設定はありません。');
    }

    const chunks = splitLinesToMessages(
        '',
        lines,
    );

    await interaction.reply(
        ephemeralOptions({
            content: chunks[0],
        }),
    );

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

async function showAllowedBots(interaction, kv) {
    const botIds = await kv.sMembers(
        reactionAllowedBotsKey(interaction.guildId),
    );

    if (!botIds || botIds.length === 0) {
        await interaction.reply(
            ephemeralOptions({
                content: 'このサーバーには、許可された Bot 一覧がまだありません。',
            }),
        );

        return;
    }

    const validLines = [];
    const removedLines = [];

    for (const botId of botIds) {
        const user = await interaction.client.users
            .fetch(botId)
            .catch(() => null);

        if (!user) {
            await kv.sRem(
                reactionAllowedBotsKey(interaction.guildId),
                botId,
            );

            const detail =
                `Bot ID ${botId} が見つからないため、自動リアクション許可Bot一覧から削除しました。`;

            removedLines.push(`・${detail}`);

            await addAuditLog(
                interaction,
                kv,
                '自動リアクション許可Bot自動削除',
                detail,
            );

            continue;
        }

        if (!user.bot) {
            await kv.sRem(
                reactionAllowedBotsKey(interaction.guildId),
                botId,
            );

            const detail =
                `<@${botId}> はBotアカウントではないため、自動リアクション許可Bot一覧から削除しました。`;

            removedLines.push(`・${detail}`);

            await addAuditLog(
                interaction,
                kv,
                '自動リアクション許可Bot自動削除',
                detail,
            );

            continue;
        }

        validLines.push(
            `${validLines.length + 1}. <@${botId}> (${botId})`,
        );
    }

    const lines = [];

    if (removedLines.length > 0) {
        lines.push('## 自動削除した許可Bot設定');
        lines.push(...removedLines);
        lines.push('');
    }

    if (validLines.length > 0) {
        lines.push('## 自動リアクション対象として許可されている Bot 一覧');
        lines.push(...validLines);
    } else {
        lines.push('現在有効な許可Bot設定はありません。');
    }

    const chunks = splitLinesToMessages(
        '',
        lines,
    );

    await interaction.reply(
        ephemeralOptions({
            content: chunks[0],
        }),
    );

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

async function addReactionRule(interaction, kv, targetChannel, user, emoji) {
    if (!allowedTargetTypes.includes(targetChannel.type)) {
        await interaction.reply(
            ephemeralOptions({
                content: 'target_channel にはテキストチャンネルまたはスレッドを指定してください。',
            }),
        );

        return;
    }

    await kv.hSet(
        reactionRulesKey(interaction.guildId),
        reactionRuleField(targetChannel.id, user.id),
        emoji,
    );

    await addAuditLog(
        interaction,
        kv,
        '自動リアクション設定追加',
        `対象チャンネル <#${targetChannel.id}> / ${user.id === ALL_USERS_ID ? 'すべてのユーザー' : `ユーザー <@${user.id}>`} / 絵文字 ${emoji} の自動リアクション設定を追加しました。`,
    );

    await interaction.reply(
        ephemeralOptions({
            content:
                `自動リアクション設定を登録しました。\n` +
                `対象チャンネル: <#${targetChannel.id}>\n` +
                `対象: ${user.id === ALL_USERS_ID ? 'すべてのユーザー' : `<@${user.id}>`}\n` +
                `絵文字: ${emoji}`,
        }),
    );
}

async function removeReactionRule(interaction, kv, targetChannel, user) {
    const removed = await kv.hDel(
        reactionRulesKey(interaction.guildId),
        reactionRuleField(targetChannel.id, user.id),
    );

    if (removed) {
        await addAuditLog(
            interaction,
            kv,
            '自動リアクション設定削除',
            `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`,
        );
    }

    await interaction.reply(
        ephemeralOptions({
            content: removed
                ? `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`
                : `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定は見つかりませんでした。`,
        }),
    );
}

async function addAllowedBot(interaction, kv, user) {
    if (!user.bot) {
        await interaction.reply(
            ephemeralOptions({
                content: 'bot アカウントを指定してください。',
            }),
        );

        return;
    }

    await kv.sAdd(
        reactionAllowedBotsKey(interaction.guildId),
        user.id,
    );

    await addAuditLog(
        interaction,
        kv,
        '自動リアクション許可Bot追加',
        `自動リアクション対象として Bot <@${user.id}> を許可しました。`,
    );

    await interaction.reply(
        ephemeralOptions({
            content: `自動リアクション対象として Bot <@${user.id}> を許可しました。`,
        }),
    );
}

async function removeAllowedBot(interaction, kv, user) {
    const removed = await kv.sRem(
        reactionAllowedBotsKey(interaction.guildId),
        user.id,
    );

    if (removed) {
        await addAuditLog(
            interaction,
            kv,
            '自動リアクション許可Bot削除',
            `自動リアクション対象から Bot <@${user.id}> を削除しました。`,
        );
    }

    await interaction.reply(
        ephemeralOptions({
            content: removed
                ? `自動リアクション対象から Bot <@${user.id}> を削除しました。`
                : `Bot <@${user.id}> は許可一覧にありませんでした。`,
        }),
    );
}

async function execute(interaction, context) {
    await interaction.reply(
        ephemeralOptions({
            content: buildReactionMenuContent(),
            components: buildReactionMenuComponents(),
        }),
    );
}

async function handleComponent(interaction, context) {
    const { client, kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'reaction_menu_show') {
            await showReactionSettings(
                interaction,
                kv,
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_add') {
            await interaction.reply(
                ephemeralOptions({
                    content: '対象チャンネルまたはスレッドを選択してください。',
                    components: buildReactionChannelSelectMenu(
                        'reaction_add_select_channel',
                        '対象チャンネルまたはスレッドを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_remove') {
            await interaction.reply(
                ephemeralOptions({
                    content: '削除する自動リアクション設定の対象チャンネルまたはスレッドを選択してください。',
                    components: buildReactionChannelSelectMenu(
                        'reaction_remove_select_channel',
                        '対象チャンネルまたはスレッドを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_show') {
            await showAllowedBots(
                interaction,
                kv,
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_add') {
            await interaction.reply(
                ephemeralOptions({
                    content: '自動リアクション対象として許可するBotを選択してください。',
                    components: buildReactionUserSelectMenu(
                        'reaction_allow_add_select_user',
                        '許可するBotを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_remove') {
            await interaction.reply(
                ephemeralOptions({
                    content: '自動リアクション対象から削除するBotを選択してください。',
                    components: buildReactionUserSelectMenu(
                        'reaction_allow_remove_select_user',
                        '削除するBotを選択してください',
                    ),
                }),
            );

            return true;
        }


        if (interaction.customId === 'reaction_menu_add_by_id') {
            await interaction.showModal(buildReactionAddByIdModal());
            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_add_by_id') {
            await interaction.showModal(buildAllowedBotByIdModal());
            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId === 'reaction_add_select_channel') {
            const channelId = interaction.values[0];
            await interaction.showModal(
                buildReactionEmojiModal(channelId, ALL_USERS_ID),
            );
            return true;
        }

        if (interaction.customId === 'reaction_remove_select_channel') {
            const channelId = interaction.values[0];

            await interaction.update(
                ephemeralOptions({
                    content: `対象チャンネル: <#${channelId}>\n削除対象のユーザーを選択してください。`,
                    components: buildReactionUserSelectMenu(
                        `reaction_remove_select_user:${channelId}`,
                        '削除対象のユーザーを選択してください',
                    ),
                }),
            );

            return true;
        }

        return false;
    }

    if (interaction.isUserSelectMenu()) {
        if (interaction.customId.startsWith('reaction_add_select_user:')) {
            const channelId = interaction.customId.split(':')[1];
            const userId = interaction.values[0];

            await interaction.showModal(
                buildReactionEmojiModal(
                    channelId,
                    userId,
                ),
            );

            return true;
        }

        if (interaction.customId.startsWith('reaction_remove_select_user:')) {
            const channelId = interaction.customId.split(':')[1];
            const userId = interaction.values[0];

            const targetChannel = await client.channels
                .fetch(channelId)
                .catch(() => null);

            const user = userId === ALL_USERS_ID
                ? { id: ALL_USERS_ID }
                : await client.users.fetch(userId).catch(() => null);

            if (!targetChannel || targetChannel.guildId !== interaction.guildId) {
                await interaction.update(
                    ephemeralOptions({
                        content: '対象チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                        components: [],
                    }),
                );

                return true;
            }

            if (!user) {
                await interaction.update(
                    ephemeralOptions({
                        content: '対象ユーザーが見つかりませんでした。',
                        components: [],
                    }),
                );

                return true;
            }

            const removed = await kv.hDel(
                reactionRulesKey(interaction.guildId),
                reactionRuleField(targetChannel.id, user.id),
            );

            if (removed) {
                await addAuditLog(
                    interaction,
                    kv,
                    '自動リアクション設定削除',
                    `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`,
                );
            }

            await interaction.update(
                ephemeralOptions({
                    content: removed
                        ? `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定を削除しました。`
                        : `対象チャンネル <#${targetChannel.id}> / ユーザー <@${user.id}> の自動リアクション設定は見つかりませんでした。`,
                    components: [],
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_allow_add_select_user') {
            const userId = interaction.values[0];

            const user = await client.users
                .fetch(userId)
                .catch(() => null);

            if (!user) {
                await interaction.update(
                    ephemeralOptions({
                        content: '対象ユーザーが見つかりませんでした。',
                        components: [],
                    }),
                );

                return true;
            }

            if (!user.bot) {
                await interaction.update(
                    ephemeralOptions({
                        content: 'bot アカウントを指定してください。',
                        components: [],
                    }),
                );

                return true;
            }

            await kv.sAdd(
                reactionAllowedBotsKey(interaction.guildId),
                user.id,
            );

            await addAuditLog(
                interaction,
                kv,
                '自動リアクション許可Bot追加',
                `自動リアクション対象として Bot <@${user.id}> を許可しました。`,
            );

            await interaction.update(
                ephemeralOptions({
                    content: `自動リアクション対象として Bot <@${user.id}> を許可しました。`,
                    components: [],
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_allow_remove_select_user') {
            const userId = interaction.values[0];

            const user = await client.users
                .fetch(userId)
                .catch(() => null);

            if (!user) {
                await interaction.update(
                    ephemeralOptions({
                        content: '対象ユーザーが見つかりませんでした。',
                        components: [],
                    }),
                );

                return true;
            }

            const removed = await kv.sRem(
                reactionAllowedBotsKey(interaction.guildId),
                user.id,
            );

            if (removed) {
                await addAuditLog(
                    interaction,
                    kv,
                    '自動リアクション許可Bot削除',
                    `自動リアクション対象から Bot <@${user.id}> を削除しました。`,
                );
            }

            await interaction.update(
                ephemeralOptions({
                    content: removed
                        ? `自動リアクション対象から Bot <@${user.id}> を削除しました。`
                        : `Bot <@${user.id}> は許可一覧にありませんでした。`,
                    components: [],
                }),
            );

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {

        if (interaction.customId === 'reaction_add_by_id_modal') {
            const channelId = interaction.fields.getTextInputValue('target_channel_id').trim();
            const emoji = interaction.fields.getTextInputValue('emoji').trim();
            const targetChannel = await client.channels.fetch(channelId).catch(() => null);
            if (!targetChannel || targetChannel.guildId !== interaction.guildId || !allowedTargetTypes.includes(targetChannel.type)) {
                await interaction.reply(ephemeralOptions({ content: '対象チャンネルまたはスレッドが見つからないか、設定対象にできません。' }));
                return true;
            }
            await addReactionRule(interaction, kv, targetChannel, { id: ALL_USERS_ID }, emoji);
            return true;
        }

        if (interaction.customId === 'reaction_allow_add_by_id_modal') {
            const botId = interaction.fields.getTextInputValue('bot_id').trim();
            if (!/^\d{17,20}$/.test(botId)) {
                await interaction.reply(ephemeralOptions({ content: '正しいBotユーザーIDを数字のみで入力してください。' }));
                return true;
            }
            const member = await interaction.guild.members.fetch(botId).catch(() => null);
            if (!member || !member.user.bot) {
                await interaction.reply(ephemeralOptions({ content: 'そのIDのBotはこのサーバー内に見つかりませんでした。' }));
                return true;
            }
            await addAllowedBot(interaction, kv, member.user);
            return true;
        }

        if (interaction.customId.startsWith('reaction_add_emoji_modal:')) {
            const [, channelId, userId] = interaction.customId.split(':');

            const targetChannel = await client.channels
                .fetch(channelId)
                .catch(() => null);

            const user = await client.users
                .fetch(userId)
                .catch(() => null);

            if (!targetChannel || targetChannel.guildId !== interaction.guildId) {
                await interaction.reply(
                    ephemeralOptions({
                        content: '対象チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                    }),
                );

                return true;
            }

            if (!user) {
                await interaction.reply(
                    ephemeralOptions({
                        content: '対象ユーザーが見つかりませんでした。',
                    }),
                );

                return true;
            }

            const emoji = interaction.fields
                .getTextInputValue('emoji')
                .trim();

            await addReactionRule(
                interaction,
                kv,
                targetChannel,
                user,
                emoji,
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'reaction',
    execute,
    handleComponent,
};