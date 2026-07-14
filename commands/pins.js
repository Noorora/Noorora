const {
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');

const { splitLinesToMessages } = require('../utils/messageSplit');
const { ephemeralOptions } = require('../utils/ephemeral');

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

function canViewChannel(channel, member) {
    return channel
        .permissionsFor(member)
        ?.has(PermissionFlagsBits.ViewChannel);
}

function isPinnedReadableChannel(channel) {
    return (
        channel.type === ChannelType.GuildText ||
        channel.type === ChannelType.GuildAnnouncement ||
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread ||
        channel.type === ChannelType.AnnouncementThread
    );
}

function isForumChannel(channel) {
    return channel.type === ChannelType.GuildForum;
}

function getChannelSortValue(channel) {
    if (channel.isThread?.()) {
        return channel.parent?.position ?? 999999;
    }

    return channel.position ?? 999999;
}

function getChannelLabel(channel) {
    if (channel.isThread?.()) {
        const parentName = channel.parent?.name || '親チャンネル不明';
        return `🧵 ${channel.name}（親: #${parentName}）`;
    }

    return `#${channel.name}`;
}

function normalizeContent(content) {
    const text = content?.trim() || '（本文なし）';

    if (text.length <= 1200) {
        return text;
    }

    return `${text.slice(0, 1200)}\n...（長文のため省略）`;
}

async function fetchArchivedThreadsFromForum(forumChannel, member) {
    const threads = new Map();

    if (!canViewChannel(forumChannel, member)) {
        return threads;
    }

    // アクティブスレッド
    const active = await forumChannel.threads.fetchActive().catch(() => null);

    if (active?.threads) {
        for (const thread of active.threads.values()) {
            if (canViewChannel(thread, member)) {
                threads.set(thread.id, thread);
            }
        }
    }

    // アーカイブ済み公開スレッド
    let before;

    while (true) {
        const options = {
            type: 'public',
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const archived = await forumChannel.threads.fetchArchived(options).catch(() => null);

        if (!archived?.threads || archived.threads.size === 0) {
            break;
        }

        for (const thread of archived.threads.values()) {
            if (canViewChannel(thread, member)) {
                threads.set(thread.id, thread);
            }
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

        await sleep(300);
    }

    return threads;
}

async function getTargetChannelsAndThreads(guild, member) {
    const targets = new Map();

    // 通常チャンネルとキャッシュ上のアクティブスレッド
    for (const channel of guild.channels.cache.values()) {
        if (!isPinnedReadableChannel(channel)) {
            continue;
        }

        if (!canViewChannel(channel, member)) {
            continue;
        }

        if (typeof channel.messages?.fetchPinned !== 'function') {
            continue;
        }

        targets.set(channel.id, channel);
    }

    // フォーラム内のアクティブスレッド + アーカイブ済みスレッド
    const forumChannels = guild.channels.cache.filter((channel) => {
        return isForumChannel(channel) && canViewChannel(channel, member);
    });

    for (const forumChannel of forumChannels.values()) {
        const forumThreads = await fetchArchivedThreadsFromForum(forumChannel, member);

        for (const thread of forumThreads.values()) {
            if (typeof thread.messages?.fetchPinned !== 'function') {
                continue;
            }

            targets.set(thread.id, thread);
        }
    }

    return [...targets.values()].sort((a, b) => {
        const positionDiff = getChannelSortValue(a) - getChannelSortValue(b);

        if (positionDiff !== 0) {
            return positionDiff;
        }

        return String(a.name).localeCompare(String(b.name), 'ja');
    });
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub !== 'list') {
        return;
    }

    await interaction.deferReply(
        ephemeralOptions(),
    );

    const channels = await getTargetChannelsAndThreads(
        interaction.guild,
        interaction.member,
    );

    const lines = [];
    let totalPins = 0;
    let scannedChannels = 0;

    for (const channel of channels) {
        scannedChannels += 1;

        try {
            const pinnedMessages = await channel.messages.fetchPinned();

            if (pinnedMessages.size === 0) {
                continue;
            }

            lines.push('');
            lines.push(`## ${getChannelLabel(channel)}`);
            lines.push('');

            const sortedMessages = [...pinnedMessages.values()].sort((a, b) => {
                return a.createdTimestamp - b.createdTimestamp;
            });

            for (const message of sortedMessages) {
                totalPins += 1;

                lines.push(`【${totalPins}件目】`);
                lines.push(`投稿者: ${message.author.tag}`);
                lines.push(`日時: ${formatDateTime(message.createdTimestamp)}`);
                lines.push('内容:');
                lines.push(normalizeContent(message.content));

                if (message.attachments.size > 0) {
                    lines.push('');

                    for (const attachment of message.attachments.values()) {
                        lines.push(`添付: ${attachment.url}`);
                    }
                }

                lines.push('');
                lines.push(`リンク: ${message.url}`);
                lines.push('--------------------------------------------------');
                lines.push('');
            }
        } catch (error) {
            console.warn(
                `ピン留め取得失敗: ${channel.name}`,
                error,
            );
        }

        // 取得連打を少し抑える
        await sleep(120);
    }

    if (totalPins === 0) {
        await interaction.editReply({
            content:
                `閲覧可能なチャンネル・スレッドにピン留めされたメッセージは見つかりませんでした。\n` +
                `確認対象: ${scannedChannels} チャンネル/スレッド`,
        });

        return;
    }

    const chunks = splitLinesToMessages(
        `📌 サーバー内ピン留め一覧\n` +
        `総件数: ${totalPins}件\n` +
        `確認対象: ${scannedChannels} チャンネル/スレッド\n`,
        lines,
    );

    await interaction.editReply({
        content: chunks[0],
    });

    for (let i = 1; i < chunks.length; i++) {
        await interaction.followUp(
            ephemeralOptions({
                content: chunks[i],
            }),
        );
    }
}

module.exports = {
    name: 'pins',
    execute,
};