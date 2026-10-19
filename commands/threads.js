const {
    ChannelType,
    PermissionFlagsBits,
} = require('discord.js');

const {
    ephemeralOptions,
} = require('../utils/ephemeral');

const {
    splitLinesToMessages,
} = require('../utils/messageSplit');

const THREAD_PARENT_TYPES = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
];

if (
    typeof ChannelType.GuildMedia !==
    'undefined'
) {
    THREAD_PARENT_TYPES.push(
        ChannelType.GuildMedia,
    );
}

function threadTimestamp(thread) {
    return (
        thread.lastMessage?.createdTimestamp ||
        thread.archiveTimestamp ||
        thread.createdTimestamp ||
        0
    );
}

function sortThreadsNewestFirst(threads) {
    return [...threads].sort((left, right) => {
        return (
            threadTimestamp(right) -
            threadTimestamp(left)
        );
    });
}

function buildThreadUrl(thread) {
    return (
        `https://discord.com/channels/` +
        `${thread.guildId}/${thread.id}`
    );
}

function buildThreadLine(thread, index) {
    const parentMention = thread.parentId
        ? `<#${thread.parentId}>`
        : '親チャンネル不明';

    const state = thread.archived
        ? 'アーカイブ済み'
        : 'アクティブ';

    return [
        `${index}. **${thread.name}**`,
        `   親: ${parentMention}`,
        `   状態: ${state}`,
        `   リンク: ${buildThreadUrl(thread)}`,
    ];
}

async function fetchArchivedThreads(
    parent_channel,
    type,
) {
    const collected = new Map();
    let before;

    while (true) {
        const options = {
            type,
            limit: 100,
        };

        if (before) {
            options.before = before;
        }

        const result = await parent_channel.threads
            .fetchArchived(options)
            .catch(() => null);

        if (
            !result ||
            result.threads.size === 0
        ) {
            break;
        }

        for (
            const thread of
            result.threads.values()
        ) {
            collected.set(
                thread.id,
                thread,
            );
        }

        const oldestThread = [
            ...result.threads.values(),
        ].sort((left, right) => {
            const leftTime =
                left.archiveTimestamp || 0;

            const rightTime =
                right.archiveTimestamp || 0;

            return leftTime - rightTime;
        })[0];

        if (
            !oldestThread ||
            result.threads.size < 100 ||
            result.hasMore === false
        ) {
            break;
        }

        before = oldestThread.archiveTimestamp
            ? new Date(
                oldestThread.archiveTimestamp,
            )
            : oldestThread.id;
    }

    return collected;
}

async function collectAccessibleThreads(
    interaction,
) {
    const guild = interaction.guild;
    const threads = new Map();

    const activeResult = await guild.channels
        .fetchActiveThreads()
        .catch(() => null);

    if (activeResult?.threads) {
        for (
            const thread of
            activeResult.threads.values()
        ) {
            threads.set(thread.id, thread);
        }
    }

    const channels = await guild.channels.fetch();

    for (const parent_channel of channels.values()) {
        if (
            !parent_channel ||
            !THREAD_PARENT_TYPES.includes(
                parent_channel.type,
            ) ||
            !parent_channel.threads
        ) {
            continue;
        }

        const publicArchived =
            await fetchArchivedThreads(
                parent_channel,
                'public',
            );

        for (
            const thread of
            publicArchived.values()
        ) {
            threads.set(thread.id, thread);
        }

        const member =
            interaction.member;

        const canSeePrivate =
            member?.permissionsIn(
                parent_channel,
            )?.has(
                PermissionFlagsBits
                    .ManageThreads,
            ) || false;

        if (!canSeePrivate) {
            continue;
        }

        const privateArchived =
            await fetchArchivedThreads(
                parent_channel,
                'private',
            );

        for (
            const thread of
            privateArchived.values()
        ) {
            threads.set(thread.id, thread);
        }
    }

    return sortThreadsNewestFirst(
        threads.values(),
    );
}

async function userIsThreadMember(
    thread,
    userId,
) {
    const cachedMember =
        thread.members.cache.get(userId);

    if (cachedMember) {
        return true;
    }

    const fetchedMember =
        await thread.members
            .fetch({
                member: userId,
                force: true,
            })
            .catch(() => null);

    return Boolean(fetchedMember);
}

async function classifyThreads(
    interaction,
    threads,
) {
    const joined = [];
    const notJoined = [];
    const unknown = [];

    for (const thread of threads) {
        try {
            const isMember =
                await userIsThreadMember(
                    thread,
                    interaction.user.id,
                );

            if (isMember) {
                joined.push(thread);
            } else {
                notJoined.push(thread);
            }
        } catch (error) {
            console.error(
                '[threads] ' +
                'スレッド参加状態取得エラー:',
                {
                    threadId: thread.id,
                    userId: interaction.user.id,
                    error,
                },
            );

            unknown.push(thread);
        }
    }

    return {
        joined,
        notJoined,
        unknown,
    };
}

function buildResultLines(result) {
    const lines = [
        '# スレッド参加状況',
        '',
        '「参加中」は、Discord上であなたがスレッドメンバーとして登録されている状態です。',
        '',
        `## 参加中のスレッド (${result.joined.length}件)`,
        '',
    ];

    if (result.joined.length === 0) {
        lines.push('該当するスレッドはありません。');
    } else {
        result.joined.forEach(
            (thread, index) => {
                lines.push(
                    ...buildThreadLine(
                        thread,
                        index + 1,
                    ),
                    '',
                );
            },
        );
    }

    lines.push(
        '',
        `## 未参加のスレッド (${result.notJoined.length}件)`,
        '',
    );

    if (result.notJoined.length === 0) {
        lines.push('該当するスレッドはありません。');
    } else {
        result.notJoined.forEach(
            (thread, index) => {
                lines.push(
                    ...buildThreadLine(
                        thread,
                        index + 1,
                    ),
                    '',
                );
            },
        );
    }

    if (result.unknown.length > 0) {
        lines.push(
            '',
            `## 判定できなかったスレッド (${result.unknown.length}件)`,
            '',
        );

        result.unknown.forEach(
            (thread, index) => {
                lines.push(
                    ...buildThreadLine(
                        thread,
                        index + 1,
                    ),
                    '',
                );
            },
        );
    }

    lines.push(
        '',
        '※ Botが閲覧できない非公開スレッドは一覧に含まれません。',
    );

    return lines;
}

async function execute(interaction) {
    await interaction.deferReply(
        ephemeralOptions(),
    );

    try {
        const threads =
            await collectAccessibleThreads(
                interaction,
            );

        const result =
            await classifyThreads(
                interaction,
                threads,
            );

        const chunks = splitLinesToMessages(
            '',
            buildResultLines(result),
        );

        await interaction.editReply({
            content: chunks[0],
        });

        for (
            let index = 1;
            index < chunks.length;
            index++
        ) {
            await interaction.followUp(
                ephemeralOptions({
                    content: chunks[index],
                }),
            );
        }
    } catch (error) {
        console.error(
            'スレッド参加状況の取得エラー:',
            error,
        );

        await interaction.editReply({
            content:
                'スレッド一覧の取得に失敗しました。Botの権限と起動ログを確認してください。',
        });
    }
}

module.exports = {
    name: 'threads',
    execute,
};
