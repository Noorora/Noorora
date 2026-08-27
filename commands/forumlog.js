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

const allowedSourceTypes = [
    ChannelType.GuildForum,
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

const allowedTargetTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
];

function sleep(milliseconds) {
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
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

    for (const line of String(text).split('\n')) {
        if (line.length > maxLength) {
            if (current) {
                chunks.push(current);
                current = '';
            }

            for (let index = 0; index < line.length; index += maxLength) {
                chunks.push(line.slice(index, index + maxLength));
            }

            continue;
        }

        const next = current ? `${current}\n${line}` : line;

        if (next.length > maxLength) {
            if (current) {
                chunks.push(current);
            }
            current = line;
        } else {
            current = next;
        }
    }

    if (current.trim()) {
        chunks.push(current);
    }

    return chunks;
}

function buildMenuContent() {
    return [
        '## 🗄️ チャンネルログ出力',
        '',
        'ログ出力元として、フォーラム、通常チャンネル、またはスレッドを選択できます。',
        '',
        '➕ **チャンネルへ出力**',
        '選択したログ出力元の過去ログを、同じサーバー内のチャンネルまたはスレッドへ出力します。',
        '',
        '🌐 **Webhookへ出力**',
        '選択したログ出力元の過去ログを、Webhook経由で出力します。',
        '',
        '📋 **説明表示**',
        '機能の詳細と注意事項を表示します。',
    ].join('\n');
}

function buildMenuComponents() {
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

function buildHelpContent() {
    return [
        '## 🗄️ チャンネルログ出力について',
        '',
        'ログ出力元として選べるもの:',
        '・フォーラムチャンネル',
        '・テキストチャンネル',
        '・アナウンスチャンネル',
        '・公開スレッド',
        '・非公開スレッド',
        '・アナウンススレッド',
        '',
        'フォーラムを選択した場合:',
        '・フォーラム内のアクティブなスレッドを取得します。',
        '・フォーラム内のアーカイブ済み公開スレッドも取得します。',
        '・各スレッド内の投稿を出力します。',
        '',
        '通常チャンネルまたはスレッドを選択した場合:',
        '・選択した場所のメッセージ履歴を直接取得して出力します。',
        '',
        '出力される内容:',
        '・投稿日時',
        '・投稿者',
        '・本文',
        '・添付ファイルURL',
        '・元メッセージリンク',
        '',
        '注意:',
        '・Botにはログ出力元の「チャンネルを見る」と「メッセージ履歴を読む」権限が必要です。',
        '・チャンネルへ出力する場合は、出力先で「メッセージを送信」できる必要があります。',
        '・同じ操作を複数回行うと、ログが重複して出力されます。',
        '・投稿数が多い場合は処理に時間がかかります。',
        '・Bot投稿を含めるかどうかは実行前に選択できます。',
    ].join('\n');
}

function buildSourceSelectMenu(customId) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(customId)
                .setPlaceholder('ログ出力元を選択してください')
                .setChannelTypes(...allowedSourceTypes)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildTargetSelectMenu(sourceChannelId) {
    return [
        new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`forumlog_channel_select_target:${sourceChannelId}`)
                .setPlaceholder('ログ保存先を選択してください')
                .setChannelTypes(...allowedTargetTypes)
                .setMinValues(1)
                .setMaxValues(1),
        ),
    ];
}

function buildIncludeBotsButtonsForChannel(
    sourceChannelId,
    targetChannelId,
) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(
                    `forumlog_archive_channel:${sourceChannelId}:${targetChannelId}:false`,
                )
                .setLabel('Bot投稿を含めない')
                .setEmoji('👤')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(
                    `forumlog_archive_channel:${sourceChannelId}:${targetChannelId}:true`,
                )
                .setLabel('Bot投稿も含める')
                .setEmoji('🤖')
                .setStyle(ButtonStyle.Secondary),
        ),
    ];
}

function buildWebhookArchiveModal(sourceChannelId) {
    return new ModalBuilder()
        .setCustomId(`forumlog_webhook_modal:${sourceChannelId}`)
        .setTitle('Webhookへログ出力')
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

    return [
        'true',
        'yes',
        'y',
        '1',
        'はい',
    ].includes(value);
}

function isForumChannel(channel) {
    return channel.type === ChannelType.GuildForum;
}

function isValidSourceChannel(channel) {
    return (
        channel &&
        allowedSourceTypes.includes(channel.type)
    );
}

function isValidTargetChannel(channel) {
    return (
        channel &&
        allowedTargetTypes.includes(channel.type) &&
        typeof channel.send === 'function'
    );
}

function getSourceLabel(source_channel) {
    if (isForumChannel(source_channel)) {
        return `フォーラム <#${source_channel.id}> (${source_channel.name})`;
    }

    if (source_channel.isThread?.()) {
        return `スレッド <#${source_channel.id}> (${source_channel.name})`;
    }

    return `チャンネル <#${source_channel.id}> (${source_channel.name})`;
}

async function sendLogMessage(
    target_channel,
    webhookClient,
    text,
) {
    const chunks = splitText(text);

    for (const chunk of chunks) {
        const payload = {
            content: chunk,
            allowedMentions: {
                parse: [],
            },
        };

        if (target_channel) {
            await target_channel.send(payload);
        } else {
            await webhookClient.send(payload);
        }

        await sleep(250);
    }
}

async function fetchAllMessages(
    source_channel,
    includeBots,
) {
    const messages = [];
    let beforeMessageId;

    while (true) {
        const fetchOptions = {
            limit: 100,
        };

        if (beforeMessageId) {
            fetchOptions.before = beforeMessageId;
        }

        const batch = await source_channel.messages
            .fetch(fetchOptions)
            .catch(() => null);

        if (!batch || batch.size === 0) {
            break;
        }

        for (const message of batch.values()) {
            if (!includeBots && message.author.bot) {
                continue;
            }

            messages.push(message);
        }

        const oldestMessage = batch.last();

        if (!oldestMessage || batch.size < 100) {
            break;
        }

        beforeMessageId = oldestMessage.id;
        await sleep(350);
    }

    return messages.sort((a, b) => {
        return a.createdTimestamp - b.createdTimestamp;
    });
}

async function fetchAllForumThreads(forumChannel) {
    const threadMap = new Map();

    const activeResult = await forumChannel.threads
        .fetchActive()
        .catch(() => null);

    if (activeResult?.threads) {
        for (const thread of activeResult.threads.values()) {
            threadMap.set(thread.id, thread);
        }
    }

    let before;

    while (true) {
        const fetchOptions = {
            type: 'public',
            limit: 100,
        };

        if (before) {
            fetchOptions.before = before;
        }

        const archivedResult = await forumChannel.threads
            .fetchArchived(fetchOptions)
            .catch(() => null);

        if (
            !archivedResult?.threads ||
            archivedResult.threads.size === 0
        ) {
            break;
        }

        for (const thread of archivedResult.threads.values()) {
            threadMap.set(thread.id, thread);
        }

        const archivedThreads = [
            ...archivedResult.threads.values(),
        ];

        archivedThreads.sort((left, right) => {
            const leftTime =
                left.archiveTimestamp ||
                left.createdTimestamp ||
                0;

            const rightTime =
                right.archiveTimestamp ||
                right.createdTimestamp ||
                0;

            return leftTime - rightTime;
        });

        const oldestThread = archivedThreads[0];

        if (!oldestThread) {
            break;
        }

        before = oldestThread.archiveTimestamp
            ? new Date(oldestThread.archiveTimestamp)
            : oldestThread.id;

        if (
            archivedResult.threads.size < 100 ||
            archivedResult.hasMore === false
        ) {
            break;
        }

        await sleep(500);
    }

    return [...threadMap.values()].sort((left, right) => {
        return left.createdTimestamp - right.createdTimestamp;
    });
}

function buildMessageLog(
    source_channel,
    message,
) {
    const authorLabel =
        `${message.author.tag || message.author.username} ` +
        `(<@${message.author.id}>)`;

    const content =
        message.content?.trim() ||
        '（本文なし）';

    const attachments =
        message.attachments.size > 0
            ? [...message.attachments.values()]
                .map((attachment) => {
                    return `添付: ${attachment.url}`;
                })
                .join('\n')
            : '';

    return [
        `**[${formatDateTime(message.createdTimestamp)}] ${authorLabel}**`,
        getSourceLabel(source_channel),
        content,
        attachments,
        `リンク: ${message.url}`,
    ].filter(Boolean).join('\n');
}

async function createOutputDestination(
    target_channel,
    targetWebhookUrl,
) {
    if (target_channel && targetWebhookUrl) {
        return {
            error:
                'target_channel と target_webhook_url は同時に指定できません。',
            webhookClient: null,
            destinationLabel: null,
        };
    }

    if (!target_channel && !targetWebhookUrl) {
        return {
            error:
                'ログ保存先チャンネルまたはWebhook URLを指定してください。',
            webhookClient: null,
            destinationLabel: null,
        };
    }

    if (
        target_channel &&
        !isValidTargetChannel(target_channel)
    ) {
        return {
            error:
                'ログ保存先には、テキストチャンネル、アナウンスチャンネル、またはスレッドを指定してください。',
            webhookClient: null,
            destinationLabel: null,
        };
    }

    if (targetWebhookUrl) {
        if (
            !targetWebhookUrl.startsWith(
                'https://discord.com/api/webhooks/',
            )
        ) {
            return {
                error: 'Webhook URL の形式が正しくありません。',
                webhookClient: null,
                destinationLabel: null,
            };
        }

        return {
            error: null,
            webhookClient: new WebhookClient({
                url: targetWebhookUrl,
            }),
            destinationLabel: 'Webhook URL',
        };
    }

    return {
        error: null,
        webhookClient: null,
        destinationLabel: `<#${target_channel.id}>`,
    };
}

async function sendArchiveStart(
    target_channel,
    webhookClient,
    source_channel,
    includeBots,
    itemCount,
) {
    await sendLogMessage(
        target_channel,
        webhookClient,
        [
            '## 過去ログ出力開始',
            `ログ出力元: ${getSourceLabel(source_channel)}`,
            `取得対象数: ${itemCount}`,
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
            `開始時刻: ${formatDateTime(Date.now())}`,
        ].join('\n'),
    );
}

async function sendArchiveFinish(
    target_channel,
    webhookClient,
    source_channel,
    messageCount,
    startedAt,
) {
    const finishedAt = Date.now();

    await sendLogMessage(
        target_channel,
        webhookClient,
        [
            '## 過去ログ出力完了',
            `ログ出力元: ${getSourceLabel(source_channel)}`,
            `出力メッセージ数: ${messageCount}`,
            `完了時刻: ${formatDateTime(finishedAt)}`,
            `処理時間: ${Math.round((finishedAt - startedAt) / 1000)}秒`,
        ].join('\n'),
    );
}

async function archiveDirectChannelLogs(
    interaction,
    options,
) {
    const {
        source_channel,
        target_channel,
        webhookClient,
        destinationLabel,
        includeBots,
        kv,
    } = options;

    const startedAt = Date.now();

    const messages = await fetchAllMessages(
        source_channel,
        includeBots,
    );

    await addAuditLog(
        interaction,
        kv,
        'チャンネルログ出力開始',
        `${getSourceLabel(source_channel)} のログ出力を開始しました。` +
        `出力先: ${destinationLabel} / ` +
        `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `過去ログの出力を開始します。\n` +
            `ログ出力元: ${getSourceLabel(source_channel)}\n` +
            `ログ送信先: ${destinationLabel}\n` +
            `取得したメッセージ数: ${messages.length}\n` +
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    });

    await sendArchiveStart(
        target_channel,
        webhookClient,
        source_channel,
        includeBots,
        messages.length,
    );

    for (let index = 0; index < messages.length; index++) {
        await sendLogMessage(
            target_channel,
            webhookClient,
            buildMessageLog(
                source_channel,
                messages[index],
            ),
        );

        if (
            (index + 1) % 25 === 0 ||
            index + 1 === messages.length
        ) {
            await interaction.editReply({
                content:
                    `過去ログを出力中です。\n` +
                    `ログ出力元: ${getSourceLabel(source_channel)}\n` +
                    `進捗: ${index + 1}/${messages.length} メッセージ`,
            }).catch(() => null);
        }
    }

    await sendArchiveFinish(
        target_channel,
        webhookClient,
        source_channel,
        messages.length,
        startedAt,
    );

    await addAuditLog(
        interaction,
        kv,
        'チャンネルログ出力完了',
        `${getSourceLabel(source_channel)} のログ出力が完了しました。` +
        `出力メッセージ数: ${messages.length} / ` +
        `出力先: ${destinationLabel}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `過去ログの出力が完了しました。\n` +
            `ログ出力元: ${getSourceLabel(source_channel)}\n` +
            `出力メッセージ数: ${messages.length}\n` +
            `ログ送信先: ${destinationLabel}`,
    });
}

async function archiveForumLogs(
    interaction,
    options,
) {
    const {
        source_channel,
        target_channel,
        webhookClient,
        destinationLabel,
        includeBots,
        kv,
    } = options;

    const startedAt = Date.now();

    const threads = await fetchAllForumThreads(
        source_channel,
    );

    await addAuditLog(
        interaction,
        kv,
        'フォーラムログ出力開始',
        `${getSourceLabel(source_channel)} のログ出力を開始しました。` +
        `出力先: ${destinationLabel} / ` +
        `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `フォーラムログの出力を開始します。\n` +
            `ログ出力元: ${getSourceLabel(source_channel)}\n` +
            `ログ送信先: ${destinationLabel}\n` +
            `取得したスレッド数: ${threads.length}\n` +
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    });

    await sendArchiveStart(
        target_channel,
        webhookClient,
        source_channel,
        includeBots,
        threads.length,
    );

    let totalMessages = 0;
    let processedThreads = 0;

    for (const thread of threads) {
        processedThreads++;

        const messages = await fetchAllMessages(
            thread,
            includeBots,
        );

        totalMessages += messages.length;

        await sendLogMessage(
            target_channel,
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
                target_channel,
                webhookClient,
                '（保存対象メッセージなし）',
            );
        } else {
            for (const message of messages) {
                await sendLogMessage(
                    target_channel,
                    webhookClient,
                    buildMessageLog(thread, message),
                );
            }
        }

        if (
            processedThreads % 5 === 0 ||
            processedThreads === threads.length
        ) {
            await interaction.editReply({
                content:
                    `フォーラムログを出力中です。\n` +
                    `ログ出力元: ${getSourceLabel(source_channel)}\n` +
                    `進捗: ${processedThreads}/${threads.length} スレッド\n` +
                    `出力済みメッセージ数: ${totalMessages}`,
            }).catch(() => null);
        }

        await sleep(750);
    }

    await sendArchiveFinish(
        target_channel,
        webhookClient,
        source_channel,
        totalMessages,
        startedAt,
    );

    await addAuditLog(
        interaction,
        kv,
        'フォーラムログ出力完了',
        `${getSourceLabel(source_channel)} のログ出力が完了しました。` +
        `処理スレッド数: ${processedThreads} / ` +
        `出力メッセージ数: ${totalMessages} / ` +
        `出力先: ${destinationLabel}`,
    ).catch(() => null);

    await interaction.editReply({
        content:
            `フォーラムログの出力が完了しました。\n` +
            `ログ出力元: ${getSourceLabel(source_channel)}\n` +
            `処理スレッド数: ${processedThreads}\n` +
            `出力メッセージ数: ${totalMessages}\n` +
            `ログ送信先: ${destinationLabel}`,
    });
}

async function archiveSourceLogs(
    interaction,
    options,
) {
    const {
        source_channel,
        target_channel = null,
        targetWebhookUrl = null,
        includeBots = false,
        alreadyAcknowledged = false,
        kv = null,
    } = options;

    if (!isValidSourceChannel(source_channel)) {
        const content =
            'ログ出力元には、フォーラム、テキストチャンネル、アナウンスチャンネル、またはスレッドを指定してください。';

        if (alreadyAcknowledged) {
            await interaction.editReply({ content });
        } else {
            await interaction.reply(
                ephemeralOptions({ content }),
            );
        }

        return;
    }

    const destination = await createOutputDestination(
        target_channel,
        targetWebhookUrl,
    );

    if (destination.error) {
        if (alreadyAcknowledged) {
            await interaction.editReply({
                content: destination.error,
            });
        } else {
            await interaction.reply(
                ephemeralOptions({
                    content: destination.error,
                }),
            );
        }

        return;
    }

    if (!alreadyAcknowledged) {
        await interaction.deferReply(
            ephemeralOptions(),
        );
    }

    try {
        const archiveOptions = {
            source_channel,
            target_channel,
            webhookClient: destination.webhookClient,
            destinationLabel: destination.destinationLabel,
            includeBots,
            kv,
        };

        if (isForumChannel(source_channel)) {
            await archiveForumLogs(
                interaction,
                archiveOptions,
            );
        } else {
            await archiveDirectChannelLogs(
                interaction,
                archiveOptions,
            );
        }
    } finally {
        destination.webhookClient?.destroy();
    }
}

async function execute(interaction) {
    await interaction.reply(
        ephemeralOptions({
            content: buildMenuContent(),
            components: buildMenuComponents(),
        }),
    );
}

async function handleComponent(
    interaction,
    context,
) {
    const { client, kv } = context;

    if (interaction.isButton()) {
        if (
            interaction.customId ===
            'forumlog_menu_help'
        ) {
            await interaction.reply(
                ephemeralOptions({
                    content: buildHelpContent(),
                }),
            );

            return true;
        }

        if (
            interaction.customId ===
            'forumlog_menu_archive_channel'
        ) {
            await interaction.reply(
                ephemeralOptions({
                    content:
                        'ログ出力元のフォーラム、チャンネル、またはスレッドを選択してください。',
                    components: buildSourceSelectMenu(
                        'forumlog_channel_select_source',
                    ),
                }),
            );

            return true;
        }

        if (
            interaction.customId ===
            'forumlog_menu_archive_webhook'
        ) {
            await interaction.reply(
                ephemeralOptions({
                    content:
                        'ログ出力元のフォーラム、チャンネル、またはスレッドを選択してください。',
                    components: buildSourceSelectMenu(
                        'forumlog_webhook_select_source',
                    ),
                }),
            );

            return true;
        }

        if (
            interaction.customId.startsWith(
                'forumlog_archive_channel:',
            )
        ) {
            const [
                ,
                sourceChannelId,
                targetChannelId,
                includeBotsRaw,
            ] = interaction.customId.split(':');

            const source_channel = await client.channels
                .fetch(sourceChannelId)
                .catch(() => null);

            const target_channel = await client.channels
                .fetch(targetChannelId)
                .catch(() => null);

            if (
                !source_channel ||
                source_channel.guildId !== interaction.guildId
            ) {
                await interaction.update({
                    content:
                        'ログ出力元が見つからないか、このサーバー内のチャンネルではありません。',
                    components: [],
                });

                return true;
            }

            if (
                !target_channel ||
                target_channel.guildId !== interaction.guildId
            ) {
                await interaction.update({
                    content:
                        'ログ保存先が見つからないか、このサーバー内のチャンネルではありません。',
                    components: [],
                });

                return true;
            }

            const includeBots =
                includeBotsRaw === 'true';

            await interaction.update({
                content:
                    `ログ出力の準備を開始します。\n` +
                    `ログ出力元: <#${source_channel.id}>\n` +
                    `ログ送信先: <#${target_channel.id}>\n` +
                    `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
                components: [],
            });

            await archiveSourceLogs(
                interaction,
                {
                    source_channel,
                    target_channel,
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
        if (
            interaction.customId ===
            'forumlog_channel_select_source'
        ) {
            const sourceChannelId =
                interaction.values[0];

            await interaction.update({
                content:
                    `ログ出力元: <#${sourceChannelId}>\n` +
                    'ログ保存先チャンネルまたはスレッドを選択してください。',
                components:
                    buildTargetSelectMenu(
                        sourceChannelId,
                    ),
            });

            return true;
        }

        if (
            interaction.customId.startsWith(
                'forumlog_channel_select_target:',
            )
        ) {
            const sourceChannelId =
                interaction.customId.split(':')[1];

            const targetChannelId =
                interaction.values[0];

            await interaction.update({
                content:
                    `ログ出力元: <#${sourceChannelId}>\n` +
                    `ログ送信先: <#${targetChannelId}>\n` +
                    'Bot投稿を含めますか？',
                components:
                    buildIncludeBotsButtonsForChannel(
                        sourceChannelId,
                        targetChannelId,
                    ),
            });

            return true;
        }

        if (
            interaction.customId ===
            'forumlog_webhook_select_source'
        ) {
            const sourceChannelId =
                interaction.values[0];

            await interaction.showModal(
                buildWebhookArchiveModal(
                    sourceChannelId,
                ),
            );

            return true;
        }

        return false;
    }

    if (interaction.isModalSubmit()) {
        if (
            interaction.customId.startsWith(
                'forumlog_webhook_modal:',
            )
        ) {
            const sourceChannelId =
                interaction.customId.split(':')[1];

            const source_channel = await client.channels
                .fetch(sourceChannelId)
                .catch(() => null);

            if (
                !source_channel ||
                source_channel.guildId !== interaction.guildId
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            'ログ出力元が見つからないか、このサーバー内のチャンネルではありません。',
                    }),
                );

                return true;
            }

            const targetWebhookUrl =
                interaction.fields
                    .getTextInputValue(
                        'target_webhook_url',
                    )
                    .trim();

            const includeBotsRaw =
                interaction.fields
                    .getTextInputValue(
                        'include_bots',
                    )
                    .trim();

            const includeBots =
                parseIncludeBotsInput(
                    includeBotsRaw,
                );

            if (
                !targetWebhookUrl.startsWith(
                    'https://discord.com/api/webhooks/',
                )
            ) {
                await interaction.reply(
                    ephemeralOptions({
                        content:
                            'Webhook URL の形式が正しくありません。',
                    }),
                );

                return true;
            }

            await interaction.deferReply(
                ephemeralOptions(),
            );

            await archiveSourceLogs(
                interaction,
                {
                    source_channel,
                    target_channel: null,
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
