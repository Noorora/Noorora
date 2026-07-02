const { ChannelType } = require('discord.js');
const { ephemeralOptions } = require('../utils/ephemeral');

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
            if (current) chunks.push(current);
            current = line.length > maxLength ? line.slice(0, maxLength) : line;
        } else {
            current = next;
        }
    }

    if (current.trim()) chunks.push(current);
    return chunks;
}

async function sendLogMessage(targetChannel, text) {
    const chunks = splitText(text);
    for (const chunk of chunks) {
        await targetChannel.send({
            content: chunk,
            allowedMentions: {
                parse: [],
            },
        });
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
        if (before) options.before = before;

        const archived = await forumChannel.threads.fetchArchived(options).catch(() => null);
        if (!archived?.threads || archived.threads.size === 0) break;

        for (const thread of archived.threads.values()) {
            threads.set(thread.id, thread);
        }

        const sortedThreads = [...archived.threads.values()].sort((a, b) => {
            const aTime = a.archiveTimestamp || a.createdTimestamp || 0;
            const bTime = b.archiveTimestamp || b.createdTimestamp || 0;
            return aTime - bTime;
        });
        const oldestThread = sortedThreads[0];
        if (!oldestThread) break;

        before = oldestThread.archiveTimestamp
            ? new Date(oldestThread.archiveTimestamp)
            : oldestThread.id;

        if (archived.threads.size < 100 || archived.hasMore === false) break;
        await sleep(500);
    }

    return [...threads.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function fetchAllMessagesFromThread(thread, includeBots) {
    const messages = [];
    let before;

    while (true) {
        const options = { limit: 100 };
        if (before) options.before = before;

        const batch = await thread.messages.fetch(options).catch(() => null);
        if (!batch || batch.size === 0) break;

        for (const message of batch.values()) {
            if (!includeBots && message.author.bot) continue;
            messages.push(message);
        }

        const lastMessage = batch.last();
        if (!lastMessage) break;
        before = lastMessage.id;

        if (batch.size < 100) break;
        await sleep(350);
    }

    return messages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

function buildMessageLog(thread, message) {
    const authorLabel = `${message.author.tag || message.author.username} (<@${message.author.id}>)`;
    const content = message.content?.trim() || '（本文なし）';
    const attachments = message.attachments.size > 0
        ? [...message.attachments.values()].map((attachment) => `添付: ${attachment.url}`).join('\n')
        : '';

    return [
        `**[${formatDateTime(message.createdTimestamp)}] ${authorLabel}**`,
        `スレッド: ${thread.name}`,
        content,
        attachments,
        `リンク: ${message.url}`,
    ].filter(Boolean).join('\n');
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'archive') return;

    const forumChannel = interaction.options.getChannel('forum', true);
    const targetChannel = interaction.options.getChannel('target_channel', true);
    const includeBots = interaction.options.getBoolean('include_bots') ?? false;

    if (forumChannel.type !== ChannelType.GuildForum) {
        await interaction.reply(ephemeralOptions({ content: 'forum にはフォーラムチャンネルを指定してください。' }));
        return;
    }

    if (!allowedTargetTypes.includes(targetChannel.type) || typeof targetChannel.send !== 'function') {
        await interaction.reply(ephemeralOptions({ content: 'target_channel にはテキストチャンネルまたはスレッドを指定してください。' }));
        return;
    }

    await interaction.deferReply(ephemeralOptions());

    const startedAt = Date.now();
    const threads = await fetchAllForumThreads(forumChannel);

    await interaction.editReply({
        content:
            `フォーラムログの出力を開始します。\n` +
            `対象フォーラム: <#${forumChannel.id}>\n` +
            `ログ送信先: <#${targetChannel.id}>\n` +
            `取得したスレッド数: ${threads.length}\n` +
            `Bot投稿を含める: ${includeBots ? 'はい' : 'いいえ'}`,
    });

    await sendLogMessage(
        targetChannel,
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
        const messages = await fetchAllMessagesFromThread(thread, includeBots);
        totalMessages += messages.length;

        await sendLogMessage(
            targetChannel,
            [
                `---`,
                `## スレッド: ${thread.name}`,
                `スレッド: <#${thread.id}>`,
                `作成日時: ${formatDateTime(thread.createdTimestamp)}`,
                `メッセージ数: ${messages.length}`,
                `URL: https://discord.com/channels/${thread.guildId}/${thread.id}`,
            ].join('\n'),
        );

        if (messages.length === 0) {
            await sendLogMessage(targetChannel, '（保存対象メッセージなし）');
        } else {
            for (const message of messages) {
                await sendLogMessage(targetChannel, buildMessageLog(thread, message));
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
        [
            '## フォーラム過去ログ出力完了',
            `対象フォーラム: <#${forumChannel.id}> (${forumChannel.name})`,
            `処理スレッド数: ${processedThreads}`,
            `出力メッセージ数: ${totalMessages}`,
            `完了時刻: ${formatDateTime(finishedAt)}`,
            `処理時間: ${Math.round((finishedAt - startedAt) / 1000)}秒`,
        ].join('\n'),
    );

    await interaction.editReply({
        content:
            `フォーラムログの出力が完了しました。\n` +
            `対象フォーラム: <#${forumChannel.id}>\n` +
            `処理スレッド数: ${processedThreads}\n` +
            `出力メッセージ数: ${totalMessages}\n` +
            `ログ送信先: <#${targetChannel.id}>`,
    });
}

module.exports = {
    name: 'forumlog',
    execute,
};
