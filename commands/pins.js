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

function normalizeContent(content) {
    const text = content?.trim() || '（本文なし）';

    if (text.length <= 1200) {
        return text;
    }

    return `${text.slice(0, 1200)}\n...（長文のため省略）`;
}

function getThreadLabel(thread) {
    const forumName = thread.parent?.name || '親フォーラム不明';
    return `🧵 ${thread.name}（親: #${forumName}）`;
}

async function fetchForumThreads(forumChannel, member) {
    const threads = new Map();

    if (!canViewChannel(forumChannel, member)) {
        return [];
    }

    // アクティブスレッドを取得
    const active = await forumChannel.threads.fetchActive().catch(() => null);

    if (active?.threads) {
        for (const thread of active.threads.values()) {
            if (canViewChannel(thread, member)) {
                threads.set(thread.id, thread);
            }
        }
    }

    // アーカイブ済み公開スレッドを取得
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

    return [...threads.values()].sort((a, b) => {
        return a.createdTimestamp - b.createdTimestamp;
    });
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();

    if (sub !== 'list') {
        return;
    }

    const forumChannel = interaction.options.getChannel('forum', true);

    if (forumChannel.type !== ChannelType.GuildForum) {
        await interaction.reply(
            ephemeralOptions({
                content: 'forum にはフォーラムチャンネルを指定してください。',
            }),
        );
        return;
    }

    await interaction.deferReply(
        ephemeralOptions(),
    );

    const threads = await fetchForumThreads(
        forumChannel,
        interaction.member,
    );

    if (threads.length === 0) {
        await interaction.editReply({
            content:
                `対象フォーラム <#${forumChannel.id}> 内に、閲覧可能なスレッドは見つかりませんでした。`,
        });
        return;
    }

    const lines = [];
    let totalPins = 0;
    let scannedThreads = 0;

    for (const thread of threads) {
        scannedThreads += 1;

        try {
            if (typeof thread.messages?.fetchPinned !== 'function') {
                continue;
            }

            const pinnedMessages = await thread.messages.fetchPinned();

            if (pinnedMessages.size === 0) {
                continue;
            }

            lines.push('');
            lines.push(`## ${getThreadLabel(thread)}`);
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
                `ピン留め取得失敗: ${thread.name}`,
                error,
            );
        }

        // 取得連打を少し抑える
        await sleep(120);
    }

    if (totalPins === 0) {
        await interaction.editReply({
            content:
                `対象フォーラム <#${forumChannel.id}> 内のスレッドに、ピン留めされたメッセージは見つかりませんでした。\n` +
                `確認対象: ${scannedThreads} スレッド`,
        });
        return;
    }

    const chunks = splitLinesToMessages(
        `📌 フォーラム内ピン留め一覧\n` +
        `対象フォーラム: <#${forumChannel.id}> (${forumChannel.name})\n` +
        `総件数: ${totalPins}件\n` +
        `確認対象: ${scannedThreads} スレッド\n`,
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