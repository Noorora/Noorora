const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ChannelType,
    ChannelSelectMenuBuilder,
    WebhookClient,
} = require('discord.js');

const { ephemeralOptions } = require('../utils/ephemeral');
const { addAuditLog } = require('../utils/auditLog');

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDateTime(timestamp) {
    return new Date(timestamp).toLocaleString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

function splitText(text, maxLength = 1800) {
    const chunks = [];
    let current = '';

    for (const line of text.split('\n')) {
        const next = current ? `${current}\n${line}` : line;

        if (next.length > maxLength) {
            if (current) {
                chunks.push(current);
            }

            current = line.length > maxLength
                ? line.slice(0, maxLength)
                : line;
        } else {
            current = next;
        }
    }

    if (current.trim()) {
        chunks.push(current);
    }

    return chunks;
}

function buildForumLogMenuContent() {
    return [
        '## 🗄️ フォーラムログ出力',
        '',
        '操作を選んでください。',
        '',
        '📋 **説明表示**',
        'フォーラムログ出力機能の説明を表示します。',
        '',
        '➕ **チャンネルへ出力**',
        '指定フォーラム内のスレッド投稿ログを、このサーバー内のチャンネルまたはスレッドへ出力します。',
        '',
        '🌐 **Webhookへ出力**',
        '指定フォーラム内のスレッド投稿ログを、Webhook経由で別サーバーなどへ出力します。',
    ].join('\n');
}

function buildForumLogMenuComponents() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('forumlog_menu_help')
                .setLabel('説明表示')
                .setEmoji('📋')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId('forumlog_menu_archive_channel')
                .setLabel('チャンネルへ出力')
                .setEmoji('➕')
                .setStyle(ButtonStyle.Success),

            new ButtonBuilder()
                .setCustomId('forumlog_menu_archive_webhook')
                .setLabel('Webhookへ出力')
                .setEmoji('🌐')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildForumLogHelpContent() {
    return [
        '## 🗄️ フォーラムログ出力について',
        '',
        '指定したフォーラムの中にあるスレッドを取得し、各スレッド内の投稿ログを保存先へ出力します。',
        '',
        '出力される内容:',
        '・スレッド名',
        '・作成日時',
        '・投稿者',
        '・本文',
        '・添付ファイルURL',
        '・元メッセージリンク',
        '',
        '保存先:',
        '・同じサーバー内のチャンネルまたはスレッド',
        '・Webhook URL',
        '',
        '注意:',
        '・投稿数が多いフォーラムでは時間がかかります。',
        '・同じ操作を複数回実行すると、ログが重複して出力されます。',
        '・Bot投稿を含めるかどうかは、実行前に選択できます。',
    ].join('\n');
}

function buildForumSelectMenu(customId, placeholder) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder(placeholder)
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
                .setCustomId(`forumlog_channel_select_target:${forumId}`)
                .setPlaceholder('ログ保存先チャンネルまたはスレッドを選択してください')
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

function buildIncludeBotsButtonsForChannel(forumId, targetChannelId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`forumlog_archive_channel:${forumId}:${targetChannelId}:false`)
                .setLabel('Bot投稿を含めない')
                .setEmoji('👤')
                .setStyle(ButtonStyle.Primary),

            new ButtonBuilder()
                .setCustomId(`forumlog_archive_channel:${forumId}:${targetChannelId}:true`)
                .setLabel('Bot投稿も含める')
                .setEmoji('🤖')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildWebhookArchiveModal(forumId) {
    return new ModalBuilder()
        .setCustomId(`forumlog_webhook_modal:${forumId}`)
        .setTitle('Webhookへフォーラムログ出力')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('target_webhook_url')
                    .setLabel('保存先Webhook URL')
                    .setPlaceholder('https://discord.com/api/webhooks/...')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('include_bots')
                    .setLabel('Bot投稿も含めるか')
                    .setPlaceholder('true または false。空欄なら false')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(false),
            ),
        );
}

function parseIncludeBotsInput(raw) {
    const value = String(raw || '').trim().toLowerCase();

    return (
        value === 'true' ||
        value === 'yes' ||
        value === 'y' ||
        value === '1' ||
        value === 'はい'
    );
}

async function sendLogMessage(targetChannel, webhookClient, text) {
    const chunks = splitText(text);

    for (const chunk of chunks) {
        if (targetChannel) {
            await targetChannel.send({
                content: chunk,
                allowedMentions: {
                    parse: [],
                },
            });
        } else {
            await webhookClient.send({
                content: chunk,
                allowedMentions: {
                    parse: [],
                },
            });
        }

        await sleep(250);
    }
}

async function fetchAllForumThreads(forumChannel) {
    const threads = new Map();

    const active = await forumChannel.threads.fetchActive().catch(() => null);

    if (active?.threads) {
        for (const thread of active.threads.values()) {
            threads.set(thread.id, thread);
        }
    }

    let before;

    while (true) {
        const options = {
            type: 'public',
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const archived = await forumChannel.threads
            .fetchArchived(options)
            .catch(() => null);

        if (!archived?.threads || archived.threads.size === 0) {
            break;
        }

        for (const thread of archived.threads.values()) {
            threads.set(thread.id, thread);
        }

        const sortedThreads = [...archived.threads.values()].sort((a, b) => {
            const aTime = a.archiveTimestamp || a.createdTimestamp || 0;
            const bTime = b.archiveTimestamp || b.createdTimestamp || 0;
            return aTime - bTime;
        });

        const oldestThread = sortedThreads[0];

        if (!oldestThread) {
            break;
        }

        before = oldestThread.archiveTimestamp
            ? new Date(oldestThread.archiveTimestamp)
            : oldestThread.id;

        if (archived.threads.size < 100 || archived.hasMore === false) {
            break;
        }

        await sleep(500);
    }

    return [...threads.values()].sort((a, b) => {
        return a.createdTimestamp - b.createdTimestamp;
    });
}

async function fetchAllMessagesFromThread(thread, includeBots) {
    const messages = [];
    let before;

    while (true) {
        const options = {
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const batch = await thread.messages.fetch(options).catch(() => null);

        if (!batch || batch.size === 0) {
            break;
        }

        for (const message of batch.values()) {
            if (!includeBots && message.author.bot) {
                continue;
            }

            messages.push(message);
        }

        const lastMessage = batch.last();

        if (!lastMessage) {
            break;
        }

        before = lastMessage.id;

        if (batch.size < 100) {
            break;
        }

        await sleep(350);
    }

    return messages.sort((a, b) => {
        return a.createdTimestamp - b.createdTimestamp;
    });
}

function buildMessageLog(thread, message) {
    const authorLabel = `${message.author.tag || message.author.username} (<@${message.author.id}>)`;
    const content = message.content?.trim() || '（本文なし）';

    const attachments = message.attachments.size > 0
        ? [...message.attachments.values()]
            .map((attachment) => `添付: ${attachment.url}`)
            .join('\n')
        : '';

    return [
        `**[${formatDateTime(message.createdTimestamp)}] ${authorLabel}**`,
        `スレッド: ${thread.name}`,
        content,
        attachments,
        `リンク: ${message.url}`,
    ].filter(Boolean).join('\n');
}

async function archiveForumLogs(interaction, options) {
    const {
        forumChannel,
        targetChannel = null,
        targetWebhookUrl = null,
        includeBots = false,
        alreadyAcknowledged = false,
    } = options;

    if (forumChannel.type !== ChannelType.GuildForum) {
        const content = 'forum にはフォーラムチャンネルを指定してください。';

        if (alreadyAcknowledged) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply(ephemeralOptions({ content }));
        }

        return;
    }

    if (!targetChannel && !targetWebhookUrl) {
        const content = 'target_channel または target_webhook_url のどちらかを指定してください。';

        if (alreadyAcknowledged) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply(ephemeralOptions({ content }));
        }

        return;
    }

    if (targetChannel && targetWebhookUrl) {
        const content = 'target_channel と target_webhook_url は同時に指定できません。どちらか片方だけ指定してください。';

        if (alreadyAcknowledged) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply(ephemeralOptions({ content }));
        }

        return;
    }

    if (targetChannel) {
        if (
            !allowedTargetTypes.includes(targetChannel.type) ||
            typeof targetChannel.send !== 'function'
        ) {
            const content = 'target_channel にはテキストチャンネルまたはスレッドを指定してください。';

            if (alreadyAcknowledged) {
                await interaction.editReply({ content });
            } else {
                await interaction.reply(ephemeralOptions({ content }));
            }

            return;
        }
    }

    let webhookClient = null;

    if (targetWebhookUrl) {
        if (!targetWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
            const content = 'Webhook URL の形式が正しくありません。';

            if (alreadyAcknowledged) {
                await interaction.editReply({ content });
            } else {
                await interaction.reply(ephemeralOptions({ content }));
            }

            return;
        }

        webhookClient = new WebhookClient({
            url: targetWebhookUrl,
        });
    }

    if (!alreadyAcknowledged) {
        await interaction.deferReply(ephemeralOptions());
    }

    const startedAt = Date.now();
    const threads = await fetchAllForumThreads(forumChannel);

    const destinationLabel = targetChannel
        ? `<#${targetChannel.id}>`
        : 'Webhook URL';

    await addAuditLog(
        interaction,
        interaction.client.kv || options.kv || null,
        'フォーラムログ出力開始',
        `対象フォーラム <#${forumChannel.id}> のログ出力を開始しました。出力先: ${destinationLabel} / Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `フォーラムログの出力を開始します。\n` +
            `対象フォーラム: <#${forumChannel.id}>\n` +
            `ログ送信先: ${destinationLabel}\n` +
            `取得したスレッド数: ${threads.length}\n` +
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    });

    await sendLogMessage(
        targetChannel,
        webhookClient,
        [
            '## フォーラム過去ログ出力開始',
            `対象フォーラム: <#${forumChannel.id}> (${forumChannel.name})`,
            `取得したスレッド数: ${threads.length}`,
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
            `開始時刻: ${formatDateTime(startedAt)}`,
        ].join('\n'),
    );

    let totalMessages = 0;
    let processedThreads = 0;

    for (const thread of threads) {
        processedThreads += 1;

        const messages = await fetchAllMessagesFromThread(
            thread,
            includeBots,
        );

        totalMessages += messages.length;

        await sendLogMessage(
            targetChannel,
            webhookClient,
            [
                '---',
                `## スレッド: ${thread.name}`,
                `スレッド: <#${thread.id}>`,
                `作成日時: ${formatDateTime(thread.createdTimestamp)}`,
                `メッセージ数: ${messages.length}`,
                `URL: https://discord.com/channels/${thread.guildId}/${thread.id}`,
            ].join('\n'),
        );

        if (messages.length === 0) {
            await sendLogMessage(
                targetChannel,
                webhookClient,
                '（保存対象メッセージなし）',
            );
        } else {
            for (const message of messages) {
                await sendLogMessage(
                    targetChannel,
                    webhookClient,
                    buildMessageLog(thread, message),
                );
            }
        }

        if (processedThreads % 5 === 0 || processedThreads === threads.length) {
            await interaction.editReply({
                content:
                    `フォーラムログを出力中です。\n` +
                    `対象フォーラム: <#${forumChannel.id}>\n` +
                    `進捗: ${processedThreads}/${threads.length} スレッド\n` +
                    `出力済みメッセージ数: ${totalMessages}`,
            }).catch(() => null);
        }

        await sleep(750);
    }

    const finishedAt = Date.now();

    await sendLogMessage(
        targetChannel,
        webhookClient,
        [
            '## フォーラム過去ログ出力完了',
            `対象フォーラム: <#${forumChannel.id}> (${forumChannel.name})`,
            `処理スレッド数: ${processedThreads}`,
            `出力メッセージ数: ${totalMessages}`,
            `完了時刻: ${formatDateTime(finishedAt)}`,
            `処理時間: ${Math.round((finishedAt - startedAt) / 1000)}秒`,
        ].join('\n'),
    );

    await addAuditLog(
        interaction,
        interaction.client.kv || options.kv || null,
        'フォーラムログ出力完了',
        `対象フォーラム <#${forumChannel.id}> のログ出力が完了しました。処理スレッド数: ${processedThreads} / 出力メッセージ数: ${totalMessages} / 出力先: ${destinationLabel}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `フォーラムログの出力が完了しました。\n` +
            `対象フォーラム: <#${forumChannel.id}>\n` +
            `処理スレッド数: ${processedThreads}\n` +
            `出力メッセージ数: ${totalMessages}\n` +
            `ログ送信先: ${destinationLabel}`,
    });
}

async function execute(interaction) {
    await interaction.reply(
        ephemeralOptions({
            content: buildForumLogMenuContent(),
            components: buildForumLogMenuComponents(),
        }),
    );
}

async function handleComponent(interaction, context) {
    const { client, kv } = context;

    if (interaction.isButton()) {
        if (interaction.customId === 'forumlog_menu_help') {
            await interaction.reply(ephemeralOptions({
                content: buildForumLogHelpContent(),
            }));
            return true;
        }

        if (interaction.customId === 'forumlog_menu_archive_channel') {
            await interaction.reply(ephemeralOptions({
                content: 'ログ出力対象のフォーラムを選択してください。',
                components: buildForumSelectMenu(
                    'forumlog_channel_select_forum',
                    'ログ出力対象のフォーラムを選択してください',
                ),
            }));
            return true;
        }

        if (interaction.customId === 'forumlog_menu_archive_webhook') {
            await interaction.reply(ephemeralOptions({
                content: 'ログ出力対象のフォーラムを選択してください。',
                components: buildForumSelectMenu(
                    'forumlog_webhook_select_forum',
                    'ログ出力対象のフォーラムを選択してください',
                ),
            }));
            return true;
        }

        if (interaction.customId.startsWith('forumlog_archive_channel:')) {
            const [, forumId, targetChannelId, includeBotsRaw] = interaction.customId.split(':');

            const forumChannel = await client.channels
                .fetch(forumId)
                .catch(() => null);

            const targetChannel = await client.channels
                .fetch(targetChannelId)
                .catch(() => null);

            if (!forumChannel || forumChannel.guildId !== interaction.guildId) {
                await interaction.update({
                    content: '対象フォーラムが見つからないか、このサーバーのフォーラムではありません。',
                    components: [],
                });
                return true;
            }

            if (!targetChannel || targetChannel.guildId !== interaction.guildId) {
                await interaction.update({
                    content: '保存先チャンネルが見つからないか、このサーバーのチャンネルではありません。',
                    components: [],
                });
                return true;
            }

            const includeBots = includeBotsRaw === 'true';

            await interaction.update({
                content:
                    `フォーラムログの出力準備を開始します。\n` +
                    `対象フォーラム: <#${forumChannel.id}>\n` +
                    `ログ送信先: <#${targetChannel.id}>\n` +
                    `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
                components: [],
            });

            await archiveForumLogs(
                interaction,
                {
                    forumChannel,
                    targetChannel,
                    targetWebhookUrl: null,
                    includeBots,
                    alreadyAcknowledged: true,
                    kv,
                },
            );

            return true;
        }

        return false;
    }

    if (interaction.isChannelSelectMenu()) {
        if (interaction.customId === 'forumlog_channel_select_forum') {
            const forumId = interaction.values[0];

            await interaction.update({
                content:
                    `対象フォーラム: <#${forumId}>\n` +
                    `ログ保存先チャンネルまたはスレッドを選択してください。`,
                components: buildTargetChannelSelectMenu(forumId),
            });

            return true;
        }

        if (interaction.customId.startsWith('forumlog_channel_select_target:')) {
            const forumId = interaction.customId.split(':')[1];
            const targetChannelId = interaction.values[0];

            await interaction.update({
                content:
                    `対象フォーラム: <#${forumId}>\n` +
                    `ログ送信先: <#${targetChannelId}>\n` +
                    `Bot投稿を含めますか？`,
                components: buildIncludeBotsButtonsForChannel(
                    forumId,
                    targetChannelId,
                ),
            });

            return true;
        }

        if (interaction.customId === 'forumlog_webhook_select_forum') {
            const forumId = interaction.values[0];

            await interaction.showModal(
                buildWebhookArchiveModal(forumId),
            );

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('forumlog_webhook_modal:')) {
            const forumId = interaction.customId.split(':')[1];

            const forumChannel = await client.channels
                .fetch(forumId)
                .catch(() => null);

            if (!forumChannel || forumChannel.guildId !== interaction.guildId) {
                await interaction.reply(ephemeralOptions({
                    content: '対象フォーラムが見つからないか、このサーバーのフォーラムではありません。',
                }));
                return true;
            }

            const targetWebhookUrl = interaction.fields
                .getTextInputValue('target_webhook_url')
                .trim();

            const includeBotsRaw = interaction.fields
                .getTextInputValue('include_bots')
                .trim();

            const includeBots = parseIncludeBotsInput(includeBotsRaw);

            if (!targetWebhookUrl.startsWith('https://discord.com/api/webhooks/')) {
                await interaction.reply(ephemeralOptions({
                    content: 'Webhook URL の形式が正しくありません。',
                }));
                return true;
            }

            await interaction.deferReply(ephemeralOptions());

            await archiveForumLogs(
                interaction,
                {
                    forumChannel,
                    targetChannel: null,
                    targetWebhookUrl,
                    includeBots,
                    alreadyAcknowledged: true,
                    kv,
                },
            );

            return true;
        }

        return false;
    }

    return false;
}

module.exports = {
    name: 'forumlog',
    execute,
    handleComponent,
};