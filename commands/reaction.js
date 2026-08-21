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
        '指定チャンネル内のすべてのユーザーの投稿に、自動リアクションを付けます。',
        '',
        '🗑️ **リアクション削除**',
        '指定チャンネルの自動リアクション設定を削除します。',
        '',
        '📋 **許可Bot一覧**',
        '自動リアクション対象として許可されているBot一覧を表示します。',
        '',
        '🤖 **許可Bot追加**',
        'Bot投稿にも自動リアクションを付けたい場合、対象Botを許可します。',
        '',
        '🚫 **許可Bot削除**',
        '許可Botを自動リアクション対象から削除します。',
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

function buildReactionTargetIdModal() {
    return new ModalBuilder()
        .setCustomId('reaction_add_target_id_modal')
        .setTitle('対象チャンネルを指定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_channel_id')
                    .setLabel('チャンネルまたはスレッドのID')
                    .setPlaceholder('例: 123456789012345678')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildReactionEmojiModal(channelId) {
    return new ModalBuilder()
        .setCustomId(`reaction_add_emoji_modal:${channelId}`)
        .setTitle('自動リアクションを追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('emoji')
                    .setLabel('付けるリアクション')
                    .setPlaceholder(
                        '例: ✅ / <:custom_emoji:123456789012345678>',
                    )
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}

function buildAllowedBotIdModal() {
    return new ModalBuilder()
        .setCustomId('reaction_allow_add_bot_id_modal')
        .setTitle('許可Botを追加')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('bot_id')
                    .setLabel('BotのユーザーID')
                    .setPlaceholder('例: 123456789012345678')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
        );
}
function parseReactionRules(hash) {
    return Object.entries(hash).map(([field, emoji]) => {
        const separatorIndex = field.indexOf(':');

        return {
            field,
            channelId: field.slice(0, separatorIndex),
            userId: field.slice(separatorIndex + 1),
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
                content:
                    'このサーバーにはまだ自動リアクション設定がありません。',
            }),
        );

        return;
    }

    const validLines = [];
    const removedLines = [];

    for (const rule of rules) {
        const target_channel = await interaction.guild.channels
            .fetch(rule.channelId)
            .catch(() => null);

        if (
            !target_channel ||
            !allowedTargetTypes.includes(target_channel.type)
        ) {
            await kv.hDel(
                reactionRulesKey(interaction.guildId),
                rule.field,
            );

            const detail =
                `対象チャンネル <#${rule.channelId}> が見つからないため、` +
                `絵文字 ${rule.emoji} の自動リアクション設定を削除しました。`;

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
                `${validLines.length + 1}. ` +
                `対象チャンネル: <#${rule.channelId}> / ` +
                `対象: すべてのユーザー / ` +
                `絵文字: ${rule.emoji}`,
            );

            continue;
        }

        /*
         * 旧形式の「特定ユーザー用設定」も一覧には表示する。
         * 新しく追加される設定は、すべて userId = "*" になる。
         */
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
                `対象チャンネル <#${rule.channelId}> / ` +
                `絵文字 ${rule.emoji} の旧形式設定を削除しました。`;

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
            `${validLines.length + 1}. ` +
            `対象チャンネル: <#${rule.channelId}> / ` +
            `旧形式ユーザー: <@${rule.userId}> / ` +
            `絵文字: ${rule.emoji}`,
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

    const chunks = splitLinesToMessages('', lines);

    await interaction.reply(
        ephemeralOptions({
            content: chunks[0],
        }),
    );

    for (let index = 1; index < chunks.length; index++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[index],
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
                content:
                    'このサーバーには、許可されたBot一覧がまだありません。',
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
                `Bot ID ${botId} が見つからないため、` +
                '自動リアクション許可Bot一覧から削除しました。';

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
                `<@${botId}> はBotアカウントではないため、` +
                '自動リアクション許可Bot一覧から削除しました。';

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
        lines.push(
            '## 自動リアクション対象として許可されているBot一覧',
        );

        lines.push(...validLines);
    } else {
        lines.push('現在有効な許可Bot設定はありません。');
    }

    const chunks = splitLinesToMessages('', lines);

    await interaction.reply(
        ephemeralOptions({
            content: chunks[0],
        }),
    );

    for (let index = 1; index < chunks.length; index++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[index],
            }),
        );
    }
}

async function addReactionRule(
    interaction,
    kv,
    target_channel,
    emoji,
) {
    if (!allowedTargetTypes.includes(target_channel.type)) {
        await interaction.reply(
            ephemeralOptions({
                content:
                    'target_channel にはテキストチャンネルまたはスレッドを指定してください。',
            }),
        );

        return;
    }

    await kv.hSet(
        reactionRulesKey(interaction.guildId),
        reactionRuleField(
            target_channel.id,
            ALL_USERS_ID,
        ),
        emoji,
    );

    await addAuditLog(
        interaction,
        kv,
        '自動リアクション設定追加',
        `対象チャンネル <#${target_channel.id}> / ` +
        `全ユーザー / 絵文字 ${emoji} の自動リアクション設定を追加しました。`,
    );

    await interaction.reply(
        ephemeralOptions({
            content:
                `自動リアクション設定を登録しました。\n` +
                `対象チャンネル: <#${target_channel.id}>\n` +
                `対象: すべてのユーザー\n` +
                `絵文字: ${emoji}`,
        }),
    );
}

async function removeReactionRule(
    interaction,
    kv,
    target_channel,
) {
    const rulesKey = reactionRulesKey(interaction.guildId);

    const removedAllUsersRule = await kv.hDel(
        rulesKey,
        reactionRuleField(
            target_channel.id,
            ALL_USERS_ID,
        ),
    );

    /*
     * 同じチャンネルに旧形式のユーザー個別設定が残っている場合も、
     * チャンネル単位の削除時に一緒に削除する。
     */
    const existingRules = await kv.hGetAll(rulesKey);

    const legacyFields = Object.keys(existingRules).filter((field) => {
        return (
            field.startsWith(`${target_channel.id}:`) &&
            field !== reactionRuleField(
                target_channel.id,
                ALL_USERS_ID,
            )
        );
    });

    let removedLegacyCount = 0;

    if (legacyFields.length > 0) {
        removedLegacyCount = await kv.hDel(
            rulesKey,
            legacyFields,
        );
    }

    const removed =
        Boolean(removedAllUsersRule) ||
        removedLegacyCount > 0;

    if (removed) {
        await addAuditLog(
            interaction,
            kv,
            '自動リアクション設定削除',
            `対象チャンネル <#${target_channel.id}> の自動リアクション設定を削除しました。`,
        );
    }

    await interaction.update(
        ephemeralOptions({
            content: removed
                ? `対象チャンネル <#${target_channel.id}> の自動リアクション設定を削除しました。`
                : `対象チャンネル <#${target_channel.id}> の自動リアクション設定は見つかりませんでした。`,
            components: [],
        }),
    );
}

async function addAllowedBot(interaction, kv, user) {
    if (!user.bot) {
        await interaction.update(
            ephemeralOptions({
                content: 'Botアカウントを指定してください。',
                components: [],
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
        `自動リアクション対象としてBot <@${user.id}> を許可しました。`,
    );

    await interaction.update(
        ephemeralOptions({
            content:
                `自動リアクション対象としてBot <@${user.id}> を許可しました。`,
            components: [],
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
            `自動リアクション対象からBot <@${user.id}> を削除しました。`,
        );
    }

    await interaction.update(
        ephemeralOptions({
            content: removed
                ? `自動リアクション対象からBot <@${user.id}> を削除しました。`
                : `Bot <@${user.id}> は許可一覧にありませんでした。`,
            components: [],
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
            await showReactionSettings(interaction, kv);
            return true;
        }

        if (interaction.customId === 'reaction_menu_add') {
            await interaction.showModal(
                buildReactionTargetIdModal(),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_remove') {
            await interaction.reply(
                ephemeralOptions({
                    content:
                        '削除する自動リアクション設定の対象チャンネルまたはスレッドを選択してください。',
                    components: buildReactionChannelSelectMenu(
                        'reaction_remove_select_channel',
                        '対象チャンネルまたはスレッドを選択してください',
                    ),
                }),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_show') {
            await showAllowedBots(interaction, kv);
            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_add') {
            await interaction.showModal(
                buildAllowedBotIdModal(),
            );

            return true;
        }

        if (interaction.customId === 'reaction_menu_allow_remove') {
            await interaction.reply(
                ephemeralOptions({
                    content:
                        '自動リアクション対象から削除するBotを選択してください。',
                    components: buildReactionUserSelectMenu(
                        'reaction_allow_remove_select_user',
                        '削除するBotを選択してください',
                    ),
                }),
            );

            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (
            interaction.customId ===
            'reaction_add_select_channel'
        ) {
            const channelId = interaction.values[0];

            /*
             * チャンネル選択後にユーザーを選ばせず、
             * そのまま絵文字入力モーダルを表示する。
             */
            await interaction.showModal(
                buildReactionEmojiModal(channelId),
            );

            return true;
        }

        if (
            interaction.customId ===
            'reaction_remove_select_channel'
        ) {
            const channelId = interaction.values[0];

            const target_channel = await client.channels
                .fetch(channelId)
                .catch(() => null);

            if (
                !target_channel ||
                target_channel.guildId !== interaction.guildId
            ) {
                await interaction.update(
                    ephemeralOptions({
                        content:
                            '対象チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                        components: [],
                    }),
                );

                return true;
            }

            await removeReactionRule(
                interaction,
                kv,
                target_channel,
            );

            return true;
        }

        return false;
    }

    if (interaction.isUserSelectMenu()) {
        if (
            interaction.customId ===
            'reaction_allow_add_select_user'
        ) {
            const userId = interaction.values[0];

            const user = await client.users
                .fetch(userId)
                .catch(() => null);

            if (!user) {
                await interaction.update(
                    ephemeralOptions({
                        content:
                            '対象ユーザーが見つかりませんでした。',
                        components: [],
                    }),
                );

                return true;
            }

            await addAllowedBot(interaction, kv, user);
            return true;
        }

        if (
            interaction.customId ===
            'reaction_allow_remove_select_user'
        ) {
            const userId = interaction.values[0];

            const user = await client.users
                .fetch(userId)
                .catch(() => null);

            if (!user) {
                await interaction.update(
                    ephemeralOptions({
                        content:
                            '対象ユーザーが見つかりませんでした。',
                        components: [],
                    }),
                );

                return true;
            }

            await removeAllowedBot(interaction, kv, user);
            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (
            interaction.customId ===
            'reaction_add_target_id_modal'
        ) {
            const targetChannelId = interaction.fields
                .getTextInputValue('target_channel_id')
                .trim();

            if (!/^\d{17,20}$/.test(targetChannelId)) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '正しいチャンネルまたはスレッドIDを入力してください。数字のみで入力します。',
                    }),
                );

                return true;
            }

            const target_channel = await interaction.guild.channels
                .fetch(targetChannelId)
                .catch(() => null);

            if (!target_channel) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '指定されたチャンネルまたはスレッドが、このサーバー内に見つかりませんでした。',
                    }),
                );

                return true;
            }

            if (
                !allowedTargetTypes.includes(
                    target_channel.type,
                )
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '指定された場所にはメッセージを投稿できないため、自動リアクション対象に設定できません。',
                    }),
                );

                return true;
            }

            await interaction.showModal(
                buildReactionEmojiModal(
                    target_channel.id,
                ),
            );

            return true;
        }
        if (
            interaction.customId.startsWith(
                'reaction_add_emoji_modal:',
            )
        ) {
            const [, channelId] =
                interaction.customId.split(':');

            const target_channel = await client.channels
                .fetch(channelId)
                .catch(() => null);

            if (
                !target_channel ||
                target_channel.guildId !== interaction.guildId
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            '対象チャンネルが見つからないか、このサーバーのチャンネルではありません。',
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
                target_channel,
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