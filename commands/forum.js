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

const crypto = require('crypto');

const { ephemeralOptions } = require('../utils/ephemeral');
const { splitLinesToMessages } = require('../utils/messageSplit');
const {
    buildCleanupChoiceButtons,
    buildStaleSummaryContent,
} = require('../components/cleanupButtons');

const {
    pendingCleanupKey,
    forumTargetsKey,
    forumIndexKey,
    forumMessageMapKey,
} = require('../keys/redisKeys');

const { buildForumPlaceholdersHelp } = require('../templates/forumTemplate');

const {
    resolveForumIds,
    collectForumShowData,
    applyForumCleanup,
} = require('../services/forumService');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function buildForumMenuContent() {
    return [
        '## 📚 フォーラム通知設定',
        '',
        '操作を選んでください。',
        '',
        '📋 **一覧表示**',
        '現在のフォーラム通知設定を表示します。',
        '',
        '➕ **通知追加**',
        'フォーラムと通知先を一覧から選んで、通知設定を追加します。',
        '',
        '🗑️ **通知削除**',
        'フォーラム通知設定を削除します。',
        '',
        '🧩 **プレースホルダ**',
        'カスタム文面で使える変数を表示します。',
    ].join('\n');
}

function buildForumMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('forum_menu_show')
                .setLabel('一覧表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('forum_menu_add')
                .setLabel('通知追加')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('forum_menu_unset')
                .setLabel('通知削除')
                .setEmoji('🗑️')
                .setStyle(ButtonStyle.Danger),

            new ButtonBuilder()
                .setCustomId('forum_menu_placeholders')
                .setLabel('プレースホルダ')
                .setEmoji('🧩')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildForumSelectMenu() {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId('forum_add_select_forum')
                .setPlaceholder('対象フォーラムを選択してください')
                .setChannelTypes(ChannelType.GuildForum)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildTargetChannelSelectMenu(forumId) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`forum_add_select_target:${forumId}`)
                .setPlaceholder('通知先チャンネルまたはスレッドを選択してください')
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

function buildForumMessageModal(forumId, targetChannelId) {
    return new ModalBuilder()
        .setCustomId(`forum_add_message_modal:${forumId}:${targetChannelId}`)
        .setTitle('カスタム文面を設定')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('message_template')
                    .setLabel('カスタム文面')
                    .setPlaceholder('{forum} に新しいスレッド！\\nスレ主: {author}{newcomerMark}\\n{link}')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(false),
            ),
        );
}

function buildForumUnsetModal() {
    return new ModalBuilder()
        .setCustomId('forum_menu_unset_modal')
        .setTitle('フォーラム通知を削除')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('forum_id')
                    .setLabel('フォーラムID')
                    .setPlaceholder('空欄可。通知先だけ指定すると、その通知先に紐づく設定を削除')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_channel_id')
                    .setLabel('通知先チャンネルID')
                    .setPlaceholder('空欄可。フォーラムだけ指定すると、そのフォーラムの設定を全削除')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false),
            ),
        );
}

async function replyChunks(interaction, header, lines, useEphemeral = false) {
    const chunks = splitLinesToMessages(header, lines);

    if (useEphemeral) {
        await interaction.reply(ephemeralOptions({
            content: chunks[0],
        }));

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(ephemeralOptions({
                content: chunks[i],
            }));
        }

        return;
    }

    await interaction.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
    }
}

async function addForumTargets(interaction, context, options) {
    const { client, kv } = context;
    const {
        forum,
        forumIdsRaw,
        targetChannel,
        messageTemplate,
        useEphemeral = false,
    } = options;

    if ((forum && forumIdsRaw) || (!forum && !forumIdsRaw)) {
        const content = 'forum か forum_ids のどちらか片方だけを指定してください。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    if (!allowedTargetTypes.includes(targetChannel.type)) {
        const content = 'target_channel にはテキストチャンネルまたは既存スレッドを指定してください。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    const resolved = await resolveForumIds(
        client,
        interaction.guildId,
        forum,
        forumIdsRaw,
    );

    if (resolved.valid.length === 0) {
        const failLines = resolved.invalid.map((item) => {
            return `・${item.input} → ${item.reason}`;
        });

        await replyChunks(
            interaction,
            'フォーラム通知先を追加できませんでした。\n',
            failLines.length > 0 ? failLines : ['・有効なフォーラムがありませんでした'],
            useEphemeral,
        );

        return;
    }

    const successLines = [];
    const failLines = [];

    for (const forumId of resolved.valid) {
        await kv.sAdd(
            forumTargetsKey(interaction.guildId, forumId),
            targetChannel.id,
        );

        await kv.sAdd(
            forumIndexKey(interaction.guildId),
            forumId,
        );

        if (messageTemplate) {
            await kv.hSet(
                forumMessageMapKey(interaction.guildId, forumId),
                targetChannel.id,
                messageTemplate,
            );
        }

        successLines.push(`・<#${forumId}> → <#${targetChannel.id}>`);
    }

    for (const item of resolved.invalid) {
        failLines.push(`・${item.input} → ${item.reason}`);
    }

    const lines = [
        `通知先: <#${targetChannel.id}>`,
        `カスタムメッセージ: ${messageTemplate ? 'あり' : 'なし'}`,
        '',
        '成功:',
        ...successLines,
        ...(failLines.length ? ['', '失敗:', ...failLines] : []),
    ];

    const chunks = splitLinesToMessages(
        'フォーラム通知先を追加しました。\n',
        lines,
    );

    let firstContent = chunks[0];

    if (messageTemplate) {
        firstContent +=
            `\n設定メッセージ:\n\`\`\`txt\n${messageTemplate.replaceAll('\\n', '\n')}\n\`\`\``;
    }

    if (useEphemeral) {
        await interaction.reply(ephemeralOptions({
            content: firstContent,
        }));

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(ephemeralOptions({
                content: chunks[i],
            }));
        }

        return;
    }

    await interaction.reply(firstContent);

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
    }
}

async function showForumSettings(interaction, context, useEphemeral = false) {
    const { client, kv } = context;

    let {
        validLines,
        staleEntries,
    } = await collectForumShowData(
        client,
        kv,
        interaction.guildId,
    );

    const removedLines = [];

    if (staleEntries.length > 0) {
        const cleanedLines = await applyForumCleanup(
            kv,
            interaction.guildId,
            staleEntries,
        );

        removedLines.push(...cleanedLines);

        const refreshed = await collectForumShowData(
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
        const content = 'このサーバーにはまだフォーラム通知設定がありません。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    const lines = [];

    if (removedLines.length > 0) {
        lines.push('## 自動削除した無効な設定');
        lines.push(...removedLines);
        lines.push('');
    }

    if (validLines.length > 0) {
        lines.push('## 現在のフォーラム通知設定一覧');
        lines.push(...validLines);
    } else {
        lines.push('現在有効なフォーラム通知設定はありません。');
    }

    const chunks = splitLinesToMessages(
        '',
        lines,
    );

    if (useEphemeral) {
        await interaction.reply(ephemeralOptions({
            content: chunks[0],
        }));

        for (let i = 1; i < chunks.length; i++) {
            await interaction.followUp(ephemeralOptions({
                content: chunks[i],
            }));
        }

        return;
    }

    await interaction.reply(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(chunks[i]);
    }
}

async function removeForumTarget(interaction, kv, guildId, forumId, targetChannelId, useEphemeral = false) {
    const removed = await removeForumTargetCore(
        kv,
        guildId,
        forumId,
        targetChannelId,
    );

    const content = removed
        ? `フォーラム <#${forumId}> から通知先 <#${targetChannelId}> を削除しました。`
        : `フォーラム <#${forumId}> に、通知先 <#${targetChannelId}> の設定は見つかりませんでした。`;

    if (useEphemeral) {
        await interaction.reply(ephemeralOptions({ content }));
    } else {
        await interaction.reply(content);
    }
}

async function removeForumTargetCore(kv, guildId, forumId, targetChannelId) {
    const targetKey = forumTargetsKey(guildId, forumId);
    const messageKey = forumMessageMapKey(guildId, forumId);

    const removed = await kv.sRem(
        targetKey,
        targetChannelId,
    );

    if (!removed) return false;

    await kv.hDel(
        messageKey,
        targetChannelId,
    );

    const remainingTargets = await kv.sMembers(targetKey);

    if (!remainingTargets || remainingTargets.length === 0) {
        await kv.del(targetKey);
        await kv.del(messageKey);

        await kv.sRem(
            forumIndexKey(guildId),
            forumId,
        );
    }

    return true;
}

async function unsetForumTargets(interaction, context, options) {
    const { kv } = context;
    const {
        forum,
        targetChannel,
        useEphemeral = false,
    } = options;

    const guildId = interaction.guildId;

    if (!forum && !targetChannel) {
        const content = 'forum か target_channel のどちらかは指定してください。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    if (forum && forum.type !== ChannelType.GuildForum) {
        const content = 'forum にはフォーラムチャンネルを指定してください。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    if (targetChannel && !allowedTargetTypes.includes(targetChannel.type)) {
        const content = 'target_channel にはテキストチャンネルまたはスレッドを指定してください。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    const forumIds = await kv.sMembers(
        forumIndexKey(guildId),
    );

    if (!forumIds || forumIds.length === 0) {
        const content = 'このサーバーにはまだフォーラム通知設定がありません。';

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    if (forum && targetChannel) {
        await removeForumTarget(
            interaction,
            kv,
            guildId,
            forum.id,
            targetChannel.id,
            useEphemeral,
        );

        return;
    }

    if (forum && !targetChannel) {
        const targetKey = forumTargetsKey(guildId, forum.id);
        const messageKey = forumMessageMapKey(guildId, forum.id);

        const targetIds = await kv.sMembers(targetKey);

        if (!targetIds || targetIds.length === 0) {
            const content = `そのフォーラムの設定は見つかりませんでした: <#${forum.id}>`;

            if (useEphemeral) {
                await interaction.reply(ephemeralOptions({ content }));
            } else {
                await interaction.reply(content);
            }

            return;
        }

        await kv.del(targetKey);
        await kv.del(messageKey);

        await kv.sRem(
            forumIndexKey(guildId),
            forum.id,
        );

        const content = `フォーラム <#${forum.id}> に紐づく通知先をすべて削除しました。`;

        if (useEphemeral) {
            await interaction.reply(ephemeralOptions({ content }));
        } else {
            await interaction.reply(content);
        }

        return;
    }

    if (!forum && targetChannel) {
        let removedCount = 0;
        const removedLines = [];

        for (const forumId of forumIds) {
            const removed = await removeForumTargetCore(
                kv,
                guildId,
                forumId,
                targetChannel.id,
            );

            if (removed) {
                removedCount += 1;
                removedLines.push(
                    `・フォーラム <#${forumId}> から通知先 <#${targetChannel.id}> を削除`,
                );
            }
        }

        if (removedCount === 0) {
            const content = `通知先 <#${targetChannel.id}> に紐づく設定は見つかりませんでした。`;

            if (useEphemeral) {
                await interaction.reply(ephemeralOptions({ content }));
            } else {
                await interaction.reply(content);
            }

            return;
        }

        await replyChunks(
            interaction,
            `通知先 <#${targetChannel.id}> に紐づく設定を ${removedCount} 件削除しました。\n`,
            removedLines,
            useEphemeral,
        );
    }
}

async function execute(interaction, context) {
    const sub = interaction.options.getSubcommand();

    if (sub === 'menu') {
        await interaction.reply(ephemeralOptions({
            content: buildForumMenuContent(),
            components: buildForumMenuComponents(),
        }));

        return;
    }

    if (sub === 'channel') {
        const forum = interaction.options.getChannel('forum', false);
        const forumIdsRaw = interaction.options.getString('forum_ids', false);
        const targetChannel = interaction.options.getChannel('target_channel', true);
        const messageTemplate = interaction.options.getString('message', false);

        await addForumTargets(
            interaction,
            context,
            {
                forum,
                forumIdsRaw,
                targetChannel,
                messageTemplate,
                useEphemeral: false,
            },
        );

        return;
    }

    if (sub === 'placeholders') {
        await interaction.reply(ephemeralOptions({
            content: buildForumPlaceholdersHelp(),
        }));

        return;
    }

    if (sub === 'show') {
        await showForumSettings(
            interaction,
            context,
            false,
        );

        return;
    }

    if (sub === 'unset') {
        const forum = interaction.options.getChannel('forum', false);
        const targetChannel = interaction.options.getChannel('target_channel', false);

        await unsetForumTargets(
            interaction,
            context,
            {
                forum,
                targetChannel,
                useEphemeral: false,
            },
        );
    }
}

async function handleComponent(interaction, context) {
    const { client } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'forum_menu_show') {
            await showForumSettings(
                interaction,
                context,
                true,
            );

            return true;
        }

        if (interaction.customId === 'forum_menu_placeholders') {
            await interaction.reply(ephemeralOptions({
                content: buildForumPlaceholdersHelp(),
            }));

            return true;
        }

        if (interaction.customId === 'forum_menu_add') {
            await interaction.reply(ephemeralOptions({
                content: '対象フォーラムを選択してください。',
                components: buildForumSelectMenu(),
            }));

            return true;
        }

        if (interaction.customId === 'forum_menu_unset') {
            await interaction.showModal(
                buildForumUnsetModal(),
            );

            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId === 'forum_add_select_forum') {
            const forumId = interaction.values[0];

            await interaction.update(ephemeralOptions({
                content: `対象フォーラム: <#${forumId}>\n通知先チャンネルまたはスレッドを選択してください。`,
                components: buildTargetChannelSelectMenu(forumId),
            }));

            return true;
        }

        if (interaction.customId.startsWith('forum_add_select_target:')) {
            const forumId = interaction.customId.split(':')[1];
            const targetChannelId = interaction.values[0];

            await interaction.showModal(
                buildForumMessageModal(
                    forumId,
                    targetChannelId,
                ),
            );

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('forum_add_message_modal:')) {
            const [, forumId, targetChannelId] = interaction.customId.split(':');

            const forum = await client.channels
                .fetch(forumId)
                .catch(() => null);

            const targetChannel = await client.channels
                .fetch(targetChannelId)
                .catch(() => null);

            if (!forum || forum.guildId !== interaction.guildId || forum.type !== ChannelType.GuildForum) {
                await interaction.reply(ephemeralOptions({
                    content: '選択されたフォーラムが見つからないか、このサーバーのフォーラムではありません。',
                }));

                return true;
            }

            if (!targetChannel || targetChannel.guildId !== interaction.guildId) {
                await interaction.reply(ephemeralOptions({
                    content: '選択された通知先チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                }));

                return true;
            }

            const messageTemplateRaw = interaction.fields
                .getTextInputValue('message_template')
                .trim();

            const messageTemplate = messageTemplateRaw || null;

            await addForumTargets(
                interaction,
                context,
                {
                    forum,
                    forumIdsRaw: null,
                    targetChannel,
                    messageTemplate,
                    useEphemeral: true,
                },
            );

            return true;
        }

        if (interaction.customId === 'forum_menu_unset_modal') {
            const forumIdRaw = interaction.fields
                .getTextInputValue('forum_id')
                .trim();

            const targetChannelIdRaw = interaction.fields
                .getTextInputValue('target_channel_id')
                .trim();

            const forum = forumIdRaw
                ? await client.channels.fetch(forumIdRaw).catch(() => null)
                : null;

            const targetChannel = targetChannelIdRaw
                ? await client.channels.fetch(targetChannelIdRaw).catch(() => null)
                : null;

            if (forumIdRaw && (!forum || forum.guildId !== interaction.guildId)) {
                await interaction.reply(ephemeralOptions({
                    content: 'フォーラムIDが正しくないか、このサーバーのフォーラムではありません。',
                }));

                return true;
            }

            if (targetChannelIdRaw && (!targetChannel || targetChannel.guildId !== interaction.guildId)) {
                await interaction.reply(ephemeralOptions({
                    content: '通知先チャンネルIDが正しくないか、このサーバーのチャンネルではありません。',
                }));

                return true;
            }

            await unsetForumTargets(
                interaction,
                context,
                {
                    forum,
                    targetChannel,
                    useEphemeral: true,
                },
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'forum',
    execute,
    handleComponent,
};