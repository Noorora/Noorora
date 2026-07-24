const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const { addAuditLog } = require('../utils/auditLog');

const {
    roleMentionTargetsKey,
    roleMentionMessageMapKey,
} = require('../keys/redisKeys');

const {
    buildRoleMentionPlaceholdersHelp,
} = require('../templates/roleMentionTemplate');

const {
    collectRoleMentionShowData,
    applyRoleMentionCleanup,
} = require('../services/roleMentionService');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function buildRoleMentionMenuContent() {
    return [
        '## 📣 ロールメンション転載設定',
        '',
        '操作を選んでください。',
        '',
        '📋 **一覧表示**',
        '現在のロールメンション転載設定を表示します。',
        '',
        '➕ **転載追加**',
        '指定ロールがメンションされた投稿を、指定チャンネルまたはスレッドへ転載します。',
        '',
        '🗑️ **転載削除**',
        '指定ロールの転載設定を削除します。',
        '',
        '🧩 **プレースホルダ**',
        'カスタム文面で使える変数を表示します。',
    ].join('\n');
}

function buildRoleMentionMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('rolemention_menu_show')
                .setLabel('一覧表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('rolemention_menu_add')
                .setLabel('転載追加')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('rolemention_menu_unset')
                .setLabel('転載削除')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId('rolemention_menu_placeholders')
                .setLabel('プレースホルダ')
                .setEmoji('🧩')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildRoleMentionRoleSelectMenu() {
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId('rolemention_add_select_role')
                .setPlaceholder('対象ロールを選択してください')
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildRoleMentionTargetChannelSelectMenu(roleId) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`rolemention_add_select_target:${roleId}`)
                .setPlaceholder('転載先チャンネルまたはスレッドを選択してください')
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

function buildRoleMentionMessageModal(roleId, targetChannelId) {
    return new ModalBuilder()
        .setCustomId(`rolemention_add_message_modal:${roleId}:${targetChannelId}`)
        .setTitle('ロールメンション転載設定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_template')
                    .setLabel('カスタム文面')
                    .setPlaceholder('送信主：{author}\\n{body_quote}\\n{link}')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false),
            ),
        );
}

function buildRoleMentionUnsetRoleSelectMenu() {
    return [
        new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId('rolemention_unset_select_role')
                .setPlaceholder('削除する転載設定のロールを選択してください')
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

async function setRoleMentionTarget(interaction, context, role, targetChannel, messageTemplate) {
    const { kv } = context;

    if (!allowedTargetTypes.includes(targetChannel.type)) {
        await interaction.reply(ephemeralOptions({
            content: 'target_channel にはチャンネルまたはスレッドを指定してください。',
        }));
        return;
    }

    await kv.hSet(
        roleMentionTargetsKey(interaction.guildId),
        role.id,
        targetChannel.id,
    );

    if (messageTemplate) {
        await kv.hSet(
            roleMentionMessageMapKey(interaction.guildId),
            role.id,
            messageTemplate,
        );
    } else {
        await kv.hDel(
            roleMentionMessageMapKey(interaction.guildId),
            role.id,
        );
    }

    await addAuditLog(
        interaction,
        kv,
        'ロールメンション転載設定追加',
        `ロール <@&${role.id}> の転載先を <#${targetChannel.id}> に設定しました。カスタム文面: ${messageTemplate ? 'あり' : 'なし'}`,
    );

    let content =
        `ロールメンション転載設定を登録しました。\n` +
        `ロール: <@&${role.id}>\n` +
        `転載先: <#${targetChannel.id}>\n` +
        `カスタムメッセージ: ${messageTemplate ? 'あり' : 'なし'}`;

    if (messageTemplate) {
        content +=
            `\n設定メッセージ:\n\`\`\`txt\n${messageTemplate.replaceAll('\\n', '\n')}\n\`\`\``;
    }

    await interaction.reply(ephemeralOptions({
        content,
    }));
}

async function showRoleMentionSettings(interaction, context) {
    const { client, kv } = context;

    let {
        validLines,
        staleEntries,
    } = await collectRoleMentionShowData(
        client,
        kv,
        interaction.guildId,
    );

    const removedLines = [];

    if (staleEntries.length > 0) {
        const cleanedLines = await applyRoleMentionCleanup(
            kv,
            interaction.guildId,
            staleEntries,
        );

        removedLines.push(...cleanedLines);

        for (const line of cleanedLines) {
            await addAuditLog(
                interaction,
                kv,
                'ロールメンション転載設定自動削除',
                line,
            );
        }

        const refreshed = await collectRoleMentionShowData(
            client,
            kv,
            interaction.guildId,
        );

        validLines = refreshed.validLines;
        staleEntries = refreshed.staleEntries;
    }

    if (
        validLines.length === 0 &&
        removedLines.length === 0
    ) {
        await interaction.reply(ephemeralOptions({
            content: 'このサーバーにはまだロールメンション転載設定がありません。',
        }));
        return;
    }

    const lines = [];

    if (removedLines.length > 0) {
        lines.push('## 自動削除した無効な設定');
        lines.push(...removedLines);
        lines.push('');
    }

    if (validLines.length > 0) {
        lines.push('## 現在のロールメンション転載設定一覧');
        lines.push(...validLines);
    } else {
        lines.push('現在有効なロールメンション転載設定はありません。');
    }

    const chunks = splitLinesToMessages(
        '',
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

async function unsetRoleMentionTarget(interaction, context, role) {
    const { kv } = context;

    const removed = await kv.hDel(
        roleMentionTargetsKey(interaction.guildId),
        role.id,
    );

    if (!removed) {
        await interaction.reply(ephemeralOptions({
            content: `ロール <@&${role.id}> の転載設定は見つかりませんでした。`,
        }));
        return;
    }

    await kv.hDel(
        roleMentionMessageMapKey(interaction.guildId),
        role.id,
    );

    await addAuditLog(
        interaction,
        kv,
        'ロールメンション転載設定削除',
        `ロール <@&${role.id}> の転載設定を削除しました。`,
    );

    await interaction.reply(ephemeralOptions({
        content: `ロール <@&${role.id}> の転載設定を削除しました。`,
    }));
}

async function execute(interaction, context) {
    await interaction.reply(ephemeralOptions({
        content: buildRoleMentionMenuContent(),
        components: buildRoleMentionMenuComponents(),
    }));
}

async function handleComponent(interaction, context) {
    const { client, kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'rolemention_menu_show') {
            await showRoleMentionSettings(
                interaction,
                context,
            );
            return true;
        }

        if (interaction.customId === 'rolemention_menu_placeholders') {
            await interaction.reply(ephemeralOptions({
                content: buildRoleMentionPlaceholdersHelp(),
            }));
            return true;
        }

        if (interaction.customId === 'rolemention_menu_add') {
            await interaction.reply(ephemeralOptions({
                content: '対象ロールを選択してください。',
                components: buildRoleMentionRoleSelectMenu(),
            }));
            return true;
        }

        if (interaction.customId === 'rolemention_menu_unset') {
            await interaction.reply(ephemeralOptions({
                content: '削除するロールメンション転載設定のロールを選択してください。',
                components: buildRoleMentionUnsetRoleSelectMenu(),
            }));
            return true;
        }

        return false;
    }

    if (interaction.isRoleSelectMenu()) {
        if (interaction.customId === 'rolemention_add_select_role') {
            const roleId = interaction.values[0];

            await interaction.update(ephemeralOptions({
                content:
                    `対象ロール: <@&${roleId}>\n` +
                    `転載先チャンネルまたはスレッドを選択してください。`,
                components: buildRoleMentionTargetChannelSelectMenu(roleId),
            }));
            return true;
        }

        if (interaction.customId === 'rolemention_unset_select_role') {
            const roleId = interaction.values[0];

            const role = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            if (!role) {
                await interaction.update(ephemeralOptions({
                    content: '選択されたロールが見つかりませんでした。',
                    components: [],
                }));
                return true;
            }

            const removed = await kv.hDel(
                roleMentionTargetsKey(interaction.guildId),
                role.id,
            );

            await kv.hDel(
                roleMentionMessageMapKey(interaction.guildId),
                role.id,
            );

            if (removed) {
                await addAuditLog(
                    interaction,
                    kv,
                    'ロールメンション転載設定削除',
                    `ロール <@&${role.id}> の転載設定を削除しました。`,
                );
            }

            await interaction.update(ephemeralOptions({
                content: removed
                    ? `ロール <@&${role.id}> の転載設定を削除しました。`
                    : `ロール <@&${role.id}> の転載設定は見つかりませんでした。`,
                components: [],
            }));
            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId.startsWith('rolemention_add_select_target:')) {
            const roleId = interaction.customId.split(':')[1];
            const targetChannelId = interaction.values[0];

            await interaction.showModal(
                buildRoleMentionMessageModal(
                    roleId,
                    targetChannelId,
                ),
            );
            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('rolemention_add_message_modal:')) {
            const [, roleId, targetChannelId] = interaction.customId.split(':');

            const role = await interaction.guild.roles
                .fetch(roleId)
                .catch(() => null);

            const targetChannel = await client.channels
                .fetch(targetChannelId)
                .catch(() => null);

            if (!role) {
                await interaction.reply(ephemeralOptions({
                    content: '選択されたロールが見つかりませんでした。',
                }));
                return true;
            }

            if (!targetChannel || targetChannel.guildId !== interaction.guildId) {
                await interaction.reply(ephemeralOptions({
                    content: '選択された転載先チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                }));
                return true;
            }

            const messageTemplateRaw = interaction.fields
                .getTextInputValue('message_template')
                .trim();

            const messageTemplate = messageTemplateRaw || null;

            await setRoleMentionTarget(
                interaction,
                context,
                role,
                targetChannel,
                messageTemplate,
            );
            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'rolemention',
    execute,
    handleComponent,
};